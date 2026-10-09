/**
 * online-orders.tsx i18n 手改批次（2026-10-08）。
 *
 * 只做三支 codemod 做唔到嘅嘢：
 *   ① 混合 expression 嘅 JsxText（要被合併成一個帶 {ph} 嘅 key，唔可以斬碎）；
 *   ② template literal（`...${x}...`）→ `t("... {ph} ...", { ph: x })`；
 *   ③ 顯示位包 t()（label lib 函式 / toast.message / error）。
 *
 * ⚠️ 每個 find 都 assert 出現次數，搵唔到就即時報錯（唔會靜靜漏改）。
 */
const fs = require("fs");

const FILE = "C:/dev/macauPos/macauPosSystem/src/components/online-orders.tsx";
const WRITE = process.argv.includes("--write");

// ⚠️ 檔案係 CRLF；比對／替換一律用 LF，寫入前先轉返。
let src = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

/** @type {Array<[string, string, number?]>} */
const EDITS = [
  // ── ① 顯示位包 t()：lib 回傳嘅中文標籤 ──────────────────────────────
  [
    `            {onlineTableAssignLabel(order)}`,
    `            {t(onlineTableAssignLabel(order))}`,
  ],
  [
    `              {changeRequestLabel(order)}`,
    `              {/* ⚠️ \`changeRequestLabel()\` 回 \`string | null\`，唔可以直接 t(null)。 */}
              {t(changeRequestLabel(order) ?? "")}`,
  ],
  [
    `                        {statusBadge.label}`,
    `                        {t(statusBadge.label)}`,
  ],
  [
    `                      {badge.label}`,
    `                      {t(badge.label)}`,
  ],
  [
    `          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>`,
    `          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t(error)}</div>`,
  ],
  [
    `          {toast.message}`,
    `          {t(toast.message, toast.vars)}`,
  ],
  [
    `                      <div className="truncate text-sm font-semibold text-slate-900">{orderCodeLabel(order)}</div>`,
    `                      <div className="truncate text-sm font-semibold text-slate-900">{t(orderCodeLabel(order))}</div>`,
  ],
  [
    `          <div className="text-sm text-slate-700">{orderCodeLabel(balanceFallbackOrder)} · {formatMoney(balanceFallbackOrder.total)}</div>`,
    `          <div className="text-sm text-slate-700">{t(orderCodeLabel(balanceFallbackOrder))} · {formatMoney(balanceFallbackOrder.total)}</div>`,
  ],

  // ── ② 空狀態 / 篩選摘要（混合 expression，要合成一句） ───────────────
  [
    `            {dateFilter === "today" ? "今天暫無訂單" : \`\${dateFilterLabel(dateFilter)}暫無訂單\`}`,
    `            {dateFilter === "today"
              ? t("今天暫無訂單")
              : t("{range}暫無訂單", { range: t(dateFilterLabel(dateFilter)) })}`,
  ],
  [
    `                        {tabLabel(order.tabType)} · 客戶：{order.customerName ?? "--"}`,
    `                        {t("{tab} · 客戶：{name}", {
                          tab: t(tabLabel(order.tabType)),
                          name: order.customerName ?? "--",
                        })}`,
  ],
  [
    `                        {order.itemCount && order.itemCount > 1 ? \` 等 \${order.itemCount} 項\` : ""}`,
    `                        {order.itemCount && order.itemCount > 1
                          ? t(" 等 {n} 項", { n: order.itemCount })
                          : ""}`,
  ],
  [
    `                          已優惠 -{formatMoney(order.discountAmount)}
                          {order.subtotalBeforeDiscount != null ? (
                            <span className="ml-1 text-slate-400 line-through">
                              原 {formatMoney(order.subtotalBeforeDiscount)}
                            </span>
                          ) : null}`,
    `                          {t("已優惠 -{amt}", { amt: formatMoney(order.discountAmount) })}
                          {order.subtotalBeforeDiscount != null ? (
                            <span className="ml-1 text-slate-400 line-through">
                              {t("原 {amt}", { amt: formatMoney(order.subtotalBeforeDiscount) })}
                            </span>
                          ) : null}`,
  ],
  [
    `                        {order.paymentStatus === "paid" ? "已支付" : "未支付"}
                        {order.paymentMode ? \`（\${paymentModeLabel(order.paymentMode)}）\` : ""}`,
    `                        {order.paymentStatus === "paid" ? t("已支付") : t("未支付")}
                        {order.paymentMode
                          ? t("（{mode}）", { mode: t(paymentModeLabel(order.paymentMode)) })
                          : ""}`,
  ],

  // ── ③ 排位彈窗 ───────────────────────────────────────────────────────
  [
    `              ? "選擇桌台後會將線上單轉到該枱（建立本地堂食單）並補印一張帶枱名嘅廚房單。"
              : \`現時：\${onlineTableBadge(assigningOrder, { quickMode: false }).label}。選擇新桌台即改枱。\``,
    `              ? t("選擇桌台後會將線上單轉到該枱（建立本地堂食單）並補印一張帶枱名嘅廚房單。")
              : t("現時：{status}。選擇新桌台即改枱。", {
                  status: t(onlineTableBadge(assigningOrder, { quickMode: false }).label),
                })`,
  ],
  [
    `          title={\`\${onlineTableAssignLabel(assigningOrder)} · \${orderCodeLabel(assigningOrder)}\`}`,
    `          title={t("{action} · {code}", {
            action: t(onlineTableAssignLabel(assigningOrder)),
            code: t(orderCodeLabel(assigningOrder)),
          })}`,
  ],

  // ── ④ 詳情彈窗 ───────────────────────────────────────────────────────
  [
    `          description={\`\${orderCodeLabel(viewingOrder)} · \${tabLabel(viewingOrder.tabType)}\`}`,
    `          description={t("{code} · {tab}", {
            code: t(orderCodeLabel(viewingOrder)),
            tab: t(tabLabel(viewingOrder.tabType)),
          })}`,
  ],
  [
    `            <div>客戶：{viewingOrder.customerName ?? "--"}</div>
            <div>電話：{viewingOrder.phone ?? "--"}</div>
            {viewingOrder.deliveryAddress ? <div>地址：{viewingOrder.deliveryAddress}</div> : null}`,
    `            <div>{t("客戶：{name}", { name: viewingOrder.customerName ?? "--" })}</div>
            <div>{t("電話：{phone}", { phone: viewingOrder.phone ?? "--" })}</div>
            {viewingOrder.deliveryAddress ? (
              <div>{t("地址：{addr}", { addr: viewingOrder.deliveryAddress })}</div>
            ) : null}`,
  ],
  [
    `            {viewingOrder.note ? <div>備註：{viewingOrder.note}</div> : null}`,
    `            {viewingOrder.note ? (
              <div>{t("備註：{note}", { note: viewingOrder.note })}</div>
            ) : null}`,
  ],
  [
    `            <div>
              支付：{paymentModeLabel(viewingOrder.paymentMode)} ·{" "}
              {viewingOrder.paymentStatus === "paid" ? "已支付" : "未支付"}
            </div>`,
    `            <div>
              {t("支付：{mode} · {status}", {
                mode: t(paymentModeLabel(viewingOrder.paymentMode)),
                status: viewingOrder.paymentStatus === "paid" ? t("已支付") : t("未支付"),
              })}
            </div>`,
  ],
  [
    `                                {item.discountRate != null ? \`\${item.discountRate}% off\` : "已優惠"}`,
    `                                {item.discountRate != null
                                  ? t("{rate}% off", { rate: item.discountRate })
                                  : t("已優惠")}`,
  ],
  [
    `                            {item.note ? <div>備註：{item.note}</div> : null}`,
    `                            {item.note ? (
                              <div>{t("備註：{note}", { note: item.note })}</div>
                            ) : null}`,
  ],

  // ── ⑤ toast / confirm 嘅 template literal ───────────────────────────
  [
    "      setToast({ tone: \"success\", message: `已補印廚房單：${orderCodeLabel(order)}` });",
    "      setToast({\n        tone: \"success\",\n        message: t(\"已補印廚房單：{code}\", { code: t(orderCodeLabel(order)) }),\n      });",
  ],
  [
    "        message: `廚房單補印失敗：${orderCodeLabel(order)}（${result.errorMessage ?? \"未知原因\"}）`,",
    "        message: t(\"廚房單補印失敗：{code}（{reason}）\", {\n          code: t(orderCodeLabel(order)),\n          reason: result.errorMessage ?? t(\"未知原因\"),\n        }),",
  ],
  [
    "          setToast({ tone: \"error\", message: `客人申請取消：${orderCodeLabel(order)}` });",
    "          setToast({\n            tone: \"error\",\n            message: t(\"客人申請取消：{code}\", { code: t(orderCodeLabel(order)) }),\n          });",
  ],
  [
    "          setToast({ tone: \"error\", message: `客人申請修改：${orderCodeLabel(order)}` });",
    "          setToast({\n            tone: \"error\",\n            message: t(\"客人申請修改：{code}\", { code: t(orderCodeLabel(order)) }),\n          });",
  ],
  [
    "              message: `已接單，但廚房單建立失敗：${errMsg}`,",
    "              message: t(\"已接單，但廚房單建立失敗：{msg}\", { msg: errMsg }),",
  ],
  [
    "            message: options?.tableId\n              ? `已接單並安排到 ${options.tableName}。`",
    "            message: options?.tableId\n              ? t(\"已接單並安排到 {table}。\", { table: options.tableName })",
  ],
  [
    "                `已接單${kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone })}。`,",
    "                t(\"已接單{hint}。\", {\n                  hint: t(kitchenHintText({ ok: true, kitchenJobCount, printAlreadyDone })),\n                }),",
  ],
  [
    "        setToast({ tone: \"success\", message: `已加入補打帳單打印隊列：${orderCodeLabel(order)}` });",
    "        setToast({\n          tone: \"success\",\n          message: t(\"已加入補打帳單打印隊列：{code}\", { code: t(orderCodeLabel(order)) }),\n        });",
  ],
  [
    "      setToast({ tone: \"error\", message: describeNoReceiptPrinterError() });",
    "      setToast({ tone: \"error\", message: t(describeNoReceiptPrinterError()) });",
  ],
  [
    "          message: `${result.created ? \"已排位\" : \"已改枱到\"} ${tableName}，但同步線上訂單狀態失敗：${\n            result.ledgerProgress.error ?? \"未知錯誤\"\n          }`,",
    "          message: t(\"{action} {table}，但同步線上訂單狀態失敗：{err}\", {\n            action: result.created ? t(\"已排位\") : t(\"已改枱到\"),\n            table: tableName,\n            err: result.ledgerProgress.error ?? t(\"未知錯誤\"),\n          }),",
  ],
  [
    "          message: result.created\n            ? `已排位 ${tableName}：${orderCodeLabel(order)}`\n            : `已改枱到 ${tableName}：${orderCodeLabel(order)}`,",
    "          message: result.created\n            ? t(\"已排位 {table}：{code}\", { table: tableName, code: t(orderCodeLabel(order)) })\n            : t(\"已改枱到 {table}：{code}\", { table: tableName, code: t(orderCodeLabel(order)) }),",
  ],
  [
    "    const ok = window.confirm(\"確定要取消這張訂單？\");",
    "    const ok = window.confirm(t(\"確定要取消這張訂單？\"));",
  ],
  [
    "      action === \"approve\"\n        ? isCancel\n          ? \"確定同意客人取消這張訂單？取消後不可復原。\"\n          : \"確定同意客人的修改申請？套用後以新明細／新金額為準。\"\n        : \"確定拒絕客人的申請？訂單會繼續處理。\",",
    "      action === \"approve\"\n        ? isCancel\n          ? t(\"確定同意客人取消這張訂單？取消後不可復原。\")\n          : t(\"確定同意客人的修改申請？套用後以新明細／新金額為準。\")\n        : t(\"確定拒絕客人的申請？訂單會繼續處理。\"),",
  ],
  [
    "        message:\n          action === \"approve\"\n            ? isCancel\n              ? \"已同意客人取消，訂單已取消。\"\n              : \"已同意客人修改，已套用新明細。\"\n            : \"已拒絕申請，訂單繼續處理。\",",
    "        message:\n          action === \"approve\"\n            ? isCancel\n              ? t(\"已同意客人取消，訂單已取消。\")\n              : t(\"已同意客人修改，已套用新明細。\")\n            : t(\"已拒絕申請，訂單繼續處理。\"),",
  ],
];

let failed = 0;
for (const [find, replace, expect = 1] of EDITS) {
  const n = src.split(find).length - 1;
  if (n !== expect) {
    console.error(`❌ 出現 ${n} 次（預期 ${expect}）：${find.slice(0, 90).replace(/\n/g, "\\n")}`);
    failed += 1;
    continue;
  }
  src = src.split(find).join(replace);
}

if (failed) {
  console.error(`\n有 ${failed} 條搵唔到，未寫入。`);
  process.exit(1);
}

if (WRITE) {
  fs.writeFileSync(FILE, src.replace(/\n/g, "\r\n"));
  console.log(`✅ 已寫入 ${EDITS.length} 條替換`);
} else {
  console.log(`dry-run：${EDITS.length} 條全部命中（加 --write 才寫）`);
}
