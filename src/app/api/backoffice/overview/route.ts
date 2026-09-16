import { NextResponse } from "next/server";

import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { listBackofficeOverviewFromServer } from "@/lib/backoffice-server";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";

/**
 * 後台總覽（門店 / 帳號 / 權限組 / 同步任務）。
 *
 * 🔴 2026-09-16 資安加固：以前**完全冇鑑權**。2026-09-16 實測
 * （`tools/audit-anon-endpoints.cjs`）匿名一次 GET 就抽到 **3.2 KB、全部店舖清單
 * （`id` + 名稱）＋帳號／權限組** ⇒ 等於**免費列舉所有 storeId**，
 * 再用嗰啲 storeId 去打其他端點（縱深攻擊第一步）。收閘。
 *
 * 口徑：**admin session 或 POS 終端憑證**（`/backoffice` 由 `AuthGuard allowedRoles:["admin"]`
 * 保護，但商戶用 POS 帳號登入時唔一定有 `adminSessionToken`，所以兩者都收）。
 * 端點冇 storeId 參數（本質係跨店視圖），所以唔做綁店檢查。
 */
export async function GET(request: Request) {
  const allowed =
    !isPosDeviceAuthRequired() ||
    Boolean(readAdminSessionFromRequest(request)) ||
    Boolean(readPosDeviceTokenFromRequest(request));
  if (!allowed) {
    console.warn("[backoffice/overview] 拒絕未授權存取");
    return NextResponse.json(
      { ok: false, error: "未經授權：需要登入後台或 POS 終端憑證。" },
      { status: 401 },
    );
  }

  const result = await listBackofficeOverviewFromServer();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  return NextResponse.json(result);
}
