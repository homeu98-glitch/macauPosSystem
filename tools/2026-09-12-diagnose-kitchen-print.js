/**
 * 2026-09-12 廚房單「冇出紙」唯讀診斷腳本
 *
 * 用法：喺 POS 裝置嘅瀏覽器 DevTools Console 貼上整份檔案內容再按 Enter。
 *      （或者：Console 打  fetch('/...') 唔適用 → 一定要喺 POS 同一頁面貼）
 *
 * ⚠️ 完全唯讀：只讀 localStorage，唔會寫入 / 唔會改任何設定、唔會產生打印任務。
 *
 * 判讀重點：
 *   1) [toggles]  線上訂單 / 廚房單 係咪 false → 廚房單會靜默唔出（ledger-pos-bridge.ts:186/192）
 *   2) [printers] 有冇 role=zone / label 而且 enabled → 冇 = 廚房單永遠建立唔到
 *   3) [jobs]     今日有冇 printerGroup !== 'receipt' 嘅 job → 冇 = job 由頭到尾冇建立
 *   4) [queue]    有冇 PRINT_JOB_CREATED 卡喺 pending/failed → 有 = 出紙上唔到雲
 *
 * @see docs/reviews/online-order-kitchen-print-audit-2026-09-12.md
 */
(() => {
  const LS = window.localStorage;
  const keys = Object.keys(LS).filter((k) => k.startsWith("macau-pos/"));
  const read = (k) => {
    try {
      return JSON.parse(LS.getItem(k));
    } catch {
      return null;
    }
  };
  const stores = Array.from(new Set(keys.map((k) => (k.match(/^macau-pos\/stores\/([^/]+)\//) || [])[1]).filter(Boolean)));

  console.log("%c=== 廚房單診斷（唯讀） ===", "font-weight:bold");
  console.log("localStorage 全部 macau-pos/* keys：", keys);
  console.log("偵測到店鋪 scope：", stores);

  for (const store of stores) {
    const p = (suffix) => read(`macau-pos/stores/${store}/${suffix}`);
    const cfg = p("device-config");
    const local = p("local-settings");
    const jobs = p("print-jobs") || [];
    const queue = p("sync-queue") || [];
    const today = new Date().toISOString().slice(0, 10);

    console.group(`%c店鋪 ${store}`, "font-weight:bold;color:#0b7285");

    // 1) 細粒度開關
    const t = local?.printContentToggles || {};
    console.log("[toggles] printContentToggles =", t, "| autoPrint =", local?.autoPrint);
    const onlineOff = t.online === false;
    const kitchenOff = t.kitchen === false;
    const labelOff = t.label === false;
    if (onlineOff) console.warn("→ 「線上訂單」開關係 false：線上單廚房單會靜默唔出（ledger-pos-bridge.ts:186）");
    if (kitchenOff && labelOff) console.warn("→ 「廚房單」＋「飲品標籤單」都係 false：任何路徑都唔會出廚房單");
    if (!onlineOff && !(kitchenOff && labelOff)) console.log("→ 開關層面 OK（未見靜默關閉）");

    // 2) 打印機
    const printers = (cfg?.printers || []).map((x) => ({
      name: x.name,
      role: x.role,
      zoneId: x.zoneId ?? "",
      enabled: x.enabled,
      conn: x.connectionType,
      paper: x.paperSize,
    }));
    console.table(printers);
    const usable = printers.filter((x) => x.enabled && (x.role === "zone" || x.role === "label"));
    if (usable.length === 0) {
      console.error("→ 冇任何 enabled 嘅 zone/label 打印機！廚房單一定建立唔到（ledger-pos-bridge.ts:204-213 throw；print-jobs.ts:204 靜默回空）");
    } else {
      console.log(`→ 可用廚房/標籤機 ${usable.length} 台：`, usable.map((x) => `${x.name}(${x.role}${x.zoneId ? ":" + x.zoneId : " 全接"})`));
    }

    // 3) 打印 job 分佈
    const byGroup = {};
    const byTicket = {};
    for (const j of jobs) {
      byGroup[j.printerGroup || "(空)"] = (byGroup[j.printerGroup || "(空)"] || 0) + 1;
      byTicket[j.ticketType || "(空)"] = (byTicket[j.ticketType || "(空)"] || 0) + 1;
    }
    const todayJobs = jobs.filter((j) => String(j.createdAt || "").slice(0, 10) === today);
    console.log(`[jobs] 本機共 ${jobs.length} 張（今日 ${today.length ? todayJobs.length : 0} 張）`);
    console.log("      按 printerGroup：", byGroup, " 按 ticketType：", byTicket);
    const kitchenJobs = jobs.filter((j) => j.printerGroup !== "receipt" && (j.items || []).length > 0);
    if (kitchenJobs.length === 0) {
      console.warn("→ 本機一張廚房類 job 都冇 → 印唔出唔係 relay 問題，係 job 由頭到尾冇被建立");
    } else {
      console.log("→ 廚房類 job（最近 10 張）：");
      console.table(
        kitchenJobs.slice(-10).map((j) => ({
          orderId: j.orderId,
          orderNo: j.orderNo,
          group: j.printerGroup,
          printer: j.printerName,
          status: j.status,
          hasTemplate: Array.isArray(j.template?.blocks) && j.template.blocks.length > 0,
          hasContent: Boolean(j.content),
          createdAt: j.createdAt,
        })),
      );
      console.info("   （hasTemplate / hasContent 為 false = 舊式體，靠 APK fallback 渲染，見 dispatch.ts:53-55）");
    }

    // 4) 同步隊列（上唔到雲 = 出唔到紙）
    const printEvents = queue.filter((e) => e.type === "PRINT_JOB_CREATED");
    const stuck = printEvents.filter((e) => e.status !== "synced");
    console.log(`[queue] PRINT_JOB_CREATED ${printEvents.length} 個，未 synced ${stuck.length} 個`);
    if (stuck.length > 0) {
      console.warn("→ 有打印事件未上雲 → 中繼 APK claim 唔到 → 零出紙（docs/113 §建單後淨寫本機）");
      console.table(stuck.slice(0, 10).map((e) => ({ id: e.id, status: e.status, createdAt: e.createdAt, err: e.lastError })));
    }
    console.groupEnd();
  }

  console.log("%c=== 完（以上全部唯讀） ===", "font-weight:bold");
})();
