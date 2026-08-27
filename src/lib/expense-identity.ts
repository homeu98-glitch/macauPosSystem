import "server-only";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

/**
 * 登入時確保 expenseRecorder 專案（fjvfvpedklhdenavbcjg）存在對應的 shop_users 列，
 * 使後續 inventory 讀寫能以 merchantId 正確歸屬（對應 INTEGRATION_PLAN.md §5.3）。
 *
 * 對應鍵：shop_users.external_shop_id = Ledger merchantId（穩定 UUID）。
 *
 * 沿用 expenseRecorder /api/auth/sso-login 的既有約定（避免與其 SSO 互相覆寫憑證）：
 * - 既有列 → 保留 login_id / login_pin，只更新 shop_name / auth_source / profile_json / last_login_at。
 * - 新列 → 生成隨機 4 位 login_pin（因 POS 登入不持有明文 PIN），login_id 取 8 位電話。
 *
 * 失敗「不阻斷」POS 登入：inventory 可分頁降級顯示「未連線」，登入本身照常成功。
 */

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function pickLoginId({ phone, shopId }: { phone: string; shopId: string }): string {
  if (/^\d{8}$/.test(phone)) return phone;
  if (/^\d{8}$/.test(shopId)) return shopId;
  const hash = Buffer.from(shopId).toString("base64url").replace(/[^0-9]/g, "");
  return hash.padEnd(8, "0").slice(0, 8) || "00000000";
}

export type EnsureExpenseShopUserResult = { ok: boolean; reason?: string };

export async function ensureExpenseShopUser(params: {
  merchantId: string;
  phone: string;
  shopName?: string | null;
}): Promise<EnsureExpenseShopUserResult> {
  const { merchantId, phone, shopName } = params;
  const client = getExpenseSupabaseClient();
  if (!client) {
    return { ok: false, reason: "expense client 未設定（EXPENSE_SUPABASE_* 環境變數缺失）" };
  }
  if (!merchantId) {
    return { ok: false, reason: "缺少 merchantId" };
  }

  try {
    const { data: existing, error: findError } = await client
      .from("shop_users")
      .select("id, login_id, login_pin")
      .eq("external_shop_id", merchantId)
      .maybeSingle();

    if (findError) {
      return { ok: false, reason: `查詢 shop_users 失敗：${findError.message}` };
    }

    const loginId = pickLoginId({ phone, shopId: merchantId });
    const now = new Date().toISOString();

    if (existing) {
      const patch: Record<string, unknown> = {
        auth_source: "pos",
        profile_json: { owner: { phone: phone || null, displayName: shopName ?? null } },
        last_login_at: now,
      };
      // 只補齊缺失欄位，絕不覆寫既有 login_id / login_pin（與 SSO 互不干擾）
      if (shopName) patch.shop_name = shopName;
      if (!existing.login_id) patch.login_id = loginId;

      const { error: updErr } = await client
        .from("shop_users")
        .update(patch)
        .eq("id", existing.id);
      if (updErr) return { ok: false, reason: `更新 shop_users 失敗：${updErr.message}` };
      return { ok: true };
    }

    const { error: insErr } = await client.from("shop_users").insert({
      shop_name: shopName ?? `店舖 ${phone.slice(-4)}`,
      login_id: loginId,
      login_pin: randomPin(),
      external_shop_id: merchantId,
      auth_source: "pos",
      profile_json: { owner: { phone: phone || null, displayName: shopName ?? null } },
      last_login_at: now,
    });
    if (insErr) return { ok: false, reason: `新增 shop_users 失敗：${insErr.message}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
