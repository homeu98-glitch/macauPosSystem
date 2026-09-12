"use client";

/**
 * 掃碼槍輸入層（React hook）—— **只做接線**。
 *
 * 所有判斷邏輯喺 `barcode-scanner-core.ts`（純函式、有單測）。
 * 呢度淨係：綁 window keydown → 餵入狀態機 → 過濾 → 呼 callback。
 *
 * 🔴 **唔可以靠 `document.activeElement` 判斷**「係唔係掃碼」：
 * 店員喺搜尋框打字時焦點就係 input。分辨掃碼同人手打字**只可以用時間**
 * （`profile.timeoutMs`，預設 50ms）。見 docs/124 §2.6。
 *
 * 🔴 **`preventDefault` 只喺真正食咗一次條碼時才做** ——
 * 若對所有 keydown 都 preventDefault，會令搜尋框完全打唔到字。
 */

import { useEffect, useRef } from "react";

import { createBufferState, feedKey, isPlausibleCode, tickTimeout } from "@/lib/retail/barcode-scanner-core";
import type { ScanSample, ScannerProfile } from "@/lib/retail/types";

export interface UseBarcodeScannerOptions {
  /** 關掉就完全唔監聽（例如某啲頁面唔想搶鍵盤） */
  enabled?: boolean;
  profile: ScannerProfile;
  /** 一次掃描完成（已過 `isPlausibleCode` 過濾）→ 加商品入車 */
  onScan: (code: string, sample: ScanSample) => void;
  /**
   * 收到一串但唔合理（人手打字 / 雜訊）→ 可選，用嚟除錯。
   * ⚠️ **唔應該喺呢度出「條碼未登記」提示** —— 人手打字唔係錯誤。
   */
  onReject?: (code: string, profile: ScannerProfile) => void;
  /** 每個原始樣本（自動學習嚮導收集 3 次掃描用） */
  onSample?: (sample: ScanSample) => void;
  /** 真正食咗一次條碼時 preventDefault（預設 true），避免 Enter 觸發 form submit */
  preventDefault?: boolean;
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export function useBarcodeScanner(options: UseBarcodeScannerOptions): void {
  const { enabled = true, profile } = options;

  /** 緩衝狀態（唔放 state，避免每次按鍵都 re-render） */
  const bufferRef = useRef(createBufferState());
  /**
   * callback 一律經 ref 呼叫 —— 否則每次 render 都會因 callback identity 變化
   * 而重新綁 listener（掃碼槍高頻輸入時會明顯卡）。
   *
   * ⚠️ 同步一定要喺 `useEffect` 做，**唔可以喺 render 期間寫 `cbRef.current`**
   * （React 19 `react-hooks/refs` 會報 error：render 期間唔應該改 ref）。
   * 呢個 effect 排喺最前面 → listener 註冊之前 ref 已經係最新值。
   */
  const cbRef = useRef(options);
  useEffect(() => {
    cbRef.current = options;
  });

  const handleComplete = (code: string, sample: ScanSample): boolean => {
    const o = cbRef.current;
    o.onSample?.(sample);
    if (isPlausibleCode(code, o.profile)) {
      o.onScan(code, sample);
      return true;
    }
    o.onReject?.(code, o.profile);
    return false;
  };

  // ① keydown
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      const p = cbRef.current.profile;
      const t = now();
      let out = feedKey(bufferRef.current, e.key, t, p);
      let consumed = false;

      // timeout 完成 = 緩衝係上一串，今次嘅 key 屬於新一串 → 要重餵
      if (out.kind === "complete" && out.reason === "timeout") {
        consumed = handleComplete(out.code, out.sample) || consumed;
        out = feedKey(out.state, e.key, t, p);
      }

      bufferRef.current = out.state;

      if (out.kind === "complete") {
        consumed = handleComplete(out.code, out.sample) || consumed;
      }

      // 🔴 只有真正食咗條碼才 preventDefault（否則搜尋框打唔到字）
      if (consumed && (cbRef.current.preventDefault ?? true)) {
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);

  // ② 超時收尾（只對「無結尾字元」嘅型號有意義）
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (profile.suffix !== "none") return;

    const interval = Math.max(20, Math.round((profile.timeoutMs || 50) / 2));
    const id = window.setInterval(() => {
      const out = tickTimeout(bufferRef.current, now(), cbRef.current.profile);
      bufferRef.current = out.state;
      if (out.kind === "complete") handleComplete(out.code, out.sample);
    }, interval);
    return () => window.clearInterval(id);
  }, [enabled, profile.suffix, profile.timeoutMs]);

  // ③ 換 profile（例如設定頁改完）→ 清緩衝，避免用舊規則收尾
  useEffect(() => {
    bufferRef.current = createBufferState();
  }, [profile.id, profile.prefix, profile.suffix, profile.charset, profile.timeoutMs]);
}
