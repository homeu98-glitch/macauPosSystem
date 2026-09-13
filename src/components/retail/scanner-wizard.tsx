"use client";

/**
 * 掃碼槍自動學習嚮導（零售）。
 *
 * 【為何要「自動學習」】
 * HID 掃碼槍本質係鍵盤 wedge → 瀏覽器**讀唔到型號**（冇 USB descriptor API）。
 * 所以唔可以靠型號庫硬配；改為**由實際輸入特徵反推**：掃 3 件唔同商品，
 * 量每鍵間隔（掃碼槍 ~5–15ms vs 人手 ~150ms）→ 得出前綴 / 結尾 / 超時 / 長度。
 *
 * 【🔴 一定要掃唔同嘅條碼】
 * 三次掃同一個條碼 → 共同前綴 = 整個條碼 → 分離唔出裝置前綴。
 * 引擎會 `ok: true` 但留空前綴 + 出 warning，UI 要照顯示（唔可以當成功）。
 *
 * 引擎喺 `@/lib/retail/scanner-profiles`（純函式 + 單測）；呢度只做接線。
 */

import { useCallback, useMemo, useState } from "react";

import { loadPosLocalSettings, savePosLocalSettings } from "@/lib/storage";
import type { ScanSample, ScannerProfile } from "@/lib/retail/types";
import {
  defaultScannerProfile,
  describeSuffix,
  getScannerModelOptions,
  learnProfile,
  profileFromBehavior,
  SCANNER_BEHAVIOR_PRESETS,
  type LearnMetrics,
  type LearnResult,
} from "@/lib/retail/scanner-profiles";
import { useBarcodeScanner } from "@/lib/retail/use-barcode-scanner";

const NEEDED = 3;

type Toast = { tone: "ok" | "err" | "info"; text: string };

export function ScannerWizard({ onClose }: { onClose: () => void }) {
  const [samples, setSamples] = useState<ScanSample[]>([]);
  const [result, setResult] = useState<LearnResult | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  /** 測試框：用推斷出嘅 profile 收一次掃描去核對 */
  const [testCode, setTestCode] = useState("");

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  /** 學習期間用「寬鬆」profile 收樣本 —— 唔可以一開始就用嚴格 charset 濾走樣本 */
  const collectProfile: ScannerProfile = useMemo(
    () => ({ ...defaultScannerProfile(), id: "collect", charset: "alnum", suffix: "enter" }),
    [],
  );

  /** 測試階段用推斷出嘅 profile（真正要驗證嘅嗰個） */
  const testProfile: ScannerProfile = useMemo(
    () =>
      result?.ok
        ? result.profile
        : { ...defaultScannerProfile(), id: "test", charset: "alnum" },
    [result],
  );

  const [phase, setPhase] = useState<"collect" | "test">("collect");

  // ① 收集樣本（學習階段）
  useBarcodeScanner({
    enabled: phase === "collect",
    profile: collectProfile,
    onScan: () => void 0,
    onSample: (s) => {
      setSamples((prev) => {
        const next = [...prev, s];
        if (next.length >= NEEDED) {
          setResult(learnProfile(next, { id: "auto", name: "自動學習" }));
        }
        return next.slice(0, NEEDED);
      });
    },
  });

  // ② 測試（核對階段）
  useBarcodeScanner({
    enabled: phase === "test",
    profile: testProfile,
    onScan: (code) => {
      // 🔴 呢度嘅 code 已經過 `stripPrefix` + `isPlausibleCode`（即係會真正入車嘅值）
      setTestCode(code);
      flash("ok", `測試成功：讀到「${code}」`);
    },
    onReject: (code) => flash("info", `讀到「${code}」但唔過驗證（長度 / 字元集唔符）`),
  });

  const save = useCallback(() => {
    if (!result?.ok) {
      flash("err", "未推斷出設定 → 先掃 3 次");
      return;
    }
    const settings = loadPosLocalSettings();
    // 同一個 id 再學 → 覆寫（唔會累積一堆同名 profile）
    const others = (settings.scannerProfiles ?? []).filter((p) => p.id !== result.profile.id);
    const next = {
      ...settings,
      scannerProfiles: [...others, result.profile],
      activeScannerProfileId: result.profile.id,
    };
    // 🔴 一定要檢查回傳值 —— 靜默失敗 = reload 打回原形
    const ok = savePosLocalSettings(next);
    if (!ok) {
      flash("err", "寫入失敗（儲存空間不足 / 私隱模式）→ 設定可能未儲存");
      return;
    }
    flash("ok", "已儲存並啟用（收銀台即時生效）");
  }, [result, flash]);

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = SCANNER_BEHAVIOR_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      const profile = profileFromBehavior(preset.behavior, { id: `preset-${preset.id}`, name: preset.name });
      setResult({ ok: true, profile, metrics: emptyMetrics(), warnings: ["由預設型號套用 —— 建議之後掃 3 件商品核對。"] });
      setPhase("test");
    },
    [],
  );

  const applyManual = useCallback(() => {
    const options = getScannerModelOptions();
    if (options.length === 0) {
      flash("info", "冇內建型號庫 → 請用自動學習");
      return;
    }
    const first = options[0];
    const profile = profileFromBehavior(first.profile, {
      id: "model-0",
      name: `${first.brand} ${first.model}`,
    });
    setResult({ ok: true, profile, metrics: emptyMetrics(), warnings: ["由型號庫套用 —— 建議之後掃 3 件商品核對。"] });
    setPhase("test");
  }, [flash]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 md:items-center md:p-6">
      <div className="flex max-h-[94dvh] w-full max-w-[760px] flex-col rounded-t-3xl bg-white md:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-slate-200 p-4">
          <h2 className="text-[15px] font-bold">掃碼槍設定</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
            第 {phase === "collect" ? "1" : "2"} / 2 步
          </span>
          <button
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-[14px] font-semibold text-slate-600"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {phase === "collect" ? (
            <>
              <p className="rounded-xl bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">
                唔需要揀型號 —— 任何牌子嘅掃碼槍都用得。攞起掃碼槍，
                <b>掃 3 件唔同嘅商品</b>，系統就會由輸入速度同格式反推出設定。
                <br />
                <span className="text-amber-700">
                  ⚠️ 一定要**唔同**條碼：三次都掃同一件，就分辨唔到掃碼槍嘅出廠前綴。
                </span>
              </p>

              <div className="mt-4 grid gap-2">
                {Array.from({ length: NEEDED }).map((_, i) => {
                  const s = samples[i];
                  return (
                    <div
                      key={i}
                      className={`flex items-center gap-3 rounded-xl border p-3 ${
                        s ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white"
                      }`}
                    >
                      <span
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                          s ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {s ? "✓" : i + 1}
                      </span>
                      <span className="min-w-0 flex-1 font-mono text-[13px]">
                        {s ? s.chars : <span className="text-slate-400">等緊掃描…</span>}
                      </span>
                      {s ? (
                        <span className="shrink-0 text-[11px] text-slate-500">
                          {s.keyTimestamps.length} 鍵 · {describeSuffix(s.terminatedBy ?? "none")}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-xl border border-slate-300 px-3 py-2.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    setSamples([]);
                    setResult(null);
                    setTestCode("");
                  }}
                  type="button"
                >
                  清除重試
                </button>
                <button
                  className="rounded-xl border border-slate-300 px-3 py-2.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
                  onClick={() => setPhase("test")}
                  type="button"
                >
                  跳過，手動揀型號 →
                </button>
              </div>

              {samples.length >= 2 ? <LearnPanel result={result} /> : null}

              {result?.ok ? (
                <button
                  className="mt-4 w-full rounded-2xl bg-orange-600 py-3.5 text-[14px] font-bold text-white hover:bg-orange-700"
                  onClick={() => setPhase("test")}
                  type="button"
                >
                  下一步：測試核對
                </button>
              ) : null}
            </>
          ) : (
            <>
              {result?.ok ? (
                <>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                    <div className="text-[12.5px] font-bold text-emerald-800">推斷出嘅設定</div>
                    <dl className="mt-2 grid grid-cols-2 gap-y-1.5 text-[12px] md:grid-cols-4">
                      <Spec label="前綴" value={result.profile.prefix || "（無）"} />
                      <Spec label="結尾" value={describeSuffix(result.profile.suffix)} />
                      <Spec label="超時" value={`${result.profile.timeoutMs}ms`} />
                      <Spec label="長度" value={`${result.profile.minLength ?? "?"}–${result.profile.maxLength ?? "?"}`} />
                      <Spec label="字元集" value={result.profile.charset === "digits" ? "純數字" : "字母數字"} />
                      <Spec label="來源" value={result.profile.source === "auto-learn" ? "自動學習" : "型號庫 / 預設"} />
                    </dl>
                  </div>

                  {result.warnings.length > 0 ? (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                      {result.warnings.map((w, i) => (
                        <p key={i} className="text-[11.5px] font-semibold text-amber-800">
                          ⚠️ {w}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="text-[12.5px] font-bold text-slate-700">未做自動學習</div>
                  <p className="mt-1 text-[11.5px] text-slate-500">
                    可以直接揀一個通用預設（大部分 HID 掃碼槍都啱），再喺下面測試核對。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {SCANNER_BEHAVIOR_PRESETS.slice(0, 4).map((p) => (
                      <button
                        key={p.id}
                        className="rounded-lg bg-white px-3 py-2 text-[11.5px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                        onClick={() => applyPreset(p.id)}
                        type="button"
                      >
                        {p.name}
                      </button>
                    ))}
                    <button
                      className="rounded-lg bg-white px-3 py-2 text-[11.5px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                      onClick={applyManual}
                      type="button"
                    >
                      型號庫第一個
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-xl border border-slate-200 p-3">
                <div className="text-[12px] font-bold text-slate-700">測試核對</div>
                <p className="mt-1 text-[11.5px] text-slate-500">
                  用呢個設定掃一件商品。讀到嘅條碼會顯示喺下面 —— 同商品條碼一致就代表設定正確。
                </p>
                <div className="mt-2 min-h-[52px] rounded-xl bg-slate-900 px-4 py-3 font-mono text-[16px] text-emerald-300">
                  {testCode || <span className="text-slate-500">等緊掃描…</span>}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="rounded-xl border border-slate-300 px-4 py-3 text-[12px] font-semibold text-slate-600"
                  onClick={() => setPhase("collect")}
                  type="button"
                >
                  ← 返去重新學習
                </button>
                <button
                  className="min-h-[44px] flex-1 rounded-2xl bg-orange-600 px-5 text-[14px] font-bold text-white hover:bg-orange-700 disabled:bg-slate-300"
                  disabled={!result?.ok}
                  onClick={save}
                  type="button"
                >
                  儲存並啟用
                </button>
              </div>
            </>
          )}
        </div>

        {toast ? (
          <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2">
            <div
              className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${
                toast.tone === "ok" ? "bg-emerald-600" : toast.tone === "err" ? "bg-rose-600" : "bg-slate-800"
              }`}
            >
              {toast.text}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

/** 學習進度 + 即時 metrics（唔夠樣本時顯示原因，唔可以靜默） */
function LearnPanel({ result }: { result: LearnResult | null }) {
  if (!result) {
    return (
      <p className="mt-3 rounded-xl bg-slate-50 p-3 text-[11.5px] text-slate-500">
        繼續掃…（樣本越多，推斷越準）
      </p>
    );
  }
  if (!result.ok) {
    return (
      <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
        <div className="text-[12.5px] font-bold text-rose-800">推斷唔到</div>
        <p className="mt-1 text-[11.5px] text-rose-700">{result.reason}</p>
      </div>
    );
  }
  return null;
}

function emptyMetrics(): LearnMetrics {
  return {
    sampleCount: 0,
    distinctCodes: 0,
    medianIntervalMs: null,
    minIntervalMs: null,
    maxIntervalMs: null,
    suffix: "mixed",
    commonPrefix: "",
    prefixConfidence: "none",
    minLength: 0,
    maxLength: 0,
    allDigits: false,
    fixedLength: false,
  };
}
