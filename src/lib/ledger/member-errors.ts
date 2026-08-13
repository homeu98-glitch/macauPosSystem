/** 將 Ledger RPC 錯誤映射為店員可讀中文（§5.6–5.7）。 */
export function friendlyLedgerMemberError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid phone")) return "電話須為 8 位數字。";
  if (lower.includes("not authorized")) return "無本店操作權限，請重新登入。";
  if (lower.includes("merchant suspended")) return "商家已停用，無法操作會員。";
  if (lower.includes("customer not registered")) return "此電話尚未註冊會員通，請顧客先登入會員通或聯絡店主。";
  if (lower.includes("insufficient balance")) return "會員餘額不足（含所選現金券）。";
  if (lower.includes("idempotency key required")) return "系統錯誤：缺少冪等 key，請重試。";
  if (lower.includes("ledger 登入已過期") || lower.includes("jwt")) return "Ledger 登入已過期，請重新登入。";
  return message || "會員操作失敗，請稍後再試。";
}
