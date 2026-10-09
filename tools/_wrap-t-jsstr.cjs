/**
 * AST 版 `t()` 包裹 —— **第 3 版：JS 字串字面量**（2026-10-08）。
 *
 * 處理前兩版都冇掂嘅一類：**唔喺 JSX 文字位置**嘅中文字面量 ——
 * toast 訊息、modal 標題、`{cond ? "a" : "b"}` 呢類。
 *
 * ## 只包「UI 出口」，唔包「資料入口」
 *
 * 用**白名單**（唔係黑名單），因為漏包係「英文版少句英文」，誤包係
 * 「靜靜寫錯 DB」。寧可保守：
 *
 *   1. 物件屬性，key ∈ UI_PROPS（`message` / `label` / `title` …）；
 *   2. 函式引數，callee ∈ UI_FUNCS（`setMemberSearchHint` / `notes.push` …）；
 *   3. 住喺 JSX expression container 裡面嘅字面量 —— 但要通過下面嘅守閘。
 *
 * ## 守閘（避免包到「資料值」）
 *
 *   · 比較語境（`===` / `!==` / `includes(` …）一律跳過；
 *   · `className` / `style` / `key` / `href` / `type` / `id` / `data-*`
 *     屬性一律跳過；
 *   · `EXCLUDE_LINES`（人手核對過嘅第 2／3 層地雷）一律跳過。
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join("C:/dev/macauPos/macauPosSystem/node_modules/typescript"));

const ROOT = "C:/dev/macauPos/macauPosSystem";
const WRITE = process.argv.includes("--write");
const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES = TARGETS.length ? TARGETS : ["src/components/pos-app.tsx"];

const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);

/** 物件屬性白名單：呢啲 key 嘅值係「顯示文案」。 */
const UI_PROPS = new Set([
  "message",
  "label",
  "title",
  "subtitle",
  "description",
  "placeholder",
  "hint",
  "caption",
  "tag",
  "emptyText",
]);
/** 函式引數白名單。 */
const UI_FUNCS = new Set(["setMemberSearchHint"]);
/** 屬性名唔可以係呢啲（唔係文案）。 */
const NON_UI_ATTRS = new Set(["className", "style", "key", "href", "type", "id", "src", "value", "name"]);
/** 比較／匹配語境 —— 一包就會壞比較。 */
const CMP_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const MATCH_FUNCS = new Set(["includes", "indexOf", "startsWith", "endsWith", "match", "test", "split", "join"]);
/** 邏輯運算子 —— 爬升時當「透明」（`a && "文案"` / `x ?? "文案"`）。 */
const LOGICAL_OPS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/**
 * 人手核對過、**唔可以包**嘅行（第 2／3 層地雷）。
 * 見 `_i18n-inventory.cjs --layer2` 報告 ＋ 逐行覆核（2026-10-08）。
 *
 * 🔴 **一定要按檔分開** —— 行號係相對於各自檔案嘅。
 * 以前係一個扁平 `Set`，即係攞 pos-app 嘅行號去掃其他檔（會靜靜跳過無辜行／
 * 或者漏跳真正地雷）。改為 per-file map。
 */
const EXCLUDE_BY_FILE = {
  "src/components/pos-app.tsx": new Set([
    // console.warn 開發日誌
    1539, 1548,
    // 合成快餐枱嘅 name（第 2 層形狀）
    2315,
    // 單號抬頭（寫入 localOrderNo）
    2938,
    // `未填寫原因` 持久化 fallback
    3503, 3540, 3688, 4400, 4529, 4535, 4564, 4631, 4637, 4656, 4667,
    // `全部退菜` 持久化 fallback
    3656, 3659, 3707,
    // `退桌` 持久化 fallback
    3751,
    // quickTypeTableName()（寫入 order.tableName）
    3897, 3898, 3899,
    // 紙單 orderNoSuffix
    3909, 3910, 4046, 4047,
    // tableName fallback（餵打印）
    4093,
    // localOrderNo fallback
    4096,
    // 紙單標題／品項名（第 3 層）
    4490, 4506, 4507, 4669,
    // paymentMethod 持久化 enum
    4780, 5069, 5123, 5234,
    // storeName fallback（餵打印）
    1598, 2051, 2120, 2188, 3907, 4044, 4269, 4279,
    // operator fallback（寫入稽核）
    3496, 5348,
    // 完成狀態 payload label（寫入 sync event）
    4375,
    // 預設付款方式（持久化）
    5318, 5334, 7828,
    // showPermissionDenied 引數（改為喺函式內部 t()，見 pos-app.tsx）
    3470, 3633, 3741, 4516, 4587, 6321, 6387, 6407, 7266, 7282,
  ]),

  /**
   * 訂單頁：**CSV 匯出唔譯**（第 3 層：匯出文件 ≈ 商家對帳用紙單）。
   *
   * ⚠️ 呢啲行係 `{ key: "單號", label: "單號" }` —— `label` 喺 `UI_PROPS` 白名單入面，
   * 唔排除就會**只譯表頭、唔譯值**（`類型`/`付款狀態`/`渠道` 等值行唔符白名單），
   * 出一個半中半英嘅 CSV = 最壞結果。
   *
   * 🔴 呢個係**暫定政策**，未經用戶確認。要改為跟 UI 語言嘅話：
   * 由呢度移走行號 + 幫全部 CSV 字串（表頭 **同** 值）加字典 key。
   */
  "src/components/orders-hub.tsx": new Set([
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143,
    172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184,
  ]),
};

const NO_EXCLUDE = new Set();

let grandApplied = 0;
const grandSkipped = [];

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  const code0 = fs.readFileSync(p, "utf8");
  const sf = ts.createSourceFile(rel, code0, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = code0.split(/\r\n|\n|\r/);
  const lineOf = (pos) => {
    let n = 1;
    for (let i = 0; i < pos && i < code0.length; i++) if (code0.charCodeAt(i) === 10) n++;
    return n;
  };
  const edits = [];
  const skipped = [];

  const inComparison = (node) => {
    let cur = node.parent;
    while (cur) {
      if (ts.isBinaryExpression(cur) && CMP_OPS.has(cur.operatorToken.kind)) return true;
      if (ts.isCallExpression(cur)) {
        const callee = cur.expression;
        const nm = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        if (MATCH_FUNCS.has(nm)) return true;
      }
      cur = cur.parent;
    }
    return false;
  };

  /**
   * 🔴 已經喺 `t()` / `tShort()` / `tNav()` 引數裡面 —— 再包就會變
   *    `t(t("…"))`。第 1、2 版 codemod 已經包咗一大批，一定要跳過
   *    （2026-10-08 實測：唔跳會多包 63 處）。
   */
  const inTCall = (node) => {
    let cur = node.parent;
    while (cur) {
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression)) {
        if (["t", "tShort", "tNav"].includes(cur.expression.text)) return true;
      }
      cur = cur.parent;
    }
    return false;
  };

  const inNonUiAttr = (node) => {
    let cur = node.parent;
    while (cur) {
      if (ts.isJsxAttribute(cur) && cur.name) {
        const nm = cur.name.text;
        if (NON_UI_ATTRS.has(nm) || nm.startsWith("data-") || /^on[A-Z]/.test(nm)) return true;
        return false;
      }
      cur = cur.parent;
    }
    return false;
  };

  const isUiSink = (node) => {
    /**
     * 先爬過「透明」包裝層（三元／邏輯／括號／as）——
     * 因為 `setToast({ message: cond ? "a" : "b" })` 嘅字面量，
     * 直接 parent 係 ConditionalExpression 而唔係 PropertyAssignment
     * （2026-10-08：唔爬會漏 20 處）。
     */
    let cur = node;
    for (;;) {
      const p = cur.parent;
      if (
        p &&
        (ts.isConditionalExpression(p) ||
          (ts.isBinaryExpression(p) && LOGICAL_OPS.has(p.operatorToken.kind)) ||
          ts.isParenthesizedExpression(p) ||
          ts.isAsExpression(p) ||
          ts.isNonNullExpression(p))
      ) {
        cur = p;
        continue;
      }
      break;
    }
    const parent = cur.parent;

    // 1) 物件屬性
    if (parent && ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
      if (UI_PROPS.has(parent.name.text)) return "prop";
    }
    // 2) 函式引數
    if (parent && ts.isCallExpression(parent)) {
      const callee = parent.expression;
      const nm = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (UI_FUNCS.has(nm)) return "func";
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") {
        const obj = callee.expression;
        if (ts.isIdentifier(obj) && obj.text === "notes") return "func";
      }
    }
    // 3) JSX expression container 裡面
    let walk = parent;
    while (walk) {
      if (ts.isJsxExpression(walk)) return "jsx";
      if (ts.isFunctionLike(walk) || ts.isStatement(walk) || ts.isSourceFile(walk)) break;
      walk = walk.parent;
    }
    return null;
  };

  const visit = (node) => {
    const isStr =
      ts.isStringLiteral(node) ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
    if (isStr && hasCJK(node.text)) {
      const ln = lineOf(node.getStart(sf));
      const sink = isUiSink(node);
      /**
       * `NON_UI_ATTRS` / `on*` 只喺 **render 位置**（sink === "jsx"）生效。
       * 理由：`setToast({ message: … })` 好常喺 `onClick` handler 裡面，
       * 如果連佢都當「handler 內一律唔掂」，就會漏成 100 處 toast
       * （2026-10-08 實測）。物件屬性／白名單函式引數本身就已經好窄。
       */
      const blockedByAttr = sink === "jsx" && inNonUiAttr(node);
      if ((EXCLUDE_BY_FILE[rel] ?? NO_EXCLUDE).has(ln)) {
        skipped.push(`L${ln} [排除行] ${JSON.stringify(node.text)}`);
      } else if (inTCall(node)) {
        skipped.push(`L${ln} [已喺 t() 內] ${JSON.stringify(node.text)}`);
      } else if (sink && !inComparison(node) && !blockedByAttr) {
        /**
         * 🔴 JSX 屬性用**字面量**寫（`confirmLabel="加入單"`）嘅話，
         *    換成 `t(…)` 一定要補返大括號，否則出 TS1145
         *    （2026-10-08 實測：`confirmLabel=t("加入單")`）。
         */
        const isAttrLiteral =
          ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
        edits.push({
          start: node.getStart(sf),
          end: node.getEnd(),
          newText: isAttrLiteral ? `{t(${JSON.stringify(node.text)})}` : `t(${JSON.stringify(node.text)})`,
          line: ln,
          key: node.text,
        });
      } else {
        skipped.push(`L${ln} [唔符白名單／比較語境] ${JSON.stringify(node.text)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const out = edits.length
    ? code0.slice(0, edits[0].start) +
      edits
        .map((e, i) => e.newText + code0.slice(e.end, edits[i + 1] ? edits[i + 1].start : code0.length))
        .join("")
    : code0;

  grandApplied += edits.length;
  grandSkipped.push(...skipped.map((s) => `${rel} ${s}`));

  console.log(`\n### ${rel}`);
  console.log(`  包咗 ${edits.length} 處字串`);
  for (const e of edits) console.log(`    L${e.line}  ${JSON.stringify(e.key)}`);
  if (WRITE) {
    fs.writeFileSync(p, out);
    console.log(`  ✅ 已寫入 ${rel}`);
  }
  console.log(`  ── 跳過 ${skipped.length} 處 ──`);
  for (const s of skipped) console.log(`    ${s}`);
}

console.log(`\n=== 總計：${grandApplied} 處${WRITE ? "（已寫入）" : "（dry-run）"} ===`);
