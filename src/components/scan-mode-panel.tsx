"use client";

import { useEffect, useMemo, useState } from "react";

import { KioskQrPanel, QrSvg } from "@/components/kiosk-qr-panel";
import { loadAuthSession } from "@/lib/storage";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import {
  DEFAULT_SCAN_MODE,
  fetchKioskSettings,
  normalizeScanMode,
  saveKioskSettings,
  type ScanMode,
} from "@/lib/pos/kiosk-settings";
import { openQrPrintWindow } from "@/lib/pos/qr-print";

/**
 * 設定頁「掃碼點餐」面板（docs/115）—— 取代舊版直接嵌 `KioskQrPanel`。
 *
 * 兩個模式**店級互斥**（用戶明確要求：快餐就快餐、堂食就堂食，唔可以同時開啟）：
 *
 * | | 堂食 `dine_in` | 快餐 `quick` |
 * |---|---|---|
 * | 碼嘅數量 | 每張枱一個 | **全店一個** |
 * | QR 網址 | `/menu?tableId=<枱>&store=<店>` | `/quick?store=<店>` |
 * | 落單 | 綁枱號，同一枱再加單 = 改同一張單 | 冇枱，**每單獨立**，同 kiosk 快餐一致 |
 * | 號碼 | 唔用單號（訂單標識 = 台名） | 店內 `pickup` 序號（同 kiosk 共用） |
 *
 * ⚠️ 切換模式之後，**另一邊嘅 QR 就唔會再顯示**（亦唔應該再印出去貼）：
 *   - 設成快餐 → 唔再顯示桌台碼（桌台碼張貼紙應該拎走，否則客人掃到會落一張
 *     「綁枱」單，但鋪頭根本冇開枱）；
 *   - 設成堂食 → 唔顯示快餐碼。
 *
 * 真源係 DB（`pos_kiosk_settings.scan_mode`，經 `/api/pos/kiosk-settings` 讀寫），
 * 唔係 localStorage —— 收銀台設定、Kiosk / 手機掃碼讀，一定要有共同真源。
 * 離線 / 讀取失敗一律 fallback `dine_in`（向後兼容：現存店鋪行為不變）。
 */

/** 由 kiosk 綁店 / auth session 取所屬店（同 `KioskQrPanel` 同一口徑）。 */
function useQrStoreId(): string {
  const [storeId, setStoreId] = useState("");
  useEffect(() => {
    // kiosk 綁店優先：`mode=kiosk` 登入只 save 綁店、唔 save auth session。
    const binding = loadKioskDeviceBinding();
    const session = loadAuthSession();
    setStoreId(binding?.storeId ?? session?.merchantId ?? "");
  }, []);
  return storeId;
}

function ModeOption({
  active,
  busy,
  description,
  label,
  onSelect,
}: {
  active: boolean;
  busy: boolean;
  description: string;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onSelect}
      aria-pressed={active}
      className={`flex-1 rounded-2xl border px-4 py-3 text-left transition disabled:opacity-60 ${
        active ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
            active ? "border-orange-500" : "border-slate-300"
          }`}
        >
          {active ? <span className="h-2 w-2 rounded-full bg-orange-500" /> : null}
        </span>
        <span className={`text-sm font-semibold ${active ? "text-orange-700" : "text-slate-800"}`}>{label}</span>
      </div>
      <p className="mt-1.5 pl-6 text-xs leading-relaxed text-slate-500">{description}</p>
    </button>
  );
}

/** 全店單一快餐 QR（貼櫃檯／快餐區）。 */
function QuickScanQrPanel({ storeId }: { storeId: string }) {
  const [host, setHost] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  const url = useMemo(() => {
    if (!storeId) return "";
    const origin =
      host || (typeof window !== "undefined" ? window.location.origin : "https://macau-pos-system.vercel.app");
    return `${origin}/quick?store=${encodeURIComponent(storeId)}`;
  }, [host, storeId]);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-1 text-base font-semibold text-slate-900">快餐掃碼 QR（全店一個）</div>
      <p className="mb-4 text-sm text-slate-500">
        快餐模式全店只用一個碼，客人掃碼後直接落單、每張單獨立（同自助點餐機快餐流程一致）。
        印出貼喺櫃檯／快餐區。
      </p>

      <label className="mb-1 block text-xs text-slate-500">網址主機（host）</label>
      <input
        value={host}
        onChange={(e) => setHost(e.target.value)}
        placeholder={typeof window !== "undefined" ? window.location.origin : ""}
        className="mb-6 w-full rounded-lg border border-slate-200 p-2 text-sm"
      />

      {hint ? (
        <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800" role="status">
          {hint}
        </div>
      ) : null}

      {!storeId ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
          未取得店鋪編號，請先以商戶帳號登入 / 綁店。
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6">
          <QrSvg text={url} size={220} />
          <div className="break-all text-center text-[11px] text-slate-400">{url}</div>
          <div className="grid w-full max-w-xs grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                setHint("已複製快餐點餐網址。");
              }}
              className="rounded-lg bg-slate-100 py-2 text-xs font-semibold text-slate-700"
            >
              複製網址
            </button>
            <button
              type="button"
              onClick={() => {
                const ok = openQrPrintWindow({
                  title: "掃碼點餐",
                  subtitle: "快餐",
                  footer: "掃碼點餐 · 點完請到櫃檯付款",
                  url,
                  size: 400,
                });
                if (!ok) setHint("無法開啟列印視窗，請允許彈出視窗或改用「複製網址」。");
              }}
              className="rounded-lg bg-orange-500 py-2 text-xs font-semibold text-white"
            >
              列印
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ScanModePanel() {
  const storeId = useQrStoreId();
  const [scanMode, setScanMode] = useState<ScanMode>(DEFAULT_SCAN_MODE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // mount 讀一次（禁 polling；其他 terminal 改咗，本機下次重入設定頁會讀到最新）。
  useEffect(() => {
    let cancelled = false;
    if (!storeId) {
      setLoading(false);
      return;
    }
    void fetchKioskSettings(storeId).then((settings) => {
      if (cancelled) return;
      setScanMode(normalizeScanMode(settings.scanMode));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  function changeMode(next: ScanMode) {
    if (!storeId || saving || next === scanMode) return;
    const previous = scanMode;
    setScanMode(next); // 樂觀更新：掣即刻有反應，失敗先 rollback
    setSaving(true);
    setError(null);
    // ⚠️ 只傳 scanMode：server 係 read-then-merge，唔會順手洗走「自動接自助單」。
    saveKioskSettings(storeId, { scanMode: next })
      .catch((e: unknown) => {
        setScanMode(previous);
        setError(e instanceof Error ? e.message : "儲存失敗");
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="grid min-w-0 gap-4">
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-1 text-base font-semibold text-slate-900">掃碼點餐模式</div>
        <p className="mb-4 text-sm text-slate-500">
          兩種模式互斥（同一時間只可以揀一款）。切換之後，另一邊嘅 QR 就唔會再出現喺呢一頁。
        </p>

        {loading ? (
          <div className="text-sm text-slate-400">讀取中…</div>
        ) : !storeId ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
            未取得店鋪編號，請先以商戶帳號登入 / 綁店。
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ModeOption
                active={scanMode === "dine_in"}
                busy={saving}
                label="堂食（每枱一碼）"
                description="每張桌台各自一個 QR，客人掃碼後落單綁定枱號；同一枱再加單會加入同一張單。"
                onSelect={() => changeMode("dine_in")}
              />
              <ModeOption
                active={scanMode === "quick"}
                busy={saving}
                label="快餐（全店一碼）"
                description="全店只用一個 QR（貼櫃檯／快餐區）。冇枱，每張單獨立，流程同自助點餐機快餐一致。"
                onSelect={() => changeMode("quick")}
              />
            </div>
            <div aria-live="assertive" role="alert">
              {error ? (
                <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
              ) : null}
            </div>
            {saving ? <div className="mt-2 text-xs text-slate-400">儲存中…</div> : null}
          </>
        )}
      </section>

      {/*
        ⚠️ 只顯示當前模式嘅 QR（用戶明確要求）：
        快餐模式唔應該再出現桌台碼（否則客人掃到會落一張「綁枱」單，但鋪頭冇開枱）；
        堂食模式亦唔會顯示快餐碼。
      */}
      {scanMode === "quick" ? <QuickScanQrPanel storeId={storeId} /> : <KioskQrPanel />}
    </div>
  );
}
