/**
 * 登入「身份清單」嘅客戶端共用層（docs/160 §11、docs/161）。
 *
 * ## 為何要抽出嚟
 *
 * 同一個清單而家有**兩個**入口要用：
 *   ① `/login`   —— 未登入 / 冷啟，要認人
 *   ② `/operator` —— 已經登入，要**換人**（店員 ↔ 店主）
 *
 * 兩邊各自抄一份 `fetch` + 錯誤判斷，必然走樣（呢個 repo 已經中過幾次）。
 * 所以：request／response shape、`tableMissing` 判斷、診斷數字全部收喺呢度。
 *
 * ## 🔴 `table_missing` 唔可以靠 HTTP status 分辨
 *
 * `/api/pos/login/identities` 對「表未建立／未升級」刻意回 **HTTP 200 + ok:false**
 * （見該 route 嘅註解：呢個係可預期狀態，唔應該扮成 5xx）。
 * ⇒ 一定要讀 `code`，唔可以只睇 `response.status`。
 * 唔讀 `code` 嘅後果（實測）：UI 當成「網絡問題」，留住一張永遠失敗嘅憑證，
 * 畫面卡喺空白身份清單 —— 用家只會覺得「揀咩都冇用」。
 */

/** 身份卡（店主 或 已啟用店員）。 */
export type LoginIdentity = {
  kind: "owner" | "staff";
  id: string;
  name: string;
  staffNo?: string;
  role: "owner" | "manager" | "cashier";
};

export type IdentitiesPayload = {
  ok?: boolean;
  error?: string;
  code?: string;
  known?: boolean;
  deviceMode?: boolean;
  storeId?: string;
  storeName?: string;
  identities?: LoginIdentity[];
  staffTotal?: number;
  staffActive?: number;
  staffTableMissing?: boolean;
};

export type FetchIdentitiesResult =
  | { ok: true; payload: IdentitiesPayload }
  | {
      ok: false;
      error: string;
      status: number;
      /** 表未建立（0073）／未升級（0075）—— 呼叫方應該落返帳號模式。 */
      tableMissing: boolean;
    };

/**
 * 打 `/api/pos/login/identities`。
 *
 * 兩種入參：`{deviceId, deviceSecret}`（已初始化嘅機）或 `{account}`（新機）。
 */
export async function fetchLoginIdentities(input: {
  account?: string;
  deviceId?: string;
  deviceSecret?: string;
}): Promise<FetchIdentitiesResult> {
  try {
    const response = await fetch("/api/pos/login/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as IdentitiesPayload | null;

    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        status: response.status,
        tableMissing: payload?.code === "table_missing",
        error: payload?.error ?? "讀取身份失敗，請再試一次。",
      };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, status: 0, tableMissing: false, error: "網絡錯誤，請稍後再試。" };
  }
}

/** 「點解得店主一個身份？」——三種成因喺畫面上長得一模一樣，所以要講清楚。 */
export function describeIdentityGap(payload: {
  identities?: LoginIdentity[];
  known?: boolean;
  staffTotal?: number;
  staffActive?: number;
  staffTableMissing?: boolean;
}): string | null {
  if ((payload.identities?.length ?? 0) > 1) return null;
  if (payload.known === false) {
    return "呢間店第一次用：店主用自己帳號登入一次之後，店員就會出現喺呢個清單。";
  }
  if (payload.staffTableMissing) {
    return "店員表未建立（migration 0072 未跑），所以暫時淨係得店主可以登入。";
  }
  if (Number(payload.staffTotal ?? 0) === 0) {
    return "呢間店仲未加入店員。去「設定 → 員工權限」加咗店員，佢哋就會出現喺呢個清單。";
  }
  if (Number(payload.staffActive ?? 0) === 0) {
    return "店員全部已停用，所以暫時淨係得店主可以登入。";
  }
  return null;
}

/** 身份卡第二行（店主 / 工號 · 角色）。 */
export function describeIdentity(identity: LoginIdentity): string {
  if (identity.kind === "owner") return "店主 · 全部權限";
  const roleLabel = identity.role === "manager" ? "店長" : "收銀員";
  return `工號 ${identity.staffNo ?? "—"} · ${roleLabel}`;
}

/** 由 `staff:01` 呢種 account 抽出工號（`/api/pos/login/identity` 簽嘅格式）。 */
export function staffNoFromAccount(account: string | null | undefined): string {
  const raw = String(account ?? "");
  return raw.startsWith("staff:") ? raw.slice("staff:".length) : "";
}

/**
 * 8 位店舖帳號（唔係就回空字串）。
 *
 * 🔴 一定要排除 `staff:01` 呢種店員 account：單純 `replace(/\D/g,"")` 之後
 *    一個 8 位工號（例如 `staff:12345678`）會被誤認成店舖帳號，
 *    然後攞去查錯店 —— 呢個 bug 靜靜錯，最難查。
 */
export function storeAccountOf(account: string | null | undefined): string {
  const raw = String(account ?? "");
  if (raw.startsWith("staff:")) return "";
  const digits = raw.replace(/\D/g, "");
  return /^\d{8}$/.test(digits) ? digits : "";
}
