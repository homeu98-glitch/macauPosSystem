"use client";

import { useEffect, useState } from "react";

import { fetchKioskSettings, saveKioskSettings } from "@/lib/pos/kiosk-settings";
import { loadAuthSession } from "@/lib/storage";

/**
 * 「自動接自助單」開關（docs/87 §4 · 規格 5+6）。
 *
 * 放喺「店內線下訂單」頁，取代原「刪除全部訂單」掣位（規格 6）。
 *
 * - **開（預設）**：客人自助點餐 / 掃碼落單後**免確認直接出單**（規格 5）。
 * - **熄**：自助單落 `draft` 排喺「待確認」，等收銀台撳確認先用正常落單流程出廚房單。
 *
 * 三個設計重點：
 * 1. **真源喺 DB**（`pos_kiosk_settings`，PK `store_id`），唔喺 localStorage——
 *    自助點餐機同收銀台係唔同裝置，一定要有共同真源。
 * 2. **絕對唔好用 `pos_device_configs`**：嗰個 GET 係 `.order(updated_at desc).limit(1)`，
 *    冇 store filter，會讀到全店最新一條（任何 terminal 嘅）——
 *    同 `onlineOrderSettings.autoAccept` 被 server 蓋走嗰個 bug 係同一類。
 * 3. **禁 polling**：mount 讀一次就夠；其他 terminal 改咗，本機下次重開 / 落單會讀到最新。
 */
export function SelfOrderAutoAcceptToggle() {
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

  async function toggle() {
    if (!storeId || saving) return;
    const next = !enabled;
    const previous = enabled;
    setEnabled(next); // 樂觀更新：掣即刻有反應，失敗先 rollback
    setSaving(true);
    setError(null);
    try {
      await saveKioskSettings(storeId, next);
    } catch (e) {
      setEnabled(previous);
      setError(e instanceof Error ? e.message : "儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  if (!storeId) {
    // 冇登入記錄就唔顯示（避免商家以為設定咗但其實落咗去邊度都唔知）
    return null;
  }

  return (
    // 與左邊「自動接單」掣共用同一個樣式（orders-hub 兩卡高度/設計一致）：
    // label 「自動接自助單」+ pill button（emerald on / slate-white off，文字「開／關」）。
    <div className="flex shrink-0 items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5">
      <span className="text-xs font-semibold text-slate-600">
        自動接自助單
        {loading ? <span className="ml-1 font-normal text-slate-400">（讀取中…）</span> : null}
        {saving ? <span className="ml-1 font-normal text-slate-400">（儲存中…）</span> : null}
      </span>
      <button
        aria-label="自動接自助單"
        aria-pressed={enabled}
        className={`rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
          enabled ? "bg-emerald-600 text-white" : "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
        }`}
        disabled={loading || saving}
        onClick={() => void toggle()}
        type="button"
      >
        {enabled ? "開" : "關"}
      </button>
      {error ? <span className="text-[11px] font-semibold text-red-600">· {error}</span> : null}
    </div>
  );
}
