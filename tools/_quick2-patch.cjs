#!/usr/bin/env node
/**
 * Task #10 主體 —— `quick-online-orders-panel.tsx` i18n 補丁（人手部分）。
 *
 * codemod（`_wrap-t-ast` / `_wrap-t-jsxtext`）已經處理咗 23 處機械式包裹；
 * 呢支腳本處理：
 *   ① import / useT / tRef / tOrderCode 基建
 *   ② onToast payload → 「字典 key + vars」（ToastPayload 合約）
 *   ③ `t()` 一個「已填值」字串（orderCodeLabel / paymentSummaryLabel）→ *Parts()
 *   ④ 被 `{expr}` 斬碎嘅句子 → 合併成單一 key
 *   ⑤ 顯示位 t()
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");
const FILE = "src/components/quick-online-orders-panel.tsx";

let fails = 0;
let src = fs.readFileSync(path.join(ROOT, FILE), "utf8").replace(/\r\n/g, "\n");

function ed(find, replace, expect) {
  const n = src.split(find).length - 1;
  const ok = n === expect;
  if (!ok) fails++;
  console.log(`  ${ok ? "✅" : "❌"} ${n}/${expect}  ${find.slice(0, 78).replace(/\n/g, "⏎")}`);
  if (ok) src = src.split(find).join(replace);
}

// ── ① 基建 ────────────────────────────────────────────────────
ed(
  `import { ResponsiveModal } from "@/components/responsive-modal";\n`,
  `import { useT } from "@/components/lang-provider";\nimport { ResponsiveModal } from "@/components/responsive-modal";\n`,
  1,
);
ed(`  orderCodeLabel,\n  paymentModeLabel,\n`, `  orderCodeLabelParts,\n  paymentModeLabel,\n`, 1);
ed(`  paymentSummaryLabel,\n} from "@/lib/ledger/online-order-actions";\n`, `  paymentSummaryLabelParts,\n} from "@/lib/ledger/online-order-actions";\n`, 1);

// module-scope helper
ed(
  `export function QuickOnlineOrdersPanel({\n`,
  `/**
 * 訂單編號標籤嘅 i18n 版本。
 *
 * 🔴 唔可以寫 \`t(orderCodeLabel(order))\`：\`orderCodeLabel()\` 回傳嘅係**已填值**字串
 * （例：\`取餐碼 005\`），而字典 key 係 \`取餐碼 {code}\` —— 兩者永遠唔會相等，
 * \`t()\` 只會靜靜咁 fallback 返原本嘅中文（唔會 throw、唔會報錯、測試全綠）。
 * 一定要行 \`orderCodeLabelParts()\` 攞 key + vars。
 */
function tOrderCode(
  t: (key: string, vars?: Record<string, string | number>) => string,
  order: Parameters<typeof orderCodeLabelParts>[0],
): string {
  const parts = orderCodeLabelParts(order);
  return t(parts.key, parts.vars);
}

export function QuickOnlineOrdersPanel({\n`,
  1,
);

// component head：useT + tRef（t 身份隨語言切換而變，唔可以入 callback deps）
ed(
  `}: QuickOnlineOrdersPanelProps) {\n  const merchantId = getLedgerMerchantId();\n`,
  `}: QuickOnlineOrdersPanelProps) {\n  // ⚠️ 一定要放喺所有 early return 之前（Rules of Hooks）。\n  const t = useT();\n  // \`t\` 嘅身份每次切語言都會變；放入 useCallback deps 會令「自動接單掃描」\n  // 同「廚房單兜底」兩個 effect 無謂重跑 → 用 ref 喺呼叫當刻取最新實作。\n  const tRef = useRef(t);\n  useEffect(() => {\n    tRef.current = t;\n  }, [t]);\n\n  const merchantId = getLedgerMerchantId();\n`,
  1,
);

// ── ② onToast payload → key + vars ───────────────────────────
ed(
  `          onToast({ tone: "error", message: \`客人申請取消：\${orderCodeLabel(order)}\` });\n`,
  `          onToast({\n            tone: "error",\n            message: "客人申請取消：{code}",\n            vars: { code: tOrderCode(tRef.current, order) },\n          });\n`,
  1,
);
ed(
  `          onToast({ tone: "info", message: \`客人申請修改：\${orderCodeLabel(order)}\` });\n`,
  `          onToast({\n            tone: "info",\n            message: "客人申請修改：{code}",\n            vars: { code: tOrderCode(tRef.current, order) },\n          });\n`,
  1,
);
ed(
  `          const kitchenHint = kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone });\n          onToast({\n            tone: "success",\n            message: options?.autoStartPreparing\n              ? \`已接單並開始製作\${kitchenHint}：\${orderCodeLabel(order)}\`\n              : \`已接單\${kitchenHint}：\${orderCodeLabel(order)}\`,\n          });\n`,
  `          const kitchenHint = kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone });\n          onToast({\n            tone: "success",\n            // ⚠️ 呢度只交「字典 key + vars」—— 真正 t() 喺 pos-app（見 ToastPayload 合約）。\n            message: options?.autoStartPreparing ? "已接單並開始製作{hint}：{code}" : "已接單{hint}：{code}",\n            vars: { hint: tRef.current(kitchenHint), code: tOrderCode(tRef.current, order) },\n          });\n`,
  1,
);
ed(
  `          const payload = autoAcceptToast(orderCodeLabel(order), outcome);\n`,
  `          const payload = autoAcceptToast(tOrderCode(tRef.current, order), outcome);\n`,
  1,
);
ed(
  `          onToastRef.current({ tone: "success", message: \`已補印廚房單：\${orderCodeLabel(order)}\` });\n`,
  `          onToastRef.current({\n            tone: "success",\n            message: "已補印廚房單：{code}",\n            vars: { code: tOrderCode(tRef.current, order) },\n          });\n`,
  1,
);
ed(
  `          onToastRef.current({\n            tone: "error",\n            message: \`廚房單補印失敗：\${orderCodeLabel(order)}（\${result.errorMessage ?? "未知原因"}）\`,\n          });\n`,
  `          onToastRef.current({\n            tone: "error",\n            message: "廚房單補印失敗：{code}（{reason}）",\n            vars: {\n              code: tOrderCode(tRef.current, order),\n              reason: tRef.current(result.errorMessage ?? "未知原因"),\n            },\n          });\n`,
  1,
);
ed(
  `        onToast({\n          tone: "success",\n          message: result.created\n            ? \`已排位 \${table.name}：\${orderCodeLabel(order)}\`\n            : \`已改枱到 \${table.name}：\${orderCodeLabel(order)}\`,\n        });\n`,
  `        onToast({\n          tone: "success",\n          message: result.created ? "已排位 {table}：{code}" : "已改枱到 {table}：{code}",\n          // ⚠️ \`table.name\` 係第 2 層資料值（真枱名）⇒ 只放入 vars，唔可以 t()。\n          vars: { table: table.name, code: tOrderCode(tRef.current, order) },\n        });\n`,
  1,
);
ed(
  `          onToast({\n            tone: "error",\n            message: \`排位已成功，但同步線上訂單狀態失敗：\${\n              result.ledgerProgress.error ?? "未知錯誤"\n            }\`,\n          });\n`,
  `          onToast({\n            tone: "error",\n            message: "排位已成功，但同步線上訂單狀態失敗：{reason}",\n            vars: { reason: tRef.current(result.ledgerProgress.error ?? "未知錯誤") },\n          });\n`,
  1,
);

// window.confirm（原生對話框都係 UI）
ed(
  `        const ok = window.confirm("確定拒絕這張線上訂單？");\n`,
  `        const ok = window.confirm(tRef.current("確定拒絕這張線上訂單？"));\n`,
  1,
);
ed(
  `        const ok = window.confirm(\n          isCancel\n            ? "確定同意客人取消這張訂單？取消後不可復原。"\n            : "確定同意客人的修改申請？套用後以新明細／新金額為準。",\n        );\n`,
  `        const ok = window.confirm(\n          tRef.current(\n            isCancel\n              ? "確定同意客人取消這張訂單？取消後不可復原。"\n              : "確定同意客人的修改申請？套用後以新明細／新金額為準。",\n          ),\n        );\n`,
  1,
);
ed(
  `        const ok = window.confirm("確定拒絕客人的申請？訂單會繼續處理。");\n`,
  `        const ok = window.confirm(tRef.current("確定拒絕客人的申請？訂單會繼續處理。"));\n`,
  1,
);

// ── ③ renderOrderCard 頭部：*Parts() ──────────────────────────
ed(
  `    const cancelRequest = changeRequestLabel(order);\n    const paymentLabel = paymentSummaryLabel(order, currency);\n    const statusLabel = ledgerStatusBadgeLabel(order.status, order.fulfillmentType);\n    const typeLabel = tabLabel(order.tabType);\n`,
  `    const cancelRequest = changeRequestLabel(order);\n    // 🔴 \`paymentSummaryLabel()\` 回傳已填值字串（例：\`已支付 MOP 120\`）⇒ 一定要行 *Parts() 版本。\n    const paymentParts = paymentSummaryLabelParts(order, currency);\n    const paymentLabel = t(paymentParts.key, paymentParts.vars);\n    const statusLabel = ledgerStatusBadgeLabel(order.status, order.fulfillmentType);\n    const typeLabel = tabLabel(order.tabType);\n    const codeLabel = tOrderCode(t, order);\n`,
  1,
);

// ── ④ / ⑤ 顯示位 ─────────────────────────────────────────────
ed(`            {busy ? "處理中…" : action.label}\n`, `            {busy ? t("處理中…") : t(action.label)}\n`, 1);
ed(`\n            {busy ? "處理中…" : primary.label}\n`, `\n            {busy ? t("處理中…") : t(primary.label)}\n`, 1);
ed(`\n                    {busy ? "處理中…" : primary.label}\n`, `\n                    {busy ? t("處理中…") : t(primary.label)}\n`, 1);
ed(`{onlineTableAssignLabel(order)}`, `{t(onlineTableAssignLabel(order))}`, 2);
ed(`            {item.label}\n`, `            {t(item.label)}\n`, 1);
ed(
  `              <div className="truncate text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>\n`,
  `              <div className="truncate text-sm font-semibold text-slate-900">{codeLabel}</div>\n`,
  1,
);
ed(`                <span className="text-xs text-slate-500">{typeLabel}</span>\n`, `                <span className="text-xs text-slate-500">{t(typeLabel)}</span>\n`, 1);
ed(`              {statusLabel}\n`, `              {t(statusLabel)}\n`, 1);
ed(`            <span className="text-slate-600">{paymentLabel}</span>\n`, `            <span className="text-slate-600">{t(paymentLabel)}</span>\n`, 1);
ed(
  `              <span className="font-semibold text-amber-700">{t("已優惠 -")}{formatMoney(order.discountAmount, currency)}</span>\n`,
  `              <span className="font-semibold text-amber-700">{t("已優惠 -{amt}", { amt: formatMoney(order.discountAmount, currency) })}</span>\n`,
  1,
);
ed(
  `            <div className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-700">{cancelRequest}</div>\n`,
  `            <div className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-semibold text-rose-700">{t(cancelRequest)}</div>\n`,
  1,
);
ed(
  `              {orderCodeLabel(order)} <span className="ml-2 text-xs font-semibold text-slate-500">{typeLabel}</span>\n`,
  `              {codeLabel} <span className="ml-2 text-xs font-semibold text-slate-500">{t(typeLabel)}</span>\n`,
  1,
);
ed(`              {statusLabel} · {paymentLabel}\n`, `              {t(statusLabel)} · {t(paymentLabel)}\n`, 1);
ed(
  `                {t("已優惠 -")}{formatMoney(order.discountAmount, currency)}\n`,
  `                {t("已優惠 -{amt}", { amt: formatMoney(order.discountAmount, currency) })}\n`,
  1,
);
ed(
  `            {cancelRequest ? <div className="mt-1 text-xs font-semibold text-rose-600">{cancelRequest}</div> : null}\n`,
  `            {cancelRequest ? <div className="mt-1 text-xs font-semibold text-rose-600">{t(cancelRequest)}</div> : null}\n`,
  1,
);
ed(
  `          <div className="text-xs font-semibold text-slate-500">{autoAcceptLabel}</div>\n`,
  `          <div className="text-xs font-semibold text-slate-500">{t(autoAcceptLabel)}</div>\n`,
  1,
);
ed(`              {autoAccept ? "開" : "關"}\n`, `              {autoAccept ? t("開") : t("關")}\n`, 1);
ed(`text-sm text-amber-900">{error}</div>`, `text-sm text-amber-900">{t(error)}</div>`, 1);
ed(`              。\n            </>\n          ) : null}\n        </div>\n`, `              {t("。")}\n            </>\n          ) : null}\n        </div>\n`, 1);

// 排位彈窗 description / title
ed(
  `          description={\n            needsTableAssignment(assigningOrder, { quickMode: quickCounter })\n              ? "選擇桌台後會將線上單轉到該枱，並補印一張帶枱名嘅廚房單。"\n              : \`現時：\${onlineTableBadge(assigningOrder, { quickMode: quickCounter }).label}。選擇新桌台即改枱。\`\n          }\n`,
  `          description={\n            needsTableAssignment(assigningOrder, { quickMode: quickCounter })\n              ? // ⚠️ 呢度傳「字典 key」（TableAssignModal 內部會 t(description)）。\n                "選擇桌台後會將線上單轉到該枱，並補印一張帶枱名嘅廚房單。"\n              : // ⚠️ 有動態值（枱位標籤）⇒ 冇得傳純 key，要喺度譯好再傳\n                //    （t() 查唔到英文 key 會原樣返回，唔會雙重翻譯）。\n                t("現時：{badge}。選擇新桌台即改枱。", {\n                  badge: t(onlineTableBadge(assigningOrder, { quickMode: quickCounter }).label),\n                })\n          }\n`,
  1,
);
ed(
  "          title={`${onlineTableAssignLabel(assigningOrder)} · ${orderCodeLabel(assigningOrder)}`}\n",
  "          title={`${t(onlineTableAssignLabel(assigningOrder))} · ${tOrderCode(t, assigningOrder)}`}\n",
  1,
);

// 餘額不足彈窗 / 詳情彈窗
ed(
  `          <div className="text-sm text-slate-600">{orderCodeLabel(balanceFallbackOrder)}</div>\n`,
  `          <div className="text-sm text-slate-600">{tOrderCode(t, balanceFallbackOrder)}</div>\n`,
  1,
);
ed(
  "          description={`${orderCodeLabel(viewingOrder)} · ${tabLabel(viewingOrder.tabType)} · ${ledgerStatusLabel(viewingOrder.status, viewingOrder.fulfillmentType)}`}\n",
  `          description={t("{code} · {tab} · {status}", {\n            code: tOrderCode(t, viewingOrder),\n            tab: t(tabLabel(viewingOrder.tabType)),\n            status: t(ledgerStatusLabel(viewingOrder.status, viewingOrder.fulfillmentType)),\n          })}\n`,
  1,
);
ed(
  `            <div>{t("客戶：")}{viewingOrder.customerName ?? "--"}</div>\n            <div>{t("電話：")}{viewingOrder.phone ?? "--"}</div>\n            {viewingOrder.deliveryAddress ? <div>{t("地址：")}{viewingOrder.deliveryAddress}</div> : null}\n`,
  `            <div>{t("客戶：{name}", { name: viewingOrder.customerName ?? "--" })}</div>\n            <div>{t("電話：{phone}", { phone: viewingOrder.phone ?? "--" })}</div>\n            {viewingOrder.deliveryAddress ? <div>{t("地址：{addr}", { addr: viewingOrder.deliveryAddress })}</div> : null}\n`,
  1,
);
ed(
  `            {viewingOrder.note ? <div>{t("備註：")}{viewingOrder.note}</div> : null}\n`,
  `            {viewingOrder.note ? <div>{t("備註：{note}", { note: viewingOrder.note })}</div> : null}\n`,
  1,
);
ed(
  `            <div>\n              {t("支付：")}{paymentModeLabel(viewingOrder.paymentMode)} ·{" "}\n              {viewingOrder.paymentStatus === "paid" ? "已支付" : "未支付"}\n            </div>\n`,
  `            <div>\n              {t("支付：{mode} · {status}", {\n                mode: t(paymentModeLabel(viewingOrder.paymentMode)),\n                status: viewingOrder.paymentStatus === "paid" ? t("已支付") : t("未支付"),\n              })}\n            </div>\n`,
  1,
);
ed(
  '                          {item.discountRate != null ? `${item.discountRate}% off` : "已優惠"}\n',
  `                          {item.discountRate != null ? t("{rate}% off", { rate: item.discountRate }) : t("已優惠")}\n`,
  1,
);
ed(
  `                      {item.note ? <div>{t("備註：")}{item.note}</div> : null}\n`,
  `                      {item.note ? <div>{t("備註：{note}", { note: item.note })}</div> : null}\n`,
  1,
);

if (WRITE && fails === 0) fs.writeFileSync(path.join(ROOT, FILE), src.replace(/\n/g, "\r\n"));
console.log(fails ? `\n❌ ${fails} 個 edit 冇命中` : `\n✅ 全部命中${WRITE ? "，已落盤" : "（dry-run）"}`);
process.exit(fails ? 1 : 0);
