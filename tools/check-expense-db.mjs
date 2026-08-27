// 本地直連測試：驗證 POS 能否以 service_role 讀取 expenseRecorder 專案。
// 用法：
//   cd macauPosSystem
//   npx vercel env pull .env.local        # 把 Vercel 的 env 拉到本地（需已登入 Vercel）
//   node --env-file=.env.local tools/check-expense-db.mjs
// 或直接在本機 .env.local 已有 EXPENSE_SUPABASE_* 時執行。

import { createClient } from "@supabase/supabase-js";

const url = process.env.EXPENSE_SUPABASE_URL;
const key = process.env.EXPENSE_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("❌ EXPENSE_SUPABASE_URL / EXPENSE_SUPABASE_SERVICE_ROLE_KEY 未設定");
  console.error("   請先執行: npx vercel env pull .env.local");
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false } });

try {
  const { count, error } = await client
    .from("shop_users")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("❌ 連線失敗:", error.message);
    process.exit(1);
  }

  console.log("✅ expenseRecorder 專案直連成功");
  console.log("   shop_users 筆數:", count ?? 0);

  const r = await client.from("receipts").select("*", { count: "exact", head: true });
  console.log("   receipts 筆數:", r.count ?? 0, r.error ? `(error: ${r.error.message})` : "");
} catch (e) {
  console.error("❌ 例外:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
