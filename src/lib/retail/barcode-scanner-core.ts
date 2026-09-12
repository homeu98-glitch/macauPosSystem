/**
 * 掃碼槍鍵盤緩衝狀態機 —— **純函式，零 runtime 依賴**。
 *
 * 【為何要抽出嚟】掃碼槍係「鍵盤 wedge」：佢扮鍵盤快速打一串字元。
 * React hook（`use-barcode-scanner.ts`）冇得用 `node --test` 測
 * （要 DOM / React），所以**所有判斷邏輯**放喺呢度，hook 只做接線。
 * 呢個係 repo 既有慣例（`kiosk-cart.ts` 就係由 `use-kiosk-order.ts` 抽出嚟嘅）。
 *
 * 【核心：用**時間**分辨掃碼與人手打字】
 *   掃碼槍每鍵 5–15ms，人手最快 ~150ms。所以用 `profile.timeoutMs`（預設 50ms）做界線。
 *
 * 🔴 **唔可以靠 `document.activeElement`** —— 店員喺搜尋框打字時焦點就係 input，
 * 靠焦點判斷會令人手打字被當成掃碼（實案：打「123」就彈「條碼未登記」）。
 */

import type { ScanSample, ScannerProfile } from "@/lib/retail/types";

export interface ScannerBufferState {
  /** 緩衝緊嘅字元（未剝前綴） */
  chars: string;
  /** 每個字元嘅 keydown 時間戳（單調遞增） */
  timestamps: number[];
  /** 最後一次按鍵時間 */
  lastAt: number;
}

export type ResetReason = "human-speed" | "too-long" | "bad-charset" | "empty-terminator";

export type KeyFeedOutcome =
  | { kind: "buffering"; state: ScannerBufferState }
  /**
   * 一次掃描完成。`state` 已經係**清空咗嘅新緩衝**。
   *
   * 🔴 呼叫端要按 `reason` 決定使唔使重餵今次嘅 `key`：
   *   - `reason === "timeout"` → **要重餵**（緩衝係上一串，今次嘅 key 屬於新一串）
   *   - `reason === "terminator"` → **唔好重餵**（結尾字元已經被消耗；重餵會變 `empty-terminator`）
   */
  | {
      kind: "complete";
      state: ScannerBufferState;
      code: string;
      sample: ScanSample;
      reason: "terminator" | "timeout";
    }
  | { kind: "reset"; state: ScannerBufferState; reason: ResetReason };

/** 冇設定時嘅長度上限（EAN-13 = 13、Code128 通常 < 32） */
export const DEFAULT_MAX_LENGTH = 32;

export function createBufferState(): ScannerBufferState {
  return { chars: "", timestamps: [], lastAt: 0 };
}

/** 收到嘅係唔係結尾字元 */
export function terminatorOf(key: string): "enter" | "tab" | null {
  if (key === "Enter") return "enter";
  if (key === "Tab") return "tab";
  return null;
}

/**
 * 係唔係「可以入緩衝嘅字元」。
 * - `keydown` 嘅 modifier / 方向鍵等係多字元名（`"Shift"`、`"ArrowLeft"`）→ 唔係
 * - 空白**唔算**：冇任何條碼符號體系會用空格，但人手打字經常打 → 收窄誤判面
 */
export function isPrintableKey(key: string): boolean {
  return typeof key === "string" && key.length === 1 && key !== " ";
}

/** 剝走設定咗嘅出廠前綴 */
export function stripPrefix(chars: string, profile: ScannerProfile): string {
  const p = profile.prefix ?? "";
  if (p && chars.startsWith(p)) return chars.slice(p.length);
  return chars;
}

/**
 * 呢個字元喺目前緩衝狀態下合唔合法。
 *
 * 有設前綴時，前綴本身嘅字元要放行（例如前綴 `~`，第一個字元就會係 `~`），
 * 否則前綴永遠入唔到緩衝，剝前綴就無從談起。
 */
export function isAllowedChar(chars: string, ch: string, profile: ScannerProfile): boolean {
  const prefix = profile.prefix ?? "";
  if (prefix && chars.length < prefix.length && prefix[chars.length] === ch) return true;
  if (profile.charset === "alnum") return /[0-9A-Za-z]/.test(ch);
  return /[0-9]/.test(ch);
}

function buildSample(state: ScannerBufferState, terminatedBy: ScanSample["terminatedBy"]): ScanSample {
  return { keyTimestamps: [...state.timestamps], chars: state.chars, terminatedBy };
}

function completeWith(
  state: ScannerBufferState,
  profile: ScannerProfile,
  reason: "terminator" | "timeout",
  terminatedBy: ScanSample["terminatedBy"],
): KeyFeedOutcome {
  return {
    kind: "complete",
    state: createBufferState(),
    code: stripPrefix(state.chars, profile),
    sample: buildSample(state, terminatedBy),
    reason,
  };
}

/**
 * 餵一個 `keydown` 入去。
 *
 * @param now `performance.now()` 或 `Date.now()`（只要有單調性同毫秒單位就得）
 */
export function feedKey(
  state: ScannerBufferState,
  key: string,
  now: number,
  profile: ScannerProfile,
): KeyFeedOutcome {
  const timeout = Number.isFinite(profile.timeoutMs) ? profile.timeoutMs : 50;

  // ① 結尾字元
  const term = terminatorOf(key);
  if (term) {
    if (state.chars === "") return { kind: "reset", state: createBufferState(), reason: "empty-terminator" };
    return completeWith(state, profile, "terminator", term);
  }

  // ② 唔係可打印字元 → 完全忽略（唔應該清緩衝：掃碼中途唔會夾 Shift）
  if (!isPrintableKey(key)) return { kind: "buffering", state };

  // ③ 同上一鍵相隔太耐
  // ⚠️ 條件用 `timestamps.length`，唔可以用 `lastAt > 0` ——
  // 若第一個字元嘅時間戳剛好係 0（測試 / 頁面啱啱載入），`lastAt > 0` 會永遠 false，
  // 令之後每一鍵都跳過間隔檢查 → 人手打字會被當成掃碼。
  if (state.chars !== "" && state.timestamps.length > 0) {
    const gap = now - state.lastAt;
    if (gap > timeout) {
      if (profile.suffix === "none") {
        // 靠超時收尾嘅型號：上一串就係完整條碼，今次嘅 key 屬於新一串
        return completeWith(state, profile, "timeout", "none");
      }
      // 其他型號：上一串唔似掃碼（太慢）→ 掉棄，由今次嘅 key 重新開始
      return { kind: "reset", state: { chars: key, timestamps: [now], lastAt: now }, reason: "human-speed" };
    }
  }

  // ④ 太長 → 唔係條碼
  // ⚠️ 長度以**剝走前綴之後**嘅條碼為準（`learnProfile()` 亦係噉量）。
  // 用含前綴嘅長度比會令有前綴嘅槍永遠多一位 → 成 13 位條碼被誤判「太長」。
  const maxLength = profile.maxLength ?? DEFAULT_MAX_LENGTH;
  const prefixLen = (profile.prefix ?? "").length;
  const strippedLen = state.chars.startsWith(profile.prefix ?? "")
    ? state.chars.length - prefixLen
    : state.chars.length;
  if (strippedLen >= maxLength) {
    return { kind: "reset", state: createBufferState(), reason: "too-long" };
  }

  // ⑤ 字元唔啱字元集（例如設定純數字但打咗字母）→ 人手打字
  if (!isAllowedChar(state.chars, key, profile)) {
    return { kind: "reset", state: createBufferState(), reason: "bad-charset" };
  }

  // ⑥ 入緩衝
  return {
    kind: "buffering",
    state: {
      chars: state.chars + key,
      timestamps: [...state.timestamps, now],
      lastAt: now,
    },
  };
}

/**
 * 超時檢查（畀 hook 用 timer 週期呼）。
 *
 * **只對 `suffix === "none"` 有意義** —— 其他型號有結尾字元，超時只會被 `feedKey` 當成
 * 人手打字處理。所以其他型號直接回 `buffering`，避免「打咗一半嘅單號自動送出」。
 */
export function tickTimeout(
  state: ScannerBufferState,
  now: number,
  profile: ScannerProfile,
): KeyFeedOutcome {
  if (state.chars === "") return { kind: "buffering", state };
  if (profile.suffix !== "none") return { kind: "buffering", state };
  const timeout = Number.isFinite(profile.timeoutMs) ? profile.timeoutMs : 50;
  if (now - state.lastAt <= timeout) return { kind: "buffering", state };
  return completeWith(state, profile, "timeout", "none");
}

/** 最短合理條碼長度（太短嘅「完成」多數係雜訊；呼叫端可用嚟過濾） */
export function isPlausibleCode(code: string, profile: ScannerProfile): boolean {
  const min = profile.minLength ?? 6;
  const max = profile.maxLength ?? DEFAULT_MAX_LENGTH;
  if (code.length < min || code.length > max) return false;
  if (profile.charset === "alnum") return /^[0-9A-Za-z]+$/.test(code);
  return /^[0-9]+$/.test(code);
}
