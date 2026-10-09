/**
 * online-orders.tsx：`useCallback` / `useEffect` 內嘅 `t(` → `tRef.current(`。
 *
 * 🔴 為何：`useT()` 嘅 `t` identity 每次切語言都變。直接入 deps 會令
 *    「自動接單掃描」「廚房單補底」兩個 effect 喺切語言時重跑（無謂副作用）。
 *    收落 `tRef` 之後，callback 喺呼叫當刻讀最新 `t`，既唔 stale 又唔使入 deps。
 *    （同 `pos-app.tsx` 嘅 `tRef` 同一個做法。）
 */
const fs = require("fs");

const FILE = "C:/dev/macauPos/macauPosSystem/src/components/online-orders.tsx";
const WRITE = process.argv.includes("--write");

let src = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

// 1) 插入 tRef 定義（緊接 `const t = useT();` 之後）
const T_ANCHOR = `  // ⚠️ 一定要放喺所有 early return 之前（Rules of Hooks）。\n  const t = useT();\n`;
const T_REF = T_ANCHOR + `  /**\n   * \`t\` 嘅 identity 每次切語言都會變（\`useT()\` 內部係 \`useCallback([lang])\`）。\n   * 直接入 \`useCallback\` / \`useEffect\` deps 嘅話，切一次語言會令下面幾個 callback\n   * 重建，連帶令「自動接單掃描」「廚房單補底」兩個 effect 重跑（無謂副作用）。\n   * 所以收落 ref：callback 喺**呼叫當刻**讀最新嘅 \`t\`，既唔 stale 又唔使入 deps。\n   * （同 \`pos-app.tsx\` 嘅 \`tRef\` 同一個做法。）\n   */\n  const tRef = useRef(t);\n  useEffect(() => {\n    tRef.current = t;\n  }, [t]);\n`;
if ((src.split(T_ANCHOR).length - 1) !== 1) {
  console.error("❌ 搵唔到 `const t = useT();` anchor");
  process.exit(1);
}
src = src.replace(T_ANCHOR, T_REF);

// 2) callback 內嘅呼叫一律改行 ref
const PAIRS = [
  // ensureKitchenPrintForAccepted
  [
    `        message: t("已補印廚房單：{code}", { code: tOrderCode(t, order) }),`,
    `        message: tRef.current("已補印廚房單：{code}", { code: tOrderCode(tRef.current, order) }),`,
  ],
  [
    `        message: t("廚房單補印失敗：{code}（{reason}）", {\n          code: tOrderCode(t, order),\n          reason: result.errorMessage ?? t("未知原因"),\n        }),`,
    `        message: tRef.current("廚房單補印失敗：{code}（{reason}）", {\n          code: tOrderCode(tRef.current, order),\n          reason: result.errorMessage ?? tRef.current("未知原因"),\n        }),`,
  ],
  // handleUpdate
  [
    `            message: t("客人申請取消：{code}", { code: tOrderCode(t, order) }),`,
    `            message: tRef.current("客人申請取消：{code}", { code: tOrderCode(tRef.current, order) }),`,
  ],
  [
    `            message: t("客人申請修改：{code}", { code: tOrderCode(t, order) }),`,
    `            message: tRef.current("客人申請修改：{code}", { code: tOrderCode(tRef.current, order) }),`,
  ],
  // runAcceptAndBridge
  [
    `              message: t("已接單，但廚房單建立失敗：{msg}", { msg: errMsg }),`,
    `              message: tRef.current("已接單，但廚房單建立失敗：{msg}", { msg: errMsg }),`,
  ],
  [
    `              ? t("已接單並安排到 {table}。", { table: options?.tableName ?? "" })`,
    `              ? tRef.current("已接單並安排到 {table}。", { table: options?.tableName ?? "" })`,
  ],
  [
    `                t("已接單{hint}。", {\n                  hint: t(kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone })),\n                }),`,
    `                tRef.current("已接單{hint}。", {\n                  hint: tRef.current(\n                    kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone }),\n                  ),\n                }),`,
  ],
  // 自動接單 effect
  [
    `          const payload = autoAcceptToast(tOrderCode(t, order), outcome);`,
    `          const payload = autoAcceptToast(tOrderCode(tRef.current, order), outcome);`,
  ],
];

let bad = 0;
for (const [find, replace] of PAIRS) {
  const n = src.split(find).length - 1;
  if (n !== 1) {
    console.error(`❌ 出現 ${n} 次（預期 1）：${find.slice(0, 80).replace(/\n/g, "\\n")}`);
    bad++;
    continue;
  }
  src = src.split(find).join(replace);
}
if (bad) {
  console.error(`\n❌ ${bad} 條問題，未寫入`);
  process.exit(1);
}

if (WRITE) {
  fs.writeFileSync(FILE, src.replace(/\n/g, "\r\n"));
  console.log(`✅ 已寫入（1 個 tRef 定義 + ${PAIRS.length} 條呼叫）`);
} else {
  console.log(`dry-run：全部命中（加 --write 才寫）`);
}
