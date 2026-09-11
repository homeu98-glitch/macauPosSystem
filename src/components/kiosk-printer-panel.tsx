"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { PrinterCardV2, PrinterEmptyState } from "@/components/printer-card-v2";
import { PrinterWizardModal } from "@/components/printer-wizard-modal";
import { fetchKioskSettings, saveKioskSettings } from "@/lib/pos/kiosk-settings";
import { posDeviceAuthHeadersFresh } from "@/lib/pos/pos-sync-auth";
import { loadKioskPrinters, saveKioskPrinters } from "@/lib/storage";
import { sendTestPrint } from "@/lib/print-bridge/printer-test-print";
import type { DevicePrinterConfig } from "@/lib/types";

/**
 * 「自助點餐機打印機」設定區塊（`/order` → 右上角「設定」）。
 *
 * ## 為何要 Kiosk 專屬打印機（docs/87 §6.2 · 2026-09-11 落地）
 *
 * 自助點餐機要**另外一台**打印機出顧客小票畀客人拿著走 —— 唔係收銀台嗰部。
 * 舊版 `resolveJobPrinter()` 只讀 `loadDeviceConfig()`（收銀端本機裝置設定），
 * 一部專用 kiosk 平板從來冇配置過 → 清單為空 → `buildTemplateReceiptJobs()`
 * `return []` → **靜默唔出紙**（冇 error、冇紙，最難 debug 嗰種）。
 *
 * ## 真源 / 快取分工（用戶 2026-09-11 定案：「改 server 側」）
 *
 * - **真源 = DB**（`pos_kiosk_settings.printers`，per-store，0032 migration）：
 *   改一次**全店所有自助機即時生效**，換機 / 清 cache 都拎得返。
 * - **本機快取**（`macau-pos/stores/{storeId}/kiosk-printers`）：
 *   `resolveJobPrinter()` 係同步函數，出紙嗰刻唔可以等 HTTP；斷網時靠快取照印。
 *
 * ⚠️ 每次改動**兩邊都寫**（先快取、後 server）。server 寫失敗**唔 rollback 本機**
 * —— 本機照樣印得到，只係提示「未同步到雲端」，唔會出現「改完即刻印唔到」。
 *
 * ⚠️ 用途鎖死 `receipt`（`lockRole`）：`buildKioskReceiptPrintJobs()` 只認
 * `role === "receipt"`，畀商家揀到「廚房機」會加完之後靜靜唔出紙。
 */
export function KioskPrinterPanel({ storeId }: { storeId: string }) {
  const [printers, setPrinters] = useState<DevicePrinterConfig[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  /** 欄位編輯嘅雲端寫入防抖 timer（見 `handleUpdate`）。 */
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸載時清走未觸發嘅防抖 timer，避免 unmount 之後仲打 POST。
  useEffect(
    () => () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    },
    [],
  );

  // mount：先用本機快取填畫面（即時、離線都有），再由 server 覆蓋（真源）。
  useEffect(() => {
    setPrinters(loadKioskPrinters());
    setHydrated(true);
    if (!storeId) return;
    let cancelled = false;
    void (async () => {
      const settings = await fetchKioskSettings(storeId, {
        fallbackPrinters: loadKioskPrinters(),
      });
      // ⚠️ 只認真正由 server 攞到嘅值（`fromServer`）：離線時 `printers` 係本機快取
      // 原值，唔應該再寫一次；而 server 明確清空（空陣列）就一定要跟住清。
      if (cancelled || !settings.fromServer) return;
      saveKioskPrinters(settings.printers);
      setPrinters(settings.printers);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  /** 本機快取 + 雲端一齊寫。雲端失敗唔 rollback（寧願印得到，唔好「改完反而冇紙」）。 */
  const persist = useCallback(
    async (next: DevicePrinterConfig[], okMessage: string) => {
      setPrinters(next);
      saveKioskPrinters(next);
      if (!storeId) {
        setStatus(`${okMessage}（未綁定店鋪，只存喺本機）`);
        return;
      }
      setBusy(true);
      try {
        const headers = await posDeviceAuthHeadersFresh();
        await saveKioskSettings(storeId, { printers: next }, headers);
        setStatus(`${okMessage}（全店所有自助點餐機即時生效）`);
      } catch (e) {
        setStatus(
          `已存喺本機（呢部機即時生效），但同步到雲端失敗：${e instanceof Error ? e.message : "未知錯誤"}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [storeId],
  );

  function handleAdd(printer: DevicePrinterConfig) {
    void persist([...printers, printer], `已加入「${printer.name}」`);
  }

  function handleRemove(id: string) {
    const target = printers.find((p) => p.id === id);
    void persist(
      printers.filter((p) => p.id !== id),
      `已刪除「${target?.name ?? id}」`,
    );
  }

  function handleToggle(id: string, enabled: boolean) {
    const next = printers.map((p) => (p.id === id ? { ...p, enabled } : p));
    void persist(next, enabled ? "已啟用打印機" : "已停用打印機（停用後唔會出紙）");
  }

  /**
   * 欄位編輯（IP 地址等）：`PrinterCardV2` 嘅 input 係**逐個字** onChange，
   * 若果每次打字都打一次 POST，會有兩個問題：① 洗 request；② 打到一半（`192.168.`）
   * 就已經寫咗上雲，中途 reload 會拿到半截 IP。
   * 所以：**本機即時寫**（UI 唔會滯），雲端**防抖 800ms**（停手先同步）。
   */
  function handleUpdate(id: string, patch: Partial<DevicePrinterConfig>) {
    const next = printers.map((p) => (p.id === id ? { ...p, ...patch } : p));
    setPrinters(next);
    saveKioskPrinters(next);
    if (updateTimerRef.current) clearTimeout(updateTimerRef.current);
    updateTimerRef.current = setTimeout(() => {
      updateTimerRef.current = null;
      void persist(next, "已更新打印機設定");
    }, 800);
  }

  async function handleTestPrint(printer: DevicePrinterConfig) {
    if (testingPrinterId) return;
    setTestingPrinterId(printer.id);
    try {
      const result = await sendTestPrint(printer);
      setStatus(result.message);
    } finally {
      setTestingPrinterId(null);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-sm font-semibold text-slate-900">自助點餐機打印機</div>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        客人喺呢部機落單後，會由呢度指定嘅打印機即時出小票畀客人拿著。同收銀台嘅打印機
        分開，唔會互相影響。改動會<b>即時套用到全店所有自助點餐機</b>。
      </p>

      {hydrated && printers.length === 0 ? (
        <div className="mt-3">
          <PrinterEmptyState onAdd={() => setWizardOpen(true)} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          {printers.map((printer) => (
            <PrinterCardV2
              key={printer.id}
              printer={printer}
              printZones={[]}
              testing={testingPrinterId === printer.id}
              onToggle={handleToggle}
              onRemove={handleRemove}
              onTestPrint={(p) => void handleTestPrint(p)}
              onUpdate={handleUpdate}
            />
          ))}
          <button
            className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            onClick={() => setWizardOpen(true)}
            type="button"
          >
            + 添加自助點餐機打印機
          </button>
        </div>
      )}

      {status ? (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
          {busy ? "同步中… " : ""}
          {status}
        </div>
      ) : null}

      <PrinterWizardModal
        lockRole="receipt"
        onAdd={handleAdd}
        onClose={() => setWizardOpen(false)}
        open={wizardOpen}
        printZones={[]}
      />
    </section>
  );
}
