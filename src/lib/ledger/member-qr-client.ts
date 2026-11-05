/**
 * 掃碼字串嘅分類／解析（支付頁同會員頁共用真源）。
 *
 * 2026-11-05：一個掃碼掣認兩類碼，但**格式互斥**，所以可以先用形狀預篩、
 * 再對會員碼做 server 驗章，等同 Ledger Web `handleScanResult()` 嘅
 *「先試會員碼、唔係就當券碼」順序探測，但少打一次無謂請求：
 *
 *  - `rc_` + 32 hex  → 優惠券 `redemption_code`（`redeem_reward`）
 *  - `gb_…`          → 團購券（另一條 RPC，未入契約白名單 ⇒ 明確唔支援，唔靜默試）
 *  - 40–80 位 base64url → 會員碼候選 → POST `/api/ledger/member-qr/verify`
 *  - 其他            → 無法辨識
 *
 * 🔴 會員碼 ≈55 字、券碼 35 字，兩者唔會撞；`rc_` 開頭嘅偽造碼會被
 *    `redeem_reward` 以 "coupon not found" 擋低（fail-closed），唔會寫入。
 */

export const REWARD_COUPON_CODE_PATTERN = /^rc_[0-9a-f]{32}$/i;
export const GROUP_BUY_CODE_PATTERN = /^gb_[A-Za-z0-9_-]+$/i;
const MEMBER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,80}$/;

export type ScannedCodeKind = "memberCandidate" | "rewardCoupon" | "groupBuy" | "unrecognized";

export function classifyScannedCode(raw: string): ScannedCodeKind {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 128) return "unrecognized";
  if (REWARD_COUPON_CODE_PATTERN.test(value)) return "rewardCoupon";
  if (GROUP_BUY_CODE_PATTERN.test(value)) return "groupBuy";
  if (MEMBER_TOKEN_PATTERN.test(value)) return "memberCandidate";
  return "unrecognized";
}

/** 彈窗顯示用：唔好用全碼霸成行，亦避免旁人影到成個 QR 內容。 */
export function maskCouponCode(code: string): string {
  const value = String(code ?? "").trim();
  return value.length <= 10 ? value : `${value.slice(0, 10)}…`;
}

export type ResolvedScannedCode =
  | { kind: "member"; phone: string }
  | { kind: "coupon"; code: string }
  | { kind: "unsupported"; message: string }
  | { kind: "invalid"; message: string };

export const UNSUPPORTED_GROUP_BUY_MESSAGE =
  "掃到團購券 QR；呢張券要喺會員通商戶頁核銷，POS 暫未支援。";
export const UNRECOGNIZED_QR_MESSAGE = "無法辨識此 QR Code，請確認係會員碼或有效優惠券。";

/**
 * 由掃到嘅原始字串解析出「要認會員」定「要核銷券」。
 * 網絡／設定問題會變成 `invalid`，呼叫端直接顯示訊息，唔好當成券碼繼續試。
 */
export async function resolveScannedCode(raw: string): Promise<ResolvedScannedCode> {
  const value = String(raw ?? "").trim();
  const kind = classifyScannedCode(value);

  if (kind === "rewardCoupon") return { kind: "coupon", code: value };
  if (kind === "groupBuy") return { kind: "unsupported", message: UNSUPPORTED_GROUP_BUY_MESSAGE };
  if (kind === "unrecognized") return { kind: "invalid", message: UNRECOGNIZED_QR_MESSAGE };

  try {
    const response = await fetch("/api/ledger/member-qr/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: value }),
      cache: "no-store",
    });
    if (!response.ok) {
      return { kind: "invalid", message: "會員碼驗證失敗，請重新載入頁面再試。" };
    }
    const data = (await response.json()) as { ok?: boolean; phone?: string };
    if (data.ok && /^\d{8}$/.test(String(data.phone ?? ""))) {
      return { kind: "member", phone: String(data.phone) };
    }
    return { kind: "invalid", message: UNRECOGNIZED_QR_MESSAGE };
  } catch {
    return { kind: "invalid", message: "會員碼驗證須連線，請恢復網絡後再試。" };
  }
}
