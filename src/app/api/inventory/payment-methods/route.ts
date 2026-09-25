import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import {
  DEFAULT_PAYMENT_METHODS,
  normalizePaymentMethods,
  type PaymentMethodDef,
} from "@/lib/inventory-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 🔴 同 expenseRecorder `lib/account-settings.ts` 嘅常數必須一致。
 *
 * 支付方式主檔（admin 統一設置）存喺 expenseRecorder `merchants` 表一條**保留列**：
 * `name = "__global_settings__"`，內容放喺 `address` 欄、加前綴之後係 JSON。
 * 呢個係 expenseRecorder 本身嘅既有慣例（全域單位清單都係用同一條列），
 * 好處係**零 schema 改動**：admin 改完即刻生效。
 *
 * 前綴有兩個：`__global_settings__:` 係 2026-09-25 之後嘅新容器；
 * `__global_units__:` 係舊容器（當時只裝 `{ units }`）。兩個都要讀得返，
 * 否則商家已經設好嘅單位清單／舊 payload 會讀唔到。
 */
const GLOBAL_SETTINGS_MERCHANT_NAME = "__global_settings__";
const GLOBAL_SETTINGS_PREFIX = "__global_settings__:";
const GLOBAL_UNITS_PREFIX = "__global_units__:";

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

function decodePayload(address: unknown): Record<string, unknown> | null {
  if (typeof address !== "string") return null;
  const prefix = address.startsWith(GLOBAL_SETTINGS_PREFIX)
    ? GLOBAL_SETTINGS_PREFIX
    : address.startsWith(GLOBAL_UNITS_PREFIX)
      ? GLOBAL_UNITS_PREFIX
      : null;
  if (!prefix) return null;
  try {
    const parsed = JSON.parse(address.slice(prefix.length));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type PaymentMethodsResponse = {
  ok: boolean;
  /** `global` = 用 admin 設定；`default` = 主檔未設定過；`unavailable` = 讀唔到，暫用內建。 */
  source: "global" | "default" | "unavailable";
  /** true = admin 曾經儲存過主檔（即使係空清單）。 */
  configured: boolean;
  methods: PaymentMethodDef[];
  warning?: string;
  error?: string;
};

/**
 * 唯讀：回傳 admin 統一設置嘅支付方式主檔。
 *
 * 為何要 fallback 而唔係報錯：支付方式係「揀唔到就落唔到單」嘅硬依賴，
 * 讀唔到 expenseRecorder 時**必須**照樣出得到一份可用清單，
 * 唔可以令庫存頁整個開唔到（同 reports 嘅 `purchaseUnavailable` 同一原則：
 * 寧可明確標示「暫用內建」，都唔好靜靜死掉）。
 */
export async function GET() {
  const client = getExpenseSupabaseClient();
  if (!client) {
    return NextResponse.json<PaymentMethodsResponse>({
      ok: true,
      source: "unavailable",
      configured: false,
      methods: DEFAULT_PAYMENT_METHODS,
      warning: "未設定 expenseRecorder 連線，暫用內建預設支付方式（admin 設定未能讀取）。",
    });
  }

  const { data, error } = await client
    .from("merchants")
    .select("address")
    .eq("name", GLOBAL_SETTINGS_MERCHANT_NAME)
    .maybeSingle();

  if (error) {
    // 表唔存在（42P01）＝ 未執行 schema；同樣唔應該令庫存頁爆掉。
    return NextResponse.json<PaymentMethodsResponse>({
      ok: true,
      source: "unavailable",
      configured: false,
      methods: DEFAULT_PAYMENT_METHODS,
      warning: isMissingTable(error)
        ? "expenseRecorder 資料表尚未建立，暫用內建預設支付方式。"
        : `讀取支付方式主檔失敗：${error.message}（暫用內建預設）`,
    });
  }

  const payload = decodePayload(data?.address);
  // 🔴 `Array.isArray` 才當「已設定」：空陣列係有效設定（admin 刻意清空），
  //    唔可以當成「未設定」而補回預設 —— 否則 admin 清極都清唔走。
  const configured = Array.isArray(payload?.paymentMethods);

  return NextResponse.json<PaymentMethodsResponse>({
    ok: true,
    source: configured ? "global" : "default",
    configured,
    methods: normalizePaymentMethods(payload?.paymentMethods),
  });
}
