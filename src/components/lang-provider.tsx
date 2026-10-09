"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DEFAULT_UI_LANG,
  htmlLangOf,
  lookup,
  normalizeUiLang,
  type UiLang,
} from "@/lib/i18n";
import { EN_DICT, SHORT_EN_DICT, SIDEBAR_EN_DICT } from "@/lib/i18n-dict-en";
import { SHORT_ZH_DICT, SIDEBAR_ZH_DICT, ZH_HANT_DICT } from "@/lib/i18n-dict-zh";
import { loadUiLang, saveUiLang } from "@/lib/ui-preference";

/**
 * UI 語言 Provider（第 1 層：顯示文案）。
 *
 * ## 點解用 `useSyncExternalStore` 而唔係 `useState`
 *
 * 語言值真相喺 `localStorage`（另一個「世界」）。`useState` 會令兩個副本脫節：
 * 同一頁有兩個 call site（例：`device-settings` 寫入、`app-sidebar` 讀取）就會唔一致。
 * `useSyncExternalStore` 保證**每次 render 都直接讀真相來源**，
 * 而且切換時所有 call site 必然一齊重繪 —— 唔可能出現半個 UI 英文、半個中文。
 *
 * ## 為咗唔會有首次閃爍
 *
 * ⚠️ Provider **唔可以有 loading 狀態**。
 * `layout.tsx` 已經用 `<ClientOnly>` 包住成個 app（`getServerSnapshot()` 回 `false`），
 * 所以 server 階段淨係出靜態 fallback，client 首次 render 就已經讀到本機語言。
 * 如果喺呢度加 gating，反而會自己製造閃爍。
 * `getServerSnapshot` 必須回 `DEFAULT_UI_LANG`（server 讀唔到 localStorage）。
 */

type LangContextValue = {
  lang: UiLang;
  setLang: (next: UiLang) => void;
  /** 翻譯函式：`t("已結帳")` → `"已結帳"` / `"Settled"` */
  t: (zh: string, vars?: Record<string, string | number>) => string;
  /**
   * 單字徽章翻譯（`short`）—— 用**獨立字典**。
   *
   * ⚠️ 英文冇「單字」對應，所以用 2–3 字母縮寫（`點`→`ORD`）。
   * 桌面側欄 `w-[72px]` 內容淨 56px、移動底欄 `min-w-[64px]` text-[11px]，
   * 所以縮寫**必須 ≤3 字母**（`i18n-dict-en.ts` 有註解）。
   */
  tShort: (zh: string) => string;
  /**
   * 側欄導航標籤翻譯 —— 用**另一本獨立字典**（2026-10-08）。
   *
   * 🔴 點解唔可以用 `t()`？—— 桌面側欄淨闊 56px（`w-[72px]` − `px-2` ×2），
   * `EN_DICT` 嘅 "Inventory"(9) / "Sold out"(8) / "Printing"(8) 放唔落，
   * J 實機截圖證實係**直接被裁走**（`Members` → `Member`）。
   * `tNav()` 嘅譯文全部收窄到 ≤6 字母。
   *
   * ⚠️ 唔好因為「英文好短」就還原返 `t()` ——
   * 同一個 `打印` 喺設置頁要顯示 "Printer settings"，喺側欄只需要 "Print"。
   */
  tNav: (zh: string) => string;
};

const LangContext = createContext<LangContextValue | null>(null);

/**
 * 訂閱 localStorage 變化。
 *
 * ⚠️ `storage` 事件**唔會喺同一個 document 內 fires**（只跨 tab）。
 * 所以「同一頁切換」靠 `setLang` 直接觸發 —— 我哋自己維護一個
 * module-level 版本號做 cache-buster，令所有 call site 必然重讀。
 */
let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 跨 tab 變化（例如另一個窗口改咗語言）
  const onStorage = (e: StorageEvent) => {
    if (e.key === "pos.uiLang") listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(): number {
  return version;
}

function getServerSnapshot(): number {
  return 0;
}

export function LangProvider({ children }: { children: ReactNode }) {
  const v = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- v係 cache-buster，故意依賴
  const lang = useMemo(() => normalizeUiLang(loadUiLang()), [v]);

  const setLang = useCallback((next: UiLang) => {
    saveUiLang(next);
    version += 1;
    // 通知所有 call site（同 tab）
    listeners.forEach((fn) => fn());
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLangOf(next);
    }
  }, []);

  /**
   * 🔴 首次載入就要同步 `<html lang>`（2026-10-07 補）。
   *
   * `layout.tsx` 嘅 `<html lang="zh-Hant">` 係 **server 預設值** ——
   * server 讀唔到本機 `localStorage`。如果本機上次揀咗英文，
   * 單靠 `setLang` 同步會令「refresh 頁面之後 `<html lang>` 變返 zh-Hant」，
   * 影響：CSS `:lang()`、瀏覽器內置翻譯提示、螢幕閱讀器發音。
   *
   * ⚠️ 喺 `useEffect` 做（唔係 render 期）：server render 唔應該改 DOM，
   * 而且 `<ClientOnly>` 已經令 server 階段淨係出靜態 fallback ⇒ 零閃爍。
   */
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLangOf(lang);
    }
  }, [lang]);

  const t = useCallback(
    (zh: string, vars?: Record<string, string | number>) => {
      const dict = lang === "en" ? EN_DICT : ZH_HANT_DICT;
      return lookup(dict, zh, vars);
    },
    [lang],
  );

  const tShort = useCallback(
    (zh: string) => {
      const dict = lang === "en" ? SHORT_EN_DICT : SHORT_ZH_DICT;
      return lookup(dict, zh);
    },
    [lang],
  );

  const tNav = useCallback(
    (zh: string) => {
      const dict = lang === "en" ? SIDEBAR_EN_DICT : SIDEBAR_ZH_DICT;
      return lookup(dict, zh);
    },
    [lang],
  );

  const value = useMemo(
    () => ({ lang, setLang, t, tShort, tNav }),
    [lang, setLang, t, tShort, tNav],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/**
 * 攞語言 context。
 *
 * ⚠️ 刻意**唔**提供「冇 provider 就 fallback 返預設」嘅靜默路徑 ——
 * 咁樣會令「忘記掛 provider」變成一個**冇 error、但全部顯示中文**嘅隱蔽 bug，
 * 跟 `pos-route-auth.ts` 同一個原則（寧願行到就要驗）。
 */
export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    throw new Error("useLang() 一定要喺 <LangProvider> 之內用");
  }
  return ctx;
}

/**
 * 只需要 `t` 嘅場合嘅便捷 hook（大部分組件淨係要翻譯）。
 */
export function useT(): LangContextValue["t"] {
  return useLang().t;
}

/** 單字徽章翻譯（`short`）。見 `LangContextValue.tShort`。 */
export function useTShort(): LangContextValue["tShort"] {
  return useLang().tShort;
}

/** 側欄導航標籤翻譯（≤6 字母版）。見 `LangContextValue.tNav`。 */
export function useTNav(): LangContextValue["tNav"] {
  return useLang().tNav;
}