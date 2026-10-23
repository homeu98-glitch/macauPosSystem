import { NextResponse } from "next/server";

import { verifyBoundDeviceByDeviceId } from "@/lib/pos/device-binding-server";
import { listPosStaff } from "@/lib/pos/staff-server";
import { normalizeStoreAccount, resolveStoreAccount } from "@/lib/pos/store-account-server";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * `POST /api/pos/login/identities` —— 登入第 2 步：列出呢間店可用嘅身份。
 *
 * ## 兩種模式（docs/161）
 *
 * | 模式 | 請求 | 幾時用 |
 * |---|---|---|
 * | **裝置模式** | `{ deviceId, deviceSecret }` | 呢部機已由店主初始化 ⇒ **唔使打 8 位帳號** |
 * | 帳號模式 | `{ account }` | 未初始化（新機／撤銷過）⇒ 店主打帳號，查返 storeId |
 *
 * 裝置模式係 2026-10-23 加嘅：店員根本唔知店舖 8 位帳號，逼佢打係為難人；
 * 而部機本身已經有 `storeId`（喺 `pos_bound_devices`），問嚟做咩。
 *
 * ## 回傳
 *
 * `{ known, storeId, storeName, identities, staffTotal, staffActive, staffTableMissing }`
 *
 * · `known:false` = 呢個帳號未有任何店主登入過（未跑 0074 / 新店）
 *   ⇒ client 直接跳去傳統「帳號 + PIN」登入，唔會卡住。
 * · 後三個數字係**診斷用**：清單得店主一個嘅時候，UI 要講得出係邊種原因
 *   （未初始化 / 未加店員 / 全部停用），否則三種情況喺畫面上一模一樣。
 *
 * ## 安全（要老實講）
 *
 * 呢條 route **未登入就用得**，等於「知道 8 位店舖帳號（或拿到裝置 secret）
 * ⇒ 睇得到店員姓名」。緩解：
 *   ① per-IP 10 次／分鐘；
 *   ② 只回姓名／工號／角色，**永不**回 PIN、hash、權限明細；
 *   ③ 只回 `active` 員工（離職者唔會出現）；
 *   ④ 裝置模式仍然要對中 32 bytes 隨機 secret。
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

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function bad(error: string, status: number, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
}

export async function POST(request: Request) {
  if (!rateLimit(`pos-login-identities:${clientIp(request)}`, 10, 60_000)) {
    return bad("嘗試過於頻繁，請一分鐘後再試。", 429, "rate_limited");
  }

  const body = (await request.json().catch(() => null)) as {
    account?: string;
    deviceId?: string;
    deviceSecret?: string;
  } | null;

  const deviceId = String(body?.deviceId ?? "").trim();
  const deviceSecret = String(body?.deviceSecret ?? "").trim();
  const useDevice = DEVICE_ID_PATTERN.test(deviceId) && Boolean(deviceSecret);

  let storeId = "";
  let storeName = "";
  let known = true;

  if (useDevice) {
    const verified = await verifyBoundDeviceByDeviceId(deviceId, deviceSecret);
    if (!verified.ok) {
      return bad(
        verified.error,
        verified.status,
        verified.tableMissing ? "table_missing" : "device_not_ready",
        { tableReady: verified.tableMissing ? false : undefined },
      );
    }
    storeId = verified.device.storeId;
    // 店名只作顯示：由店主帳號反查（POS 本地表，唔使打 Ledger）
    const resolved = await resolveStoreAccount(verified.device.account);
    storeName = resolved?.storeName ?? "";
  } else {
    const account = normalizeStoreAccount(body?.account);
    if (!account) return bad("請輸入 8 位數字帳號。", 400, "account_invalid");

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
    storeId = resolved.storeId;
    storeName = resolved.storeName;
    known = true;
  }

  const identities: LoginIdentity[] = [
    { kind: "owner", id: "owner", name: "店主", role: "owner" },
  ];

  const staffResult = await listPosStaff(storeId);
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
    known,
    deviceMode: useDevice,
    storeId,
    storeName,
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
