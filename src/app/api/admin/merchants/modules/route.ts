import { NextResponse } from "next/server";

import { requireAdmin, storeFilterOrDeny } from "@/lib/admin-guard.server";
import {
  defaultMerchantGrants,
  normalizeMerchantGrants,
} from "@/lib/pos/module-catalog";
import {
  loadMerchantGrantsMap,
  saveMerchantGrants,
} from "@/lib/pos/merchant-modules-server";

/**
 * `/api/admin/merchants/modules` —— Admin panel「商戶模組授權」讀寫。
 *
 *   GET   ?merchantId=<ledger merchant uuid>   讀單店授權（+ 有冇明確設定過）
 *   PATCH { merchantId, workbenches[], sidebarModules[] }  寫入
 *
 * 把關：admin session token（`/admin` 登入換返嚟嗰張 12h HMAC token），
 * 同 `/api/admin/merchants` 一致。
 *
 * ## ⚠️ `configured` 呢個 flag 唔可以省
 *
 * 「DB 冇記錄」同「Admin 明確全部閂」係**兩件唔同嘅事**：
 *   - 冇記錄 → 全部開通（向後兼容，見 merchant-modules-server.ts 的不變量）
 *   - 明確全部閂 → 一頁空白（唔會有商戶想咁，但係合法狀態）
 *
 * 兩者回傳嘅 `grants` 都係合法值，UI 靠 `configured` 去講清楚
 * 「呢間店未設定過，而家係跟預設全開」，否則管理員會以為自己已經設過。
 */
export async function GET(request: Request) {
  // 讀：任何 admin 帳號都可以讀**自己 scope 內**嘅店（店主睇得到自己開通咗咩模組）。
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.res;

  const merchantId = new URL(request.url).searchParams.get("merchantId")?.trim();
  if (!merchantId) {
    return NextResponse.json({ ok: false, error: "缺少 merchantId。" }, { status: 400 });
  }

  const filter = storeFilterOrDeny(guard.scope, merchantId, request);
  if (!filter.ok) return filter.res;

  const map = await loadMerchantGrantsMap([merchantId]);
  const explicit = map.get(merchantId);

  return NextResponse.json({
    ok: true,
    merchantId,
    configured: Boolean(explicit),
    grants: explicit ?? defaultMerchantGrants(),
  });
}

export async function PATCH(request: Request) {
  // 🔴 D4（2026-10-21 拍板）：「模組開關」只有平台可以改。
  // 店主可以睇自己店開通咗咩，但唔可以自己開／關 —— 呢個係商業授權，唔係店舖設定。
  const guard = await requireAdmin(request, { platform: true });
  if (!guard.ok) return guard.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    merchantId?: unknown;
    workbenches?: unknown;
    sidebarModules?: unknown;
  };
  const merchantId = String(payload.merchantId ?? "").trim();
  if (!merchantId) {
    return NextResponse.json({ ok: false, error: "缺少 merchantId。" }, { status: 400 });
  }

  // ⚠️ 一定要**兩組一齊**送：saveMerchantGrants 會用呢兩個值覆寫整行。
  // 只送一組 = 另一組被靜靜清空。
  const result = await saveMerchantGrants(merchantId, {
    workbenches: payload.workbenches,
    sidebarModules: payload.sidebarModules,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    merchantId,
    configured: true,
    grants: normalizeMerchantGrants({
      workbenches: payload.workbenches,
      sidebarModules: payload.sidebarModules,
    }),
  });
}
