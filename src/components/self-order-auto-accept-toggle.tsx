"use client";

import { useCallback, useEffect, useState } from "react";

import { AutoAcceptPill } from "@/components/auto-accept-pill";
import { fetchKioskSettings, saveKioskSettings } from "@/lib/pos/kiosk-settings";
import { loadAuthSession } from "@/lib/storage";

/**
 * 「自動接自助單」開關（docs/87 §4 · 規格 5+6）。
 *
 * 三個設計重點：
 * 1. **真源喺 DB**（`pos_kiosk_settings`，PK `store_id`），唔喺 localStorage——
 *    自助點餐機同收銀台係唔同裝置，一定要有共同真源。
 * 2. **絕對唔好用 `pos_device_configs`**：嗰個 GET 係 `.order(updated_at desc).limit(1)`，
 *    冇 store filter，會讀到全店最新一條（任何 terminal 嘅）——
 *    同 `onlineOrderSettings.autoAccept` 被 server 蓋走嗰個 bug 係同一類。
 * 3. **禁 polling**：mount 讀一次就夠；其他 terminal 改咗，本機下次重開 / 落單會讀到最新。
 *
 * 呢個檔案 export 兩樣嘢：
 * - `useSelfOrderAutoAccept()`：**狀態 hook**（讀寫 DB + 樂觀更新），
 *   畀唔同版型嘅 call site 自己揀點渲染（快餐介面要 compact pill，訂單頁要 contained pill）。
 * - `SelfOrderAutoAcceptToggle()`：訂單頁「店內線下訂單」卡用嘅預設版型。
 */

export function useSelfOrderAutoAccept() {
  const [enabled, setEnabled] = useState(true); // 預設＝免確認直接出單（規格 5）
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sid = loadAuthSession()?.merchantId ?? null;
    setStoreId(sid);
    if (!sid) {
      setLoading(false);
      return;
    }
    void fetchKioskSettings(sid).then((settings) => {
      if (cancelled) return;
      setEnabled(settings.selfOrderAutoAccept);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(
    (next: boolean) => {
      if (!storeId || saving) return;
      const previous = enabled;
      setEnabled(next); // 樂觀更新：掣即刻有反應，失敗先 rollback
      setSaving(true);
      setError(null);
      saveKioskSettings(storeId, next)
        .catch((e: unknown) => {
          setEnabled(previous);
          setError(e instanceof Error ? e.message : "儲存失敗");
        })
        .finally(() => {
          setSaving(false);
        });
    },
    [enabled, saving, storeId],
  );

  return { enabled, loading, saving, error, storeId, setEnabled: toggle };
}

/** 訂單頁「店內線下訂單」卡用（取代原「刪除全部訂單」掣位，規格 6）。 */
export function SelfOrderAutoAcceptToggle() {
  const { enabled, loading, saving, error, storeId, setEnabled } = useSelfOrderAutoAccept();

  if (!storeId) {
    // 冇登入記錄就唔顯示（避免商家以為設定咗但其實落咗去邊度都唔知）
    return null;
  }

  return (
    <AutoAcceptPill
      busy={loading || saving}
      busyHint={loading ? "（讀取中…）" : saving ? "（儲存中…）" : undefined}
      enabled={enabled}
      error={error}
      label="自動接自助單"
      onChange={setEnabled}
      variant="contained"
    />
  );
}
