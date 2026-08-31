/**
 * 自助點餐設定（按店）· client / server 共用。
 *
 * 真源：DB `pos_kiosk_settings`（0015 migration），經 `/api/pos/kiosk-settings` 讀寫。
 *
 * ⚠️ 唔好改用 `pos_device_configs`：嗰張表嘅讀取係 `.order("updated_at", desc).limit(1)`
 * **冇 store filter** = 「全店最新一條（任何 terminal）」，用嚟存 per-store 設定一定錯亂
 * （同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑，見 docs/52）。
 *
 * 點解要落 DB 而唔係讀 localStorage：舊嘅 `kioskKitchenMode` 就係由 Kiosk 自己嘅
 * localStorage 讀，而 Kiosk 從來冇設定 UI → 永遠係預設值 → 開關係死 code。
 * 開關擺喺收銀台「訂單」頁，一定要收銀端寫、Kiosk 讀，所以必須經 DB。
 * 見 docs/87 §4.3 / §9 P0 #4。
 */

export interface KioskSettings {
  storeId: string;
  /**
   * 「自動接自助單」開關。
   * - `true`（**預設**，規格 5）：免確認，客人落單後直接出廚房單
   * - `false`：自助點餐單排入「待確認」，等收銀台撳「確認」先用代客下單流程出單
   */
  selfOrderAutoAccept: boolean;
  updatedAt?: string | null;
}

/** 讀取失敗 / 離線時用呢個值：免確認（同 DB default 同 `PosLocalSettings.autoAcceptSelfOrder` default 一致）。 */
export const DEFAULT_KIOSK_SETTINGS_FALLBACK: Omit<KioskSettings, "storeId"> = {
  selfOrderAutoAccept: true,
  updatedAt: null,
};

/**
 * 讀取自助點餐設定（按店）。
 *
 * 設計上**只喺落單時 call 一次**，唔做 polling（全專案禁 polling，見 docs/52）。
 * 離線 / 失敗一律 fallback 去 `DEFAULT_KIOSK_SETTINGS_FALLBACK`（免確認），
 * 確保 Kiosk 唔會因為拎唔到設定而落唔到單。
 */
export async function fetchKioskSettings(storeId: string): Promise<KioskSettings> {
  const fallback: KioskSettings = { storeId, ...DEFAULT_KIOSK_SETTINGS_FALLBACK };
  if (!storeId) return fallback;

  try {
    const res = await fetch(`/api/pos/kiosk-settings?storeId=${encodeURIComponent(storeId)}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return fallback;
    const payload = (await res.json()) as {
      ok?: boolean;
      settings?: { storeId?: string; selfOrderAutoAccept?: boolean; updatedAt?: string | null };
    };
    if (!payload?.ok || !payload.settings) return fallback;
    return {
      storeId: payload.settings.storeId ?? storeId,
      selfOrderAutoAccept:
        typeof payload.settings.selfOrderAutoAccept === "boolean"
          ? payload.settings.selfOrderAutoAccept
          : DEFAULT_KIOSK_SETTINGS_FALLBACK.selfOrderAutoAccept,
      updatedAt: payload.settings.updatedAt ?? null,
    };
  } catch {
    // 離線 / 網絡錯誤：用預設（免確認）繼續落單
    return fallback;
  }
}

/**
 * 保存自助點餐設定（收銀端「訂單」頁「自動接自助單」掣 call）。
 * 失敗會 throw，等 UI 可以提示用家（同 `/api/pos/device-config` 嗰邊唔同 ——
 * 呢個係開關，靜默失敗會令用家以為改咗其實冇改）。
 */
export async function saveKioskSettings(
  storeId: string,
  selfOrderAutoAccept: boolean,
): Promise<KioskSettings> {
  const res = await fetch("/api/pos/kiosk-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId, selfOrderAutoAccept }),
  });
  const payload = (await res.json()) as {
    ok?: boolean;
    error?: string;
    settings?: { storeId?: string; selfOrderAutoAccept?: boolean; updatedAt?: string | null };
  };
  if (!res.ok || !payload?.ok) {
    throw new Error(payload?.error ?? "保存自助點餐設定失敗。");
  }
  return {
    storeId: payload.settings?.storeId ?? storeId,
    selfOrderAutoAccept: payload.settings?.selfOrderAutoAccept ?? selfOrderAutoAccept,
    updatedAt: payload.settings?.updatedAt ?? null,
  };
}
