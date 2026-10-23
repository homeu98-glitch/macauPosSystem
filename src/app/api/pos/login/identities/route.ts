import { NextResponse } from "next/server";

import { listPosStaff } from "@/lib/pos/staff-server";
import { normalizeStoreAccount, resolveStoreAccount } from "@/lib/pos/store-account-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `POST /api/pos/login/identities` —— 登入第 2 步：用店舖帳號列出可用身份。
 *
 * 回傳 `{ known, storeId, storeName, identities }`：
 *   · `known:false` = 呢個帳號未有任何店主登入過（未跑 0074 / 新店）
 *     ⇒ client 直接跳去傳統「帳號 + PIN」登入，唔會卡住。
 *   · `known:true` = 店主 ＋ 已啟用店員（工號／姓名／角色）。
 *
 * ## 安全（要老實講）
 *
 * 呢條 route **未登入就用得**，等於「知道 8 位店舖帳號 ⇒ 睇得到店員姓名」。
 * 緩解：
 *   ① per-IP 10 次／分鐘（掃 1 萬個號碼要好幾個鐘，而且冇 PIN 一樣入唔到）；
 *   ② 只回姓名／工號／角色，**永不**回 PIN、hash、權限明細；
 *   ③ 只回 `active` 員工（離職者唔會出現）。
 * 如果商家介意，可以改成只回工號（見 docs/160 §11.4）。
 *
 * ## 為何唔可以由 Ledger 查
 *
 * Ledger 契約明文冇 `check_phone` 類 RPC，亦禁止打 Ledger Web 登入頁。
 * ⇒ 用 POS 自己嘅 `pos_store_accounts`（店主登入時寫入）。
 */

type LoginIdentity =
  | { kind: "owner"; id: "owner"; name: string; role: "owner" }
  | { kind: "staff"; id: string; staffNo: string; name: string; role: "manager" | "cashier" };

export async function POST(request: Request) {
  if (!rateLimit(`pos-login-identities:${clientIp(request)}`, 10, 60_000)) {
    return NextResponse.json(
      { ok: false, error: "嘗試過於頻繁，請一分鐘後再試。", code: "rate_limited" },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { account?: string } | null;
  const account = normalizeStoreAccount(body?.account);
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "請輸入 8 位數字帳號。", code: "account_invalid" },
      { status: 400 },
    );
  }

  const resolved = await resolveStoreAccount(account);
  if (!resolved) {
    // 未有任何店主登入過：client 走傳統流程（帳號 + PIN）
    return NextResponse.json({
      ok: true,
      known: false,
      identities: [{ kind: "owner", id: "owner", name: "店主", role: "owner" }],
      staffTotal: 0,
      staffActive: 0,
      staffTableMissing: false,
    });
  }

  const identities: LoginIdentity[] = [
    { kind: "owner", id: "owner", name: "店主", role: "owner" },
  ];

  const staffResult = await listPosStaff(resolved.storeId);
  let staffTotal = 0;
  let staffActive = 0;
  if (staffResult.ok) {
    staffTotal = staffResult.staff.length;
    for (const item of staffResult.staff) {
      if (!item.active) continue;
      staffActive += 1;
      if (identities.length >= 61) break; // 一間店最多 40 人，留返緩衝
      identities.push({
        kind: "staff",
        id: item.id,
        staffNo: item.staffNo,
        name: item.name,
        role: item.role,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    known: true,
    storeId: resolved.storeId,
    storeName: resolved.storeName,
    identities,
    // 診斷用：client 靠呢三個數字講清楚「點解得店主一個」——
    //   ① staffTableMissing → 0072 未跑
    //   ② staffTotal === 0  → 真係未加店員
    //   ③ staffTotal > 0 但 staffActive === 0 → 店員全部停用
    // 冇呢三個數，三種情況喺 UI 上長得一模一樣，淨係見到「店主 · 切換」。
    staffTotal,
    staffActive,
    staffTableMissing: staffResult.ok ? false : staffResult.tableMissing === true,
  });
}
