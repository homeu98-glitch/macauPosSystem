/**
 * 掃碼槍型號庫 + 自動學習嚮導 —— **純函式，零 runtime 依賴**。
 *
 * 【為何唔可以照抄打印機嘅做法】打印機靠 Companion 用 node-usb 讀到 **VID/PID**
 * （`print-bridge/companion.ts:553`）→ 對照型號庫。但**純瀏覽器 HID 掃碼槍讀唔到型號**
 * （瀏覽器冇 USB descriptor API，WebHID 亦唔支援 Safari）→ 只能由**實際輸入特徵**反推。
 *
 * 所以分兩層：
 *   ① 經 Companion / Android 代理 → `resolveScannerMeta(vid, pid)` 真型號配對
 *      （USB-IF 嘅 **VID 係公司級 ID**，所以同一廠商嘅掃碼槍通常同打印機共用 VID；
 *       PID 先係產品級 → `models` 表要由**實機枚舉**收集，唔可以靠猜）
 *   ② 純瀏覽器 → `learnProfile(samples)` 自動學習
 *
 * 🔴 **本檔唔可以寫死任何未經實機確認嘅 VID/PID。** 未確認嘅品牌
 * 一律 `knownVids: []`（唔會自動配對，但會出現喺手動清單畀商家揀）。
 */

import type {
  ScanSample,
  ScannerModelOption,
  ScannerProfile,
  ScannerSuffix,
} from "@/lib/retail/types";

/** 掃碼槍每鍵間隔上限（ms）：比呢個慢就當唔係掃碼槍 */
export const SCANNER_INTERVAL_MS = 30;
/** 人手打字每鍵間隔下限（ms）：比呢個快就唔似人手 */
export const HUMAN_INTERVAL_MS = 120;
/** 預設超時閾值：喺 ScannerProfile 缺省時用 */
export const DEFAULT_TIMEOUT_MS = 50;
/** 超時閾值嘅合法範圍（太細會切斷慢速掃描，太大會將人手打字當成掃碼） */
export const MIN_TIMEOUT_MS = 30;
export const MAX_TIMEOUT_MS = 150;

/** 型號 / 品牌共用嘅出廠預設（唔含 id / name / source） */
export type ScannerBehavior = Omit<ScannerProfile, "id" | "name" | "source">;

export const DEFAULT_BEHAVIOR: ScannerBehavior = {
  suffix: "enter",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  charset: "digits",
};

export interface ScannerVendorMeta {
  brand: string;
  /**
   * 已知 VID（USB-IF 公司 ID，`0xXXXX` 大寫十六進制）。
   * **空陣列 = 未經實機確認** → 唔會自動配對，只會出現喺手動型號清單。
   */
  knownVids: string[];
  /** 品牌常見出廠預設（該品牌大多數機型共用） */
  defaultProfile: ScannerBehavior;
  /** PID → 型號專屬覆寫（PID 表要由實機枚舉收集） */
  models: Record<string, { model: string; profile?: Partial<ScannerBehavior> }>;
}

/** 已標示用途嘅常見出廠行為 preset（手動揀型號用，唔綁 VID） */
export const SCANNER_BEHAVIOR_PRESETS: Array<{ id: string; name: string; behavior: ScannerBehavior }> = [
  {
    id: "std-enter-13",
    name: "標準：無前綴 · Enter 結尾 · 13 位",
    behavior: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, minLength: 8, maxLength: 13, charset: "digits" },
  },
  {
    id: "no-suffix",
    name: "無結尾字元（靠超時收尾）",
    behavior: { suffix: "none", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
  },
  {
    id: "tab-suffix",
    name: "Tab 結尾（部分型號出廠）",
    behavior: { suffix: "tab", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
  },
  {
    id: "prefix-tilde",
    name: "帶 `~` 前綴（部分國產型號出廠）",
    behavior: { prefix: "~", suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
  },
  {
    id: "prefix-percent",
    name: "帶 `%` 前綴",
    behavior: { prefix: "%", suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
  },
  {
    id: "alnum",
    name: "字母數字（內部編碼 / 二維碼槍）",
    behavior: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "alnum" },
  },
];

/**
 * 廠商 → 型號庫。
 *
 * ⚠️ `knownVids` 只列**本專案已經喺實機確認過**嘅 VID（來源：`print-bridge/printer-models.ts`
 * 嘅 `USB_PRINTER_DB` —— VID 係公司級，同一廠商嘅掃碼槍共用同一個 VID）。
 * 未確認嘅品牌（漢印 / 得力 / 快麥 / Honeywell / 新大陸 / 民德 …）刻意留空：
 * **寧可唔自動配對，都唔可以寫錯 VID 造成配錯型號**。
 */
export const SCANNER_VENDORS: ScannerVendorMeta[] = [
  {
    brand: "佳博 Gprinter",
    knownVids: ["0x0416", "0x1A03"],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "芯燁 Xprinter",
    knownVids: ["0x0483"],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "容大 Rongta",
    knownVids: ["0x2BDF"],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "台半 TSC",
    knownVids: ["0x1203"],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "斑馬 Zebra",
    knownVids: ["0x0A5F"],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "alnum" },
    models: {},
  },
  {
    brand: "立象 Argox",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "漢印 HPRT",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "得力 Deli",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "快麥 KuaiMai",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "霍尼韋爾 Honeywell",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "alnum" },
    models: {},
  },
  {
    brand: "新大陸 Newland",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "alnum" },
    models: {},
  },
  {
    brand: "民德 MINDEO",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "alnum" },
    models: {},
  },
  {
    brand: "優庫 UROVO",
    knownVids: [],
    defaultProfile: { suffix: "enter", timeoutMs: DEFAULT_TIMEOUT_MS, charset: "digits" },
    models: {},
  },
  {
    brand: "通用 HID 掃碼槍",
    knownVids: [],
    defaultProfile: { ...DEFAULT_BEHAVIOR },
    models: {},
  },
];

/** 將各種格式嘅 VID/PID 歸一化為 `0xXXXX` 大寫十六進制（同 printer-models.ts 同一口徑） */
export function toHexId(raw: string | number | undefined | null): string {
  if (raw == null) return "";
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else {
    const s = String(raw).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) n = parseInt(s, 16);
    else if (/^\d+$/.test(s)) n = parseInt(s, 10);
    else return "";
  }
  if (!Number.isFinite(n) || n <= 0) return "";
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

/** VID → 廠商（由 SCANNER_VENDORS 派生） */
export function buildVendorIndex(
  vendors: readonly ScannerVendorMeta[] = SCANNER_VENDORS,
): Map<string, ScannerVendorMeta> {
  const m = new Map<string, ScannerVendorMeta>();
  for (const v of vendors) {
    for (const raw of v.knownVids) {
      const vid = toHexId(raw);
      // 先入者為準：唔覆寫（同一 VID 撞兩個品牌 = 資料有錯，唔應該靜默改邊個贏）
      if (vid && !m.has(vid)) m.set(vid, v);
    }
  }
  return m;
}

export interface ResolvedScannerMeta {
  brand: string;
  model: string;
  profile: ScannerBehavior;
  /** true = 只認到品牌（用品牌預設）；false = VID/PID 精確命中型號 */
  generic: boolean;
}

/**
 * 由 VID/PID 解析型號預設。**未命中任何已知 VID 回 `null`**
 * （= 認唔到，應該回落自動學習，而唔係亂套一個預設）。
 */
export function resolveScannerMeta(
  vendorId: string | number | undefined | null,
  productId: string | number | undefined | null,
): ResolvedScannerMeta | null {
  const vid = toHexId(vendorId);
  if (!vid) return null;
  const vendor = buildVendorIndex().get(vid);
  if (!vendor) return null;

  const pid = toHexId(productId);
  const model = pid ? vendor.models[pid] : undefined;
  if (model) {
    return {
      brand: vendor.brand,
      model: model.model,
      profile: { ...vendor.defaultProfile, ...(model.profile ?? {}) },
      generic: false,
    };
  }
  return {
    brand: vendor.brand,
    model: vendor.brand,
    profile: { ...vendor.defaultProfile },
    generic: true,
  };
}

/** 手動揀型號用嘅扁平清單（品牌 × 行為 preset + 通用兜底） */
export function getScannerModelOptions(): ScannerModelOption[] {
  const out: ScannerModelOption[] = [];
  for (const v of SCANNER_VENDORS) {
    for (const preset of SCANNER_BEHAVIOR_PRESETS) {
      out.push({
        brand: v.brand,
        model: preset.name,
        profile: { ...v.defaultProfile, ...preset.behavior },
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 自動學習
// ─────────────────────────────────────────────────────────────

/** 一次掃描嘅每鍵間隔（ms） */
export function intervalsOf(sample: ScanSample): number[] {
  const ts = sample.keyTimestamps ?? [];
  const out: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (Number.isFinite(d) && d >= 0) out.push(d);
  }
  return out;
}

/** 中位數（空陣列 → null）。用中位數唔用平均：一次卡頓唔應該拉高整體判斷。 */
export function median(nums: readonly number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  const v = arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  return Math.round(v * 10) / 10;
}

/** 最長共同前綴（空陣列 / 單一字串 → ""；單一字串無法分離前綴） */
export function commonPrefixOf(strings: readonly string[]): string {
  const list = (strings ?? []).filter((s) => typeof s === "string");
  if (list.length < 2) return "";
  let prefix = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** 純符號（無數字亦無字母） */
const PUNCT_ONLY = /^[^0-9A-Za-z]*$/;

export type PrefixConfidence = "high" | "low" | "none";

/**
 * 由幾個唔同條碼抽出**裝置前綴**。
 *
 * 🔴 呢度有個實務陷阱：如果掃嘅幾件商品條碼本身就開頭相同（同一廠商 / 同一代理），
 * 共同前綴會包含**條碼本身嘅前綴**而唔係裝置前綴。
 *
 * 判斷規則：
 *   - 共同前綴嘅**開頭連續非數字部分**（例如 `~`、`%`、`#`、`ABC`）→ 當係裝置前綴。
 *     - 純符號 → `confidence: "high"`（掃碼槍出廠前綴幾乎一定係符號）
 *     - 含字母 → `confidence: "low"`（有可能只係條碼本身共用嘅開頭，要商家喺測試框確認）
 *   - 共同前綴**一開始就係數字** → 分唔清 → `prefix: ""` + `confidence: "none"`，
 *     **唔會亂剝**（剝錯會令所有條碼都對唔中商品）。
 */
export function extractPrefix(strings: readonly string[]): {
  prefix: string;
  confidence: PrefixConfidence;
} {
  const common = commonPrefixOf(strings);
  if (!common) return { prefix: "", confidence: "none" };
  const m = common.match(/^[^0-9]*/);
  const lead = m ? m[0] : "";
  if (!lead) return { prefix: "", confidence: "none" };
  return { prefix: lead, confidence: PUNCT_ONLY.test(lead) ? "high" : "low" };
}

const clampTimeout = (ms: number) =>
  Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));

export interface LearnMetrics {
  sampleCount: number;
  distinctCodes: number;
  medianIntervalMs: number | null;
  minIntervalMs: number | null;
  maxIntervalMs: number | null;
  /** 三個樣本一致嘅結尾字元；唔一致 = "mixed" */
  suffix: ScannerSuffix | "mixed";
  /** 共同前綴（只有掃過唔同條碼才判斷得到） */
  commonPrefix: string;
  /** 前綴可信度：high = 純符號（幾乎一定係裝置前綴）；low = 含字母（要商家確認）；none = 判斷唔到 */
  prefixConfidence: PrefixConfidence;
  /** 去掉前綴後嘅最短 / 最長條碼長度 */
  minLength: number;
  maxLength: number;
  /** 條碼內容係咪全部純數字 */
  allDigits: boolean;
  /** 每個樣本嘅（去前綴後）長度係咪一致 */
  fixedLength: boolean;
}

export type LearnResult =
  | { ok: true; profile: ScannerProfile; metrics: LearnMetrics; warnings: string[] }
  | { ok: false; reason: string; metrics: LearnMetrics; warnings: string[] };

const EMPTY_METRICS: LearnMetrics = {
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

/**
 * 由實際掃描樣本推斷掃碼槍設定。
 *
 * 【⚠️ 一定要掃**唔同嘅**條碼】
 * 若三次都掃同一個條碼，共同前綴會等於**整個條碼**，無法分離出裝置前綴。
 * 呢個情況會 `ok: true` 但 `prefix: undefined` + 出一條 warning 提示再掃唔同商品。
 *
 * 【判斷邏輯】
 *   - 速度：用全部樣本嘅每鍵間隔**中位數**。> `HUMAN_INTERVAL_MS` → 判定唔係掃碼槍，
 *     `ok: false`（唔可以硬套一個 profile 落去，否則之後人手打字會被當成掃碼）。
 *   - 超時：`中位數 × 5`，夾喺 [30, 150]。中位數 8ms → 40ms（掃碼中途卡頓都唔會斷）。
 *   - 結尾：三個樣本一致才採用；唔一致 → 用 `none`（靠超時收尾，最安全）＋ warning。
 *   - 前綴：只有 ≥2 個**唔同**條碼時才算，否則留空 ＋ warning。
 */
export function learnProfile(
  samples: readonly ScanSample[],
  opts: { id?: string; name?: string } = {},
): LearnResult {
  const warnings: string[] = [];
  const valid = (samples ?? []).filter(
    (s) => s && typeof s.chars === "string" && s.chars.length > 0 && (s.keyTimestamps?.length ?? 0) >= 2,
  );

  if (valid.length < 2) {
    return {
      ok: false,
      reason: `至少要掃 2 次（而家 ${valid.length} 次）才推斷得到輸入速度`,
      metrics: { ...EMPTY_METRICS, sampleCount: valid.length },
      warnings,
    };
  }

  const allIntervals = valid.flatMap(intervalsOf);
  const med = median(allIntervals);
  const minI = allIntervals.length ? Math.min(...allIntervals) : null;
  const maxI = allIntervals.length ? Math.max(...allIntervals) : null;

  const distinct = Array.from(new Set(valid.map((s) => s.chars)));
  const { prefix, confidence: prefixConfidence } = extractPrefix(distinct);
  const stripped = valid.map((s) => (prefix && s.chars.startsWith(prefix) ? s.chars.slice(prefix.length) : s.chars));
  const lengths = stripped.map((s) => s.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);

  const suffixCounts = new Map<ScannerSuffix, number>();
  for (const s of valid) {
    const k: ScannerSuffix = s.terminatedBy ?? "none";
    suffixCounts.set(k, (suffixCounts.get(k) ?? 0) + 1);
  }
  const suffixValues = Array.from(suffixCounts.keys());
  const suffixConsistent = suffixValues.length === 1;
  const suffix: ScannerSuffix = suffixConsistent ? suffixValues[0] : "none";

  const metrics: LearnMetrics = {
    sampleCount: valid.length,
    distinctCodes: distinct.length,
    medianIntervalMs: med,
    minIntervalMs: minI,
    maxIntervalMs: maxI,
    suffix: suffixConsistent ? suffixValues[0] : "mixed",
    commonPrefix: prefix,
    prefixConfidence,
    minLength: minLen,
    maxLength: maxLen,
    allDigits: stripped.every((s) => /^[0-9]+$/.test(s)),
    fixedLength: minLen === maxLen,
  };

  if (med === null) {
    return { ok: false, reason: "量唔到按鍵間隔（樣本時間戳有問題）", metrics, warnings };
  }
  if (med > HUMAN_INTERVAL_MS) {
    return {
      ok: false,
      reason: `按鍵間隔中位數 ${med}ms 似人手打字（掃碼槍一般 <${SCANNER_INTERVAL_MS}ms）。請用掃碼槍再試。`,
      metrics,
      warnings,
    };
  }

  if (distinct.length < 2) {
    warnings.push("幾次都係同一個條碼 → 判斷唔到前綴。建議掃 3 件唔同商品再試。");
  } else if (prefixConfidence === "none") {
    warnings.push(
      "偵測唔到裝置前綴。若掃碼槍出廠有加前綴（例如 ~ % #），請掃 3 件**開頭字元唔同**嘅商品再試。",
    );
  } else if (prefixConfidence === "low") {
    warnings.push(
      `偵測到前綴「${prefix}」但佢含字母 → 有可能只係條碼本身共用嘅開頭。請喺下面測試框確認。`,
    );
  }
  if (!suffixConsistent) {
    warnings.push("結尾字元唔一致 → 已改用「無結尾（靠超時收尾）」，最穩陣。");
  }
  if (maxLen - minLen > 8) {
    warnings.push(`條碼長度差別好大（${minLen}–${maxLen} 位），建議再掃多幾件確認。`);
  }
  if (!metrics.allDigits) {
    warnings.push("條碼含非數字字元 → 字元集設為「字母數字」。");
  }

  const profile: ScannerProfile = {
    id: opts.id ?? "auto-learned",
    name: opts.name ?? "自動學習",
    prefix: prefix || undefined,
    suffix,
    timeoutMs: clampTimeout(med * 5),
    minLength: minLen,
    maxLength: maxLen,
    charset: metrics.allDigits ? "digits" : "alnum",
    source: "auto-learn",
  };

  return { ok: true, profile, metrics, warnings };
}

/** 由手動揀嘅型號 / preset 建立 profile */
export function profileFromBehavior(
  behavior: ScannerBehavior,
  opts: { id: string; name: string },
): ScannerProfile {
  return {
    id: opts.id,
    name: opts.name,
    prefix: behavior.prefix,
    suffix: behavior.suffix ?? "enter",
    timeoutMs: clampTimeout(behavior.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    minLength: behavior.minLength,
    maxLength: behavior.maxLength,
    charset: behavior.charset ?? "digits",
    source: "model-db",
  };
}

/** 建立一個安全嘅預設 profile（未做任何設定時用） */
export function defaultScannerProfile(): ScannerProfile {
  return {
    id: "default",
    name: "預設（自動學習前）",
    suffix: "enter",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    charset: "digits",
    source: "manual",
  };
}

/** 顯示用：結尾字元講人話 */
export function describeSuffix(suffix: ScannerSuffix | "mixed"): string {
  if (suffix === "enter") return "Enter";
  if (suffix === "tab") return "Tab";
  if (suffix === "none") return "無（靠超時收尾）";
  return "唔一致";
}
