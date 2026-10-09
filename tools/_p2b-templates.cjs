/**
 * P2b：`pos-app.tsx` 剩餘 **template literal** 嘅精準改寫表（2026-10-08）。
 *
 * 點解唔用 codemod 自動做：template literal 一拆就變「碎片 key」
 * （`` `${a} 已下單` `` → key `" 已下單"`），英文語序會斷句。
 * 所以每一條都人手合併成**一條帶 `{placeholder}` 嘅 key**。
 *
 * 次序有意義：**長嘅／包住短嘅要排前面**（例：L3587 包住 L3585/3586）。
 */
module.exports = [
  // ─── 退款匯總／明細導出 ───────────────────────────────────────
  ['`${order.localOrderNo}-退款明細.csv`', '`${order.localOrderNo}-${t("退款明細")}.csv`'],
  ['`${order.localOrderNo} 退款明細已導出。`', 't("{no} 退款明細已導出。", { no: order.localOrderNo })'],
  [
    '`退款匯總-${refundSummaryMode === "date" ? "按日期" : "按員工"}.csv`',
    '`${t("退款匯總")}-${refundSummaryMode === "date" ? t("按日期") : t("按員工")}.csv`',
  ],

  // ─── 工作階段／同步提示 ─────────────────────────────────────
  [
    '`此工作階段已被管理員關閉：${detail?.count ?? 0} 筆操作被拒收，請重新登入或開新視窗。`',
    't("此工作階段已被管理員關閉：{n} 筆操作被拒收，請重新登入或開新視窗。", { n: detail?.count ?? 0 })',
  ],
  [
    '`${label}：${detail?.count ?? 0} 筆操作被 server 拒收，正在由雲端更正本機狀態。`',
    't("{label}：{n} 筆操作被 server 拒收，正在由雲端更正本機狀態。", { label, n: detail?.count ?? 0 })',
  ],
  [
    '`已隔離 ${quarantined} 張孤兒單，詳情喺「同步健康」`',
    't("已隔離 {n} 張孤兒單，詳情喺「同步健康」", { n: quarantined })',
  ],
  [
    '`已重新排入 ${revived} 筆同步資料`',
    't("已重新排入 {n} 筆同步資料", { n: revived })',
  ],

  // ─── 自助單 / 枱面提示 ──────────────────────────────────────
  [
    '`${label} 嘅訂單已經結帳，呢個提示可以向右滑走。`',
    't("{label} 嘅訂單已經結帳，呢個提示可以向右滑走。", { label })',
  ],
  ['`自助單 ${order.localOrderNo} 待確認`', 't("自助單 {no} 待確認", { no: order.localOrderNo })'],
  ['`${order.tableName} 已落單，請確認`', 't("{table} 已落單，請確認", { table: order.tableName })'],
  [
    '`${order.tableName || order.localOrderNo} 加單 ${addedItems.length} 項，已補出廚房單。`',
    't("{label} 加單 {n} 項，已補出廚房單。", { label: order.tableName || order.localOrderNo, n: addedItems.length })',
  ],

  // ─── 平台單打印提示 ─────────────────────────────────────────
  [
    '`平台單未出紙：打印分區「${zoneName}」冇啟用嘅分區打印機，請去「設置 → 打印機」綁一台。`',
    't("平台單未出紙：打印分區「{zone}」冇啟用嘅分區打印機，請去「設置 → 打印機」綁一台。", { zone: zoneName })',
  ],

  // ─── 「冇單」類 ────────────────────────────────────────────
  [
    '`目前沒有待結帳訂單（${activeTable?.name ?? "本枱"}：${describeTableOrderStates()}）。`',
    't("目前沒有待結帳訂單（{table}：{states}）。", { table: activeTable?.name ?? t("本枱"), states: describeTableOrderStates() })',
  ],
  [
    '`搵唔到要免單嘅訂單（${activeTable?.name ?? "本枱"}：${describeTableOrderStates()}）。`',
    't("搵唔到要免單嘅訂單（{table}：{states}）。", { table: activeTable?.name ?? t("本枱"), states: describeTableOrderStates() })',
  ],

  // ─── 退菜 toast（⚠️ 長句要排前面，佢包住下面兩句）────────────
  [
    '`${mode === "one" ? `已退 1 份 ${target.name}` : `已退掉 ${target.name}`}，但廚房退菜單未打印（${voidHasZonePrinter ? "菜品分區對唔中打印機" : "未配置分區打印機"}）`',
    't("{action}，但廚房退菜單未打印（{reason}）", {\n          action:\n            mode === "one"\n              ? t("已退 1 份 {name}", { name: target.name })\n              : t("已退掉 {name}", { name: target.name }),\n          reason: voidHasZonePrinter ? t("菜品分區對唔中打印機") : t("未配置分區打印機"),\n        })',
  ],
  ['`已退 1 份 ${target.name}`', 't("已退 1 份 {name}", { name: target.name })'],
  ['`已退掉 ${target.name}`', 't("已退掉 {name}", { name: target.name })'],

  // ─── 快餐出餐 ──────────────────────────────────────────────
  ['`${target.localOrderNo} 已經標記可取餐。`', 't("{no} 已經標記可取餐。", { no: target.localOrderNo })'],
  [
    '`${target.localOrderNo}（${localOrderStatusLabel(target)}）唔可以標記可取餐。`',
    't("{no}（{status}）唔可以標記可取餐。", { no: target.localOrderNo, status: localOrderStatusLabel(target) })',
  ],
  [
    '`${updatedOrder.localOrderNo} 已標記可取餐。`',
    't("{no} 已標記可取餐。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`已標記可取餐，但會員通狀態未同步：${message}`',
    't("已標記可取餐，但會員通狀態未同步：{message}", { message })',
  ],
  ['`${order.tableName ?? tableId} 已退桌，枱位已釋放。`', 't("{table} 已退桌，枱位已釋放。", { table: order.tableName ?? tableId })'],
  ['`已補打廚房單（${authoritativeOrder.localOrderNo}）。`', 't("已補打廚房單（{no}）。", { no: authoritativeOrder.localOrderNo })'],

  // ─── 落單成功 ──────────────────────────────────────────────
  ['`已加單成功，單號 ${order.localOrderNo}。`', 't("已加單成功，單號 {no}。", { no: order.localOrderNo })'],
  ['`已下單成功，單號 ${order.localOrderNo}。`', 't("已下單成功，單號 {no}。", { no: order.localOrderNo })'],
  [
    '`已離線加單 ${order.localOrderNo}，待恢復網絡後補傳。`',
    't("已離線加單 {no}，待恢復網絡後補傳。", { no: order.localOrderNo })',
  ],
  [
    '`已離線下單 ${order.localOrderNo}，待恢復網絡後補傳。`',
    't("已離線下單 {no}，待恢復網絡後補傳。", { no: order.localOrderNo })',
  ],

  // ─── 完成 / 取消 ───────────────────────────────────────────
  [
    '`${updatedOrder.localOrderNo} ${options?.label ?? "已完成"}。`',
    't("{no} {label}。", { no: updatedOrder.localOrderNo, label: options?.label ?? t("已完成") })',
  ],
  [
    '`已標記完成，但會員通狀態未同步：${message}`',
    't("已標記完成，但會員通狀態未同步：{message}", { message })',
  ],
  ['`${updatedOrder.localOrderNo} 已取消結帳。`', 't("{no} 已取消結帳。", { no: updatedOrder.localOrderNo })'],
  ['`${targetOrder.localOrderNo} 已刪除。`', 't("{no} 已刪除。", { no: targetOrder.localOrderNo })'],
  ['`${order.localOrderNo} 退款`', 't("{no} 退款", { no: order.localOrderNo })'],
  ['`${updatedOrder.localOrderNo} 已退款。`', 't("{no} 已退款。", { no: updatedOrder.localOrderNo })'],
  ['`${updatedOrder.localOrderNo} 已全部退款。`', 't("{no} 已全部退款。", { no: updatedOrder.localOrderNo })'],
  [
    '`${updatedOrder.localOrderNo} 已完成部分退款。`',
    't("{no} 已完成部分退款。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`已結帳，但收據印唔出：${describeNoReceiptPrinterError()}`',
    't("已結帳，但收據印唔出：{error}", { error: describeNoReceiptPrinterError() })',
  ],
  ['`已結帳，但會員通狀態未同步：${message}`', 't("已結帳，但會員通狀態未同步：{message}", { message })'],

  // ─── 結帳成功 ──────────────────────────────────────────────
  ['`已收款 ${updatedOrder.localOrderNo}，等待製作完成。`', 't("已收款 {no}，等待製作完成。", { no: updatedOrder.localOrderNo })'],
  ['`已完成 ${updatedOrder.localOrderNo} 結帳。`', 't("已完成 {no} 結帳。", { no: updatedOrder.localOrderNo })'],
  [
    '`已離線記錄 ${updatedOrder.localOrderNo} 付款，待恢復網絡後補傳。`',
    't("已離線記錄 {no} 付款，待恢復網絡後補傳。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`已離線記錄 ${updatedOrder.localOrderNo} 付款，待補傳。`',
    't("已離線記錄 {no} 付款，待補傳。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`已免單 ${updatedOrder.localOrderNo}（${reason}）。`',
    't("已免單 {no}（{reason}）。", { no: updatedOrder.localOrderNo, reason })',
  ],
  [
    '`已離線記錄 ${updatedOrder.localOrderNo} 免單，待補傳。`',
    't("已離線記錄 {no} 免單，待補傳。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`客人已支付，但會員通狀態未同步：${message}`',
    't("客人已支付，但會員通狀態未同步：{message}", { message })',
  ],
  [
    '`客人已支付 ${updatedOrder.localOrderNo}，等待製作完成。`',
    't("客人已支付 {no}，等待製作完成。", { no: updatedOrder.localOrderNo })',
  ],
  [
    '`客人已支付，已完成 ${updatedOrder.localOrderNo}。`',
    't("客人已支付，已完成 {no}。", { no: updatedOrder.localOrderNo })',
  ],

  // ─── 桌面卡／枱面 title 屬性 ────────────────────────────────
  ['`訂單號：${row.orderNo}`', 't("訂單號：{no}", { no: row.orderNo })'],
  ['`返結 ${formatMacauTime(row.reopenedAt)}`', 't("返結 {time}", { time: formatMacauTime(row.reopenedAt) })'],
  ['`已返結 ×${row.reopenCount}`', 't("已返結 ×{n}", { n: row.reopenCount })'],
  ['`應收 ${formatMoney(row.total)}`', 't("應收 {amount}", { amount: formatMoney(row.total) })'],
  ['`訂單號：${orderBadge.text}`', 't("訂單號：{no}", { no: orderBadge.text })'],
  [
    '`應收 ${formatMoney(tableDueAmount, bootstrap.currency)}`',
    't("應收 {amount}", { amount: formatMoney(tableDueAmount, bootstrap.currency) })',
  ],
  [
    '`（${visibleTables.find((tbl) => tbl.id === openTableModalTableId)?.capacity} 座位）`',
    't("（{n} 座位）", { n: visibleTables.find((tbl) => tbl.id === openTableModalTableId)?.capacity })',
  ],

  // ─── 自助單接受／拒絕 ──────────────────────────────────────
  ['`已接受自助單 ${order.localOrderNo}`', 't("已接受自助單 {no}", { no: order.localOrderNo })'],
  ['`已拒絕自助單 ${order.localOrderNo}`', 't("已拒絕自助單 {no}", { no: order.localOrderNo })'],
  ['`已接受自助單 ${v.localOrderNo}`', 't("已接受自助單 {no}", { no: v.localOrderNo })'],
  ['`已拒絕自助單 ${v.localOrderNo}`', 't("已拒絕自助單 {no}", { no: v.localOrderNo })'],

  // ─── 結帳頁 / 折扣彈窗 ─────────────────────────────────────
  [
    '`待結帳單號 ${currentSettlementOrder.localOrderNo}`',
    't("待結帳單號 {no}", { no: currentSettlementOrder.localOrderNo })',
  ],
  ['`訂單 ${currentSettlementOrder.localOrderNo}`', 't("訂單 {no}", { no: currentSettlementOrder.localOrderNo })'],
  ['`${specModalItem.name} 規格`', 't("{name} 規格", { name: specModalItem.name })'],
  [
    '`${target.tableName} · 退回可編輯後重新結帳`',
    't("{table} · 退回可編輯後重新結帳", { table: target.tableName })',
  ],
  ['`${targetLabel} · 必須選擇打折原因`', 't("{label} · 必須選擇打折原因", { label: targetLabel })'],
  ['`${voidRequest.item.name} · 只退 1 份`', 't("{name} · 只退 1 份", { name: voidRequest.item.name })'],
  [
    '`全單折扣 · ${findDiscountPreset(localSettings.discounts, req.presetId)?.label ?? ""}`',
    't("全單折扣 · {label}", { label: findDiscountPreset(localSettings.discounts, req.presetId)?.label ?? "" })',
  ],
  [
    '`全額減免 · 應收 ${formatMoney(paymentBase.total, bootstrap.currency)} → 實收 ${formatMoney(0, bootstrap.currency)}`',
    't("全額減免 · 應收 {due} → 實收 {paid}", { due: formatMoney(paymentBase.total, bootstrap.currency), paid: formatMoney(0, bootstrap.currency) })',
  ],

  // ─── 會員餘額／獎賞券 ──────────────────────────────────────
  [
    '` · ${formatMoney(avosToMop(grant.rewardAmountAvos), bootstrap.currency)} 入餘額`',
    't(" · {amount} 入餘額", { amount: formatMoney(avosToMop(grant.rewardAmountAvos), bootstrap.currency) })',
  ],
  [
    '` · 本次扣 ${formatMoney(memberDeduction, bootstrap.currency)}`',
    't(" · 本次扣 {amount}", { amount: formatMoney(memberDeduction, bootstrap.currency) })',
  ],

  // ─── 購物車 / 商品 ─────────────────────────────────────────
  ['`只剩 ${remaining} 份，不能再加。`', 't("只剩 {n} 份，不能再加。", { n: remaining })'],
  ['`${item.name} 已售罄。`', 't("{name} 已售罄。", { name: item.name })'],

  // ─── 即時通知診斷 ─────────────────────────────────────────
  ['` · 渠道：${realtimeStatus}`', 't(" · 渠道：{status}", { status: realtimeStatus })'],
];
