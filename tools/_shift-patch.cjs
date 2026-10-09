// shift-page.tsx i18n hand-pass patch (assert-count, CRLF-safe).
// Dry run by default; pass --write to land when every edit hits its expected count.
const fs = require("fs");
const PATH = "src/components/shift-page.tsx";
const write = process.argv.includes("--write");
let src = fs.readFileSync(PATH, "utf8").replace(/\r\n/g, "\n");

const FAIL = [];
function ed(find, replace, expect) {
  const parts = src.split(find);
  const count = parts.length - 1;
  if (count !== expect) FAIL.push(`EXPECT ${expect} GOT ${count} :: ${find.slice(0, 48)}`);
  if (write && count === expect) src = parts.join(replace);
}

// ── A. helpers / module scope ──────────────────────────────────────────────
ed('const MACAU_WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];',
   'const MACAU_WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];\nconst SHIFT_WEEKDAY_LABELS = ["（週日）", "（週一）", "（週二）", "（週三）", "（週四）", "（週五）", "（週六）"];', 1);

ed('function shiftHistoryDayLabel(day: string): string {\n  const parts = day.split("-");\n  if (parts.length !== 3) return day;\n  const wd = MACAU_WEEKDAY_LABELS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";\n  return `${parts[2]}/${parts[1]}/${parts[0]}（週${wd}）`;\n}',
   'function shiftHistoryDayLabel(day: string, t: (k: string, vars?: Record<string, string | number>) => string): string {\n  const parts = day.split("-");\n  if (parts.length !== 3) return day;\n  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();\n  const weekday = SHIFT_WEEKDAY_LABELS[wd] ?? "";\n  return `${parts[2]}/${parts[1]}/${parts[0]}${weekday ? t(weekday) : ""}`;\n}', 1);

ed('label: shiftHistoryDayLabel(day),', 'label: shiftHistoryDayLabel(day, t),', 1);
ed('      table: ledgerFulfillmentLabel(o.fulfillmentType),', '      table: t(ledgerFulfillmentLabel(o.fulfillmentType)),', 1);
ed('const [status, setStatus] = useState("開工後可於下班時做結數交班並打印交班單。");',
   'const [status, setStatus] = useState(t("開工後可於下班時做結數交班並打印交班單。"));', 1);

// ── B. setStatus / setLedgerTodayError ─────────────────────────────────────
ed("`已同步雲端班次狀態（另一部裝置已開工：${formatMacauDateTime(result.shift.openedAt)}），可以直接交班。`",
   't(`已同步雲端班次狀態（另一部裝置已開工：{openedAt}），可以直接交班。`, { openedAt: formatMacauDateTime(result.shift.openedAt) })', 1);
ed('"已同步雲端班次狀態。"', 't("已同步雲端班次狀態。")', 1);
ed('setStatus("班次狀態已與雲端同步。");', 'setStatus(t("班次狀態已與雲端同步。"));', 1);
ed('setLedgerTodayError("尚未登入 Ledger，無法讀取今日線上訂單。");', 'setLedgerTodayError(t("尚未登入 Ledger，無法讀取今日線上訂單。"));', 1);
ed('error instanceof Error ? error.message : "讀取今日線上報表失敗"', 'error instanceof Error ? error.message : t("讀取今日線上報表失敗")', 1);
ed('else failures.push(result.error ?? "未知錯誤");', 'else failures.push(result.error ?? t("未知錯誤"));', 1);
ed("`已補推 ${ok} 張線上單至「已完成」。`", 't(`已補推 {ok} 張線上單至「已完成」。`, { ok })', 1);
ed("`補推完成：成功 ${ok} 張、失敗 ${failures.length} 張（${failures[0]}）`",
   't(`補推完成：成功 {ok} 張、失敗 {fail} 張（{first}）`, { ok, fail: failures.length, first: failures[0] ?? "" })', 1);
ed("`已把 ${row.closedAt.slice(0, 10)} 的交班單加入重打隊列。`",
   't(`已把 {date} 的交班單加入重打隊列。`, { date: row.closedAt.slice(0, 10) })', 1);
ed('setStatus("目前離線，無法強制同步。請恢復網絡後再交班。");', 'setStatus(t("目前離線，無法強制同步。請恢復網絡後再交班。"));', 1);
ed('        setStatus(\n          `有 ${failedCount} 筆資料永久同步失敗（伺服器連續拒收），已跳過，` +\n            `唔會阻住交班。請稍後喺落單畫面撳「重試同步」，或聯絡技術支援。`,\n        );',
   '        setStatus(\n          t(`有 {n} 筆資料永久同步失敗（伺服器連續拒收），已跳過，唔會阻住交班。請稍後喺落單畫面撳「重試同步」，或聯絡技術支援。`, { n: failedCount }),\n        );', 1);
ed('setStatus("強制同步失敗，請檢查網絡或稍後重試。");', 'setStatus(t("強制同步失敗，請檢查網絡或稍後重試。"));', 1);
ed('      setStatus(\n        `同步失敗（HTTP ${res.status}）：${detail.slice(0, 200) || "伺服器拒收"}。` +\n          `資料仲喺本機未上傳，請稍後再試或聯絡技術支援。`,\n      );',
   '      setStatus(\n        t(`同步失敗（HTTP {status}）：{detail}。資料仲喺本機未上傳，請稍後再試或聯絡技術支援。`, { status: res.status, detail: detail.slice(0, 200) || t("伺服器拒收") }),\n      );', 1);
ed('    setStatus(\n      `已同步 ${retryable.length} 筆待辦資料，準備交班。` +\n        (failedCount > 0 ? `（另有 ${failedCount} 筆永久失敗已跳過）` : ""),\n    );',
   '    setStatus(\n      t(`已同步 {n} 筆待辦資料，準備交班。`, { n: retryable.length }) +\n        (failedCount > 0 ? t(`（另有 {n} 筆永久失敗已跳過）`, { n: failedCount }) : ""),\n    );', 1);
ed('setStatus("已開工。");', 'setStatus(t("已開工。"));', 1);
ed('setStatus("已離線開工：恢復網絡後會自動同步到雲端（其他裝置會見到已開工）。");', 'setStatus(t("已離線開工：恢復網絡後會自動同步到雲端（其他裝置會見到已開工）。"));', 1);
ed('        setStatus(\n          `本店已有班次進行中（另一部裝置已於 ${formatMacauDateTime(merged.openedAt)} 開工），已同步該開工狀態。`,\n        );',
   '        setStatus(\n          t(`本店已有班次進行中（另一部裝置已於 {openedAt} 開工），已同步該開工狀態。`, { openedAt: formatMacauDateTime(merged.openedAt) }),\n        );', 1);
ed('setStatus("已開工，並已同步到雲端（其他裝置會見到已開工）。");', 'setStatus(t("已開工，並已同步到雲端（其他裝置會見到已開工）。"));', 1);
ed('setStatus("已開工，但暫時未能同步伺服器；恢復網絡後會自動補同步。");', 'setStatus(t("已開工，但暫時未能同步伺服器；恢復網絡後會自動補同步。"));', 1);
ed('"已交班（交班單打印已關閉，如需紙本請到交班歷史「重打」）。" +',
   't("已交班（交班單打印已關閉，如需紙本請到交班歷史「重打」）。") +', 1);
ed('? `已交班，交班明細（${snapshot.shiftNo}）已加入打印隊列，狀態已重置為待開工。`',
   '? t(`已交班，交班明細（{no}）已加入打印隊列，狀態已重置為待開工。`, { no: snapshot.shiftNo })', 1);
ed(': `已交班（跳過打印，單號 ${snapshot.shiftNo}），狀態已重置為待開工。`',
   ': t(`已交班（跳過打印，單號 {no}），狀態已重置為待開工。`, { no: snapshot.shiftNo })', 1);
ed('(serverCloseFailed ? "（⚠️ 收工狀態未能同步雲端，將自動重試，其他裝置可能仍顯示已開工。）" : "（雲端已同步，其他裝置會顯示已收工。）")',
   '(serverCloseFailed ? t("（⚠️ 收工狀態未能同步雲端，將自動重試，其他裝置可能仍顯示已開工。）") : t("（雲端已同步，其他裝置會顯示已收工。）"))', 1);
ed('setStatus("已更新本機備註；離線中，未同步雲端。");', 'setStatus(t("已更新本機備註；離線中，未同步雲端。"));', 1);
ed('      setStatus(\n        ok ? "已更新備註並同步雲端（換機都見到）。" : "已更新本機備註；雲端搵唔到對應班次，未同步。",\n      );',
   '      setStatus(\n        ok ? t("已更新備註並同步雲端（換機都見到）。") : t("已更新本機備註；雲端搵唔到對應班次，未同步。"),\n      );', 1);
ed('setStatus("已更新本機備註；雲端同步失敗，請檢查網絡後再試。");', 'setStatus(t("已更新本機備註；雲端同步失敗，請檢查網絡後再試。"));', 1);
ed('setStatus("已更新交班歷史備註。");', 'setStatus(t("已更新交班歷史備註。"));', 1);
ed('setStatus("已刪除交班歷史。");', 'setStatus(t("已刪除交班歷史。"));', 1);
ed('setStatus("目前沒有符合條件的交班歷史可導出。");', 'setStatus(t("目前沒有符合條件的交班歷史可導出。"));', 1);
ed('setStatus("交班歷史 CSV 已導出。");', 'setStatus(t("交班歷史 CSV 已導出。"));', 1);

// ── C. data labels ─────────────────────────────────────────────────────────
ed('cashier: o.settledByName ?? o.settledBy ?? "未記錄",', 'cashier: o.settledByName ?? o.settledBy ?? t("未記錄"),', 1);
ed('method: paymentModeLabel(o.paymentMode) || "線上單",', 'method: paymentModeLabel(o.paymentMode) || t("線上單"),', 1);
ed('cashier: "客人",', 'cashier: t("客人"),', 1);
ed('row.employeeName ?? row.employeeAccount ?? "未記錄"]),', 'row.employeeName ?? row.employeeAccount ?? t("未記錄")]),', 1);
ed('{row.employeeName ?? row.employeeAccount ?? "未記錄"}', '{row.employeeName ?? row.employeeAccount ?? t("未記錄")}', 1);

// ── D. closeGateNow labels ─────────────────────────────────────────────────
ed('"未接通"', 't("未接通")', 2);
ed('"營業中"', 't("營業中")', 1);
ed('"已暫停"', 't("已暫停")', 2);
ed('"接單中"', 't("接單中")', 1);

// ── E. JSX render ──────────────────────────────────────────────────────────
ed('{lastCloseGate.store === "failed" ? "店內接單（掃碼／自助機）" : ""}',
   '{lastCloseGate.store === "failed" ? t("店內接單（掃碼／自助機）") : ""}', 1);
ed('{lastCloseGate.store === "failed" && lastCloseGate.online === "failed" ? "、" : ""}',
   '{lastCloseGate.store === "failed" && lastCloseGate.online === "failed" ? t("、") : ""}', 1);
ed('{lastCloseGate.online === "failed" ? "線上接單" : ""}',
   '{lastCloseGate.online === "failed" ? t("線上接單") : ""}', 1);
ed('{`已開工：${shift.employeeName ?? shift.employeeAccount ?? ""}${shift.employeeName || shift.employeeAccount ? " · " : ""}${formatMacauDateTime(shift.openedAt)}`}',
   '{`${t("已開工：")}${shift.employeeName ?? shift.employeeAccount ?? ""}${shift.employeeName || shift.employeeAccount ? t(" · ") : ""}${formatMacauDateTime(shift.openedAt)}`}', 1);
ed('? `＝實收金額合計（毛）− ${summary.refundCount} 張退款單嘅退款總額 ${formatMoney(summary.refundAmount)}`',
   '? t(`＝實收金額合計（毛）− {n} 張退款單嘅退款總額 {amt}`, { n: summary.refundCount, amt: formatMoney(summary.refundAmount) })', 1);
ed(': "本班次沒有退款單，所以「淨實收」＝「實收金額合計」。"}',
   ': t("本班次沒有退款單，所以「淨實收」＝「實收金額合計」。")', 1);
ed('? `｜其中 ${ledgerPaidOrders?.incompleteCount} 張未標記完成（${formatMoney(ledgerPaidOrders?.incompleteAmountMop ?? 0)}）`',
   '? t(`｜其中 {n} 張未標記完成（{amt}）`, { n: ledgerPaidOrders?.incompleteCount ?? 0, amt: formatMoney(ledgerPaidOrders?.incompleteAmountMop ?? 0) })', 1);
ed('{formatMoney(ledgerOnlyOnline.amountMop)}）', '{formatMoney(ledgerOnlyOnline.amountMop)}{t("）")}', 1);
ed('{dup ? "（本地已有 → 唔重複計）" : ""}', '{dup ? t("（本地已有 → 唔重複計）") : ""}', 1);
ed('? `｜已由雲端同步 ${historyCloudCount} 筆（換機／多部機共用同一份）`',
   '? t(`｜已由雲端同步 {n} 筆（換機／多部機共用同一份）`, { n: historyCloudCount })', 1);
ed(': "｜交班記錄要上雲後才會跨機顯示。"', ': t("｜交班記錄要上雲後才會跨機顯示。")', 1);
ed('emptyText="今天暫無已結帳訂單。"', 'emptyText={t("今天暫無已結帳訂單。")}', 1);
ed('{exportingType === "csv" ? "同步中…" : "導出 CSV"}', '{exportingType === "csv" ? t("同步中…") : t("導出 CSV")}', 1);
ed('? "（本機同雲端都未有已收工班次；完成一次「結數交班」後就會出現，換機登入都睇得返。）"',
   '? t("（本機同雲端都未有已收工班次；完成一次「結數交班」後就會出現，換機登入都睇得返。）")', 1);
ed('{reprintingShiftId === row.id ? "打印中…" : "重打交班單"}', '{reprintingShiftId === row.id ? t("打印中…") : t("重打交班單")}', 1);
ed('? `查看更多（再載入 ${Math.min(\n                        SHIFT_HISTORY_PAGE_DAYS,\n                        shiftHistoryDayGroups.length - shiftHistoryVisibleGroups.length,\n                      )} 天）`',
   '? t(`查看更多（再載入 {n} 天）`, { n: Math.min(\n                        SHIFT_HISTORY_PAGE_DAYS,\n                        shiftHistoryDayGroups.length - shiftHistoryVisibleGroups.length,\n                      ) })', 1);
ed(': "已全部載入"', ': t("已全部載入")', 1);
// modal title/description (ResponsiveModal renders raw)
ed('? "結數交班 · 核對金額"', '? t("結數交班 · 核對金額")', 1);
ed('? "二次確認 · 交班後無法更改"', '? t("二次確認 · 交班後無法更改")', 1);
ed(': "交班明細 · 打印預覽"', ': t("交班明細 · 打印預覽")', 1);
ed('? "系統已自動彙總今日所有金額。請先點算現金箱：若與應收現金有落差，喺下面輸入差額；冇落差可直接進行下一步。"',
   '? t("系統已自動彙總今日所有金額。請先點算現金箱：若與應收現金有落差，喺下面輸入差額；冇落差可直接進行下一步。")', 1);
ed('? "交班後本班次會寫入歷史並切回「未開工」，金額與差額記錄即鎖定、不可再更改。請最後核對下列數字。"',
   '? t("交班後本班次會寫入歷史並切回「未開工」，金額與差額記錄即鎖定、不可再更改。請最後核對下列數字。")', 1);
ed(': "以下為固定格式交班明細（內容同版面不可編輯）。按「打印」由指定打印機出紙並完成交班；按「跳過」唔打印直接完成交班。"',
   ': t("以下為固定格式交班明細（內容同版面不可編輯）。按「打印」由指定打印機出紙並完成交班；按「跳過」唔打印直接完成交班。")', 1);
ed('{closingShift ? "處理中…" : "打印"}', '{closingShift ? t("處理中…") : t("打印")}', 1);
ed('{closingDiffValue < 0 ? "少收／短款" : "多收／長款"}', '{closingDiffValue < 0 ? t("少收／短款") : t("多收／長款")}', 2);
ed('? `⚠ 仲有 ${queueSummary.pendingEvents} 筆資料未同步上雲，交班前會先強制同步。`',
   '? t(`⚠ 仲有 {n} 筆資料未同步上雲，交班前會先強制同步。`, { n: queueSummary.pendingEvents })', 2);
ed('? `⚠ ${queueSummary.failedEvents} 筆資料永久同步失敗（已跳過，唔會阻住交班）。`',
   '? t(`⚠ {n} 筆資料永久同步失敗（已跳過，唔會阻住交班）。`, { n: queueSummary.failedEvents })', 2);
ed('{closingDiffValue === undefined ? "無（0）" : formatMoney(closingDiffValue)}', '{closingDiffValue === undefined ? t("無（0）") : formatMoney(closingDiffValue)}', 1);
ed('{closingActualCash !== null ? formatMoney(closingActualCash) : "--（無盤點記錄）"}', '{closingActualCash !== null ? formatMoney(closingActualCash) : t("--（無盤點記錄）")}', 1);
ed('{closingNote.trim() || "（無）"}', '{closingNote.trim() || t("（無）")}', 1);
ed('? `仲有 ${queueSummary.pendingEvents} 筆資料待同步（交班前會先強制同步）。`',
   '? t(`仲有 {n} 筆資料待同步（交班前會先強制同步）。`, { n: queueSummary.pendingEvents })', 1);
ed('? `${queueSummary.failedEvents} 筆永久失敗已跳過。`', '? t(`{n} 筆永久失敗已跳過。`, { n: queueSummary.failedEvents })', 1);
ed('? `${queueSummary.skippedEvents} 筆無歸屬資料（外店／未登入時產生）唔會上雲，已跳過。`',
   '? t(`{n} 筆無歸屬資料（外店／未登入時產生）唔會上雲，已跳過。`, { n: queueSummary.skippedEvents })', 1);
ed('? "交班後：將一併關閉本店「線上 + 線下」接單（客人掃碼／自助機／線上點餐一律停單）。"',
   '? t("交班後：將一併關閉本店「線上 + 線下」接單（客人掃碼／自助機／線上點餐一律停單）。")', 1);
ed(': "交班後：接單狀態不變（客人仍可掃碼、自助機、線上落單）。"',
   ': t("交班後：接單狀態不變（客人仍可掃碼、自助機、線上落單）。")', 1);
ed('{previewData.cash.diff < 0 ? "少收" : "多收"}', '{previewData.cash.diff < 0 ? t("少收") : t("多收")}', 1);

if (FAIL.length) {
  console.log("❌ " + FAIL.length + " mismatch(es):");
  FAIL.forEach((f) => console.log("  " + f));
  process.exit(1);
}
if (write) {
  fs.writeFileSync(PATH, src.replace(/\n/g, "\r\n"));
  console.log("✅ all edits landed");
} else {
  console.log("✅ dry run OK — all counts matched (" + "pass" + ")");
}
