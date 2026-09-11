#!/usr/bin/env node
/**
 * 無瀏覽器煙霧測試：跑一個單檔 HTML 原型嘅內嵌 <script>，驗證 render 產出冇問題。
 *
 * 用法：
 *   node dom-smoke-test.js path/to/mockup.html [--expect "cls1,cls2,..."] [--debug]
 *
 * 為何需要：純 HTML 標籤配對檢查同 `node --check` 都捉唔到
 * 「字串模板漏插值 → 畫面出 undefined / NaN / [object Object]」呢類錯，
 * 亦捉唔到「render() 一跑就拋錯」或「頁籤切換後畫面根本冇 render」。
 *
 * 原理（唔需要 jsdom）：
 *   1. 用迷你索引器掃靜態 HTML，紀錄每個元素嘅 tag / class / 屬性 / **父元素**。
 *   2. 在索引上實現 document.querySelector(All)，支援 tag、.class、#id、[attr]、
 *      後代組合（`.a .b button.on`）。⚠️ 後代關係一定要做 —— 只比對最後一截嘅話，
 *      `.review .tabs button` 會 match 到全頁所有 button，令事件 handler 互相覆蓋。
 *   3. 真跑內嵌 script，捕捉所有 innerHTML 賦值。
 *   4. 逐個呼叫帶 `data-tab` 屬性嘅元素上嘅 onclick（頁籤切換），令每個畫面都 render 一次。
 *   5. 掃描捕捉到嘅 HTML 有無 undefined / NaN / [object Object]，並檢查預期 class、
 *      CSS 有無 @media（審稿稿大忌）、<div> 有無配對。
 *
 * 退出碼：0 = 全綠，1 = 有失敗，2 = 用法／檔案問題。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const file = argv[0];
if (!file) {
  console.error("用法：node dom-smoke-test.js <mockup.html> [--expect cls1,cls2] [--expect-static cls] [--drive sel]... [--debug]");
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const EXPECT = opt("--expect", "").split(",").map((s) => s.trim()).filter(Boolean);
/** 靜態 HTML 就應該有嘅 class（同 --expect 唔同：唔係 render 出嚟嘅） */
const EXPECT_STATIC = opt("--expect-static", "").split(",").map((s) => s.trim()).filter(Boolean);
const DEBUG = argv.includes("--debug");

/** git-bash / MSYS 會將 C:////x 寫成 /c/x；喺 Windows 上要還原返，否則 path.resolve 會變 C:////c////x */
function normalizePath(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(String(p));
  if (process.platform === "win32" && m) return m[1] + ":/" + m[2];
  return p;
}
const html = fs.readFileSync(path.resolve(normalizePath(file)), "utf8");
const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error("✘ 搵唔到 <script> 區塊"); process.exit(2); }
const code = scriptMatch[1];

/* 只索引 <script> 之前嘅靜態 HTML —— script 內嘅模板字串唔係真 DOM */
const scriptStart = html.indexOf("<script");
const staticHtml = scriptStart > 0 ? html.slice(0, scriptStart) : html;

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

/* ══════════ 1) 迷你 HTML 索引器（帶父子關係） ══════════ */
const VOID_TAGS = new Set(["br","hr","img","input","meta","link","source","area","base","col","embed","track","wbr"]);
const IGNORED_TAGS = new Set(["html","head","body","meta","link","title","style","script"]);
const ELS = [];

(function indexElements(src) {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(src))) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (ELS[stack[i]].tag === tag) { stack.length = i; break; }
      }
      continue;
    }

    const attrs = {};
    const aRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;
    let a;
    while ((a = aRe.exec(m[3]))) {
      const k = (a[1] || a[3] || "").toLowerCase();
      if (k) attrs[k] = a[2] !== undefined ? a[2] : a[4];
    }

    const selfClosed = /\/\s*$/.test(m[3]);
    ELS.push({
      tag,
      attrs,
      id: attrs.id || "",
      classes: (attrs.class || "").split(/\s+/).filter(Boolean),
      parent: stack.length ? stack[stack.length - 1] : -1,
      ignored: IGNORED_TAGS.has(tag),
    });
    if (!VOID_TAGS.has(tag) && !selfClosed) stack.push(ELS.length - 1);
  }
})(staticHtml);

/* ══════════ 2) 選擇器比對 ══════════ */
function matchCompound(idx, tokRaw) {
  const tok = tokRaw.trim();
  if (!tok) return false;
  const el = ELS[idx];
  if (el.ignored) return false;

  /* 屬性：[attr] 或 [attr="v"] */
  const aRe = /\[([^\]^$*+?(){}|\\]+?)\]/g;
  let am;
  while ((am = aRe.exec(tok))) {
    const inner = am[1];
    const eq = inner.indexOf("=");
    const k = (eq >= 0 ? inner.slice(0, eq) : inner).trim().toLowerCase();
    const v = eq >= 0 ? inner.slice(eq + 1).trim().replace(/^["']|["']$/g, "") : null;
    const actual = el.attrs[k];
    if (actual === undefined) return false;
    if (v !== null && actual !== v) return false;
  }
  const rest = tok.replace(aRe, "");

  const idM = rest.match(/#([\w-]+)/);
  if (idM && el.id !== idM[1]) return false;

  /* ⚠️ class 讀 stub 嘅即時集合（render() 會 classList.toggle 切頁籤），
     唔可以讀靜態 HTML 嗰份，否則查 `.on` 永遠指住最初嗰粒掣。 */
  const cls = (rest.match(/\.([\w-]+)/g) || []).map((s) => s.slice(1));
  if (cls.length) {
    const live = stubFor(idx)._cls;
    if (cls.some((c) => !live.has(c))) return false;
  }

  const tagM = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagM && el.tag !== tagM[0].toLowerCase()) return false;

  return Boolean(idM || cls.length || tagM);
}

/* 後代組合：由右至左逐段喺祖先鏈上消耗 */
function matchChain(idx, parts) {
  if (!matchCompound(idx, parts[parts.length - 1])) return false;
  let pi = parts.length - 2;
  let cur = ELS[idx].parent;
  while (pi >= 0 && cur >= 0) {
    if (matchCompound(cur, parts[pi])) pi--;
    cur = ELS[cur].parent;
  }
  return pi < 0;
}

const stubCache = new Map();
function stubFor(i) {
  if (!stubCache.has(i)) stubCache.set(i, mkEl(i));
  return stubCache.get(i);
}
function queryAll(sel) {
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const out = [];
  ELS.forEach((e, i) => { if (matchChain(i, parts)) out.push(stubFor(i)); });
  return out;
}

/* ══════════ 3) DOM stub ══════════ */
const captured = [];
let autoId = 0;

function mkEl(indexOrId) {
  const isIndex = typeof indexOrId === "number";
  const src = isIndex ? ELS[indexOrId] : null;
  const el = {
    _key: isIndex ? `${src.tag}${src.id ? "#" + src.id : ""}[${indexOrId}]` : String(indexOrId),
    _html: "",
    textContent: "",
    style: {},
    _cls: new Set(src ? src.classes : []),
    _attrs: Object.assign({}, src ? src.attrs : {}),
    children: [],
    classList: {
      add: (c) => { el._cls.add(c); },
      remove: (c) => { el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !el._cls.has(c) : !!force;
        if (on) el._cls.add(c); else el._cls.delete(c);
        return on;
      },
    },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); captured.push({ key: el._key, html: el._html }); },
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    addEventListener() {},
    querySelectorAll: (sel) => queryAll(sel),
    querySelector: (sel) => queryAll(sel)[0] || mkEl("auto" + (++autoId)),
  };
  return el;
}

const idRegistry = new Map();
const byId = (id) => {
  const key = String(id);
  if (!idRegistry.has(key)) {
    const idx = ELS.findIndex((e) => e.id === key);
    idRegistry.set(key, idx >= 0 ? stubFor(idx) : mkEl("id:" + key));
  }
  return idRegistry.get(key);
};

global.document = {
  getElementById: byId,
  querySelectorAll: (sel) => queryAll(sel),
  querySelector: (sel) => queryAll(sel)[0] || mkEl("auto" + (++autoId)),
  createElement: () => mkEl("new" + (++autoId)),
  addEventListener() {},
  get body() { return byId("__body__"); },
};
global.window = { addEventListener() {} };
global.setInterval = () => 0;
global.setTimeout = () => 0;
global.clearInterval = () => {};
global.clearTimeout = () => {};
global.requestAnimationFrame = () => 0;

/* ══════════ 4) 跑 ══════════ */
try {
  // eslint-disable-next-line no-eval
  eval(code);
} catch (e) {
  console.log("① *** 執行期拋錯 ***");
  console.log(e && e.stack);
  process.exit(1);
}
console.log("① 執行期冇拋錯 ✔");

/* ══════════ 5) 先「驅動」流程（可選），再逐個頁籤重跑 ══════════
   --drive ".pcard" 之類：有啲畫面係**有閘**嘅（例如未揀崗位唔准入後廚屏），
   唔先撳吓就永遠 render 唔到目標畫面，會出現假失敗。
   可以重複傳多個 --drive，依序撳。
   ⚠️ 一定要用 ELS 嘅 index 去 stubFor()，唔可以 ELS.indexOf(stub)—— stub 唔係 ELS 嘅元素。 */
const drives = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--drive" && process.argv[i + 1]) drives.push(process.argv[i + 1]);
}
function driveSel(sel) {
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
  let n = 0;
  ELS.forEach((e, i) => {
    if (!matchChain(i, parts)) return;
    const s = stubFor(i);
    if (typeof s.onclick !== "function") return;
    try { s.onclick(); n++; }
    catch (err) { failures.push(`驅動 ${sel} 時拋錯：${err && err.message}`); }
  });
  return n;
}
for (const sel of drives) {
  const n = driveSel(sel);
  if (!n) failures.push(`驅動 "${sel}" 撳唔到（搵唔到有 onclick 嘅元素）`);
  else console.log(`   （已驅動 ${sel} × ${n}）`);
}

const tabIdx = ELS.map((e, i) => i).filter((i) => ELS[i].attrs["data-tab"] !== undefined && !ELS[i].ignored);
let tabRuns = 0;
for (const i of tabIdx) {
  const s = stubFor(i);
  if (typeof s.onclick !== "function") continue;
  try {
    s.onclick(); tabRuns++;
    /* 頁籤閘：如果撳完頁籤仍然入唔到目標畫面（例如未揀崗位就被彈返），
       自動補一次 drive，令每個頁籤都真正 render 到。 */
    for (const sel of drives) driveSel(sel);
  }
  catch (err) { failures.push(`切換頁籤 ${JSON.stringify(ELS[i].attrs["data-tab"])} 時拋錯：${err && err.message}`); }
}
if (tabIdx.length) console.log(`   （已重跑 ${tabRuns}/${tabIdx.length} 個頁籤）`);

const pool = captured.map((c) => c.html).join("\n");
check(pool.length > 0, "完全冇捕捉到任何 render 輸出（script 可能冇跑 render）");
check(tabIdx.length === 0 || tabRuns > 0, "所有頁籤嘅 onclick 都冇掛上（事件綁定可能失效）");

const BAD = ["undefined", "NaN", "[object Object]"];
for (const bad of BAD) check(!pool.includes(bad), `render 出嘅 HTML 含有 "${bad}"`);
if (!failures.some((f) => f.includes("含有"))) {
  console.log("② render HTML 無 undefined / NaN / [object Object] ✔");
}

for (const cls of EXPECT) check(pool.includes(cls), `冇出預期嘅 "${cls}"`);
if (EXPECT.length && !failures.some((f) => f.includes("預期"))) {
  console.log(`③ 預期 class 齊全（${EXPECT.join(", ")}）✔`);
}

/* --expect-static：檢查**靜態** HTML 就有嘅 class。
   ⚠️ `--expect` 只會掃 render 出嚟嘅 innerHTML，靜態 markup 永遠掃唔到
   （例如崗位鎖定徽章 `.lock` 係寫死喺 HTML、只改 textContent，就唔會出現喺 pool）。 */
for (const cls of EXPECT_STATIC) check(staticHtml.includes(cls), `靜態 HTML 冇預期嘅 "${cls}"`);
if (EXPECT_STATIC.length && !failures.some((f) => f.includes("靜態"))) {
  console.log(`③b 靜態 class 齊全（${EXPECT_STATIC.join(", ")}）✔`);
}

/* ══════════ 6) 靜態體檢 ══════════ */
const styleText = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || [])
  .join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
if (/@media/.test(styleText)) {
  failures.push("CSS 有 @media 斷點 —— 審稿稿唔應該有（面板一窄就會塌欄走位）");
} else {
  console.log("④ CSS 冇 @media 斷點 ✔");
}

const openDiv = (staticHtml.match(/<div\b/g) || []).length;
const closeDiv = (staticHtml.match(/<\/div>/g) || []).length;
check(openDiv === closeDiv, `<div> 唔配對：開 ${openDiv} / 閂 ${closeDiv}`);
if (openDiv === closeDiv) console.log(`⑤ <div> 配對正確（${openDiv} 對）✔`);

/* ══════════ 7) debug ══════════ */
if (DEBUG) {
  console.log("\n--- 捕捉到嘅 innerHTML 賦值 ---");
  captured.slice(0, 15).forEach((c, i) => {
    console.log(`[${i}] ${c.key} (${c.html.length} chars) ${c.html.slice(0, 80).replace(/\n/g, " ")}`);
  });
  const hit = captured.find((c) => BAD.some((b) => c.html.includes(b)));
  if (hit) {
    const b = BAD.find((x) => hit.html.includes(x));
    const at = hit.html.indexOf(b);
    console.log(`\n"${b}" 出現喺 ${hit.key}：`);
    console.log(JSON.stringify(hit.html.slice(Math.max(0, at - 180), at + 60)));
  }
  console.log("");
}

if (failures.length) {
  console.log("\n✘ 失敗 " + failures.length + " 項：");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
console.log("\n全部通過。");
