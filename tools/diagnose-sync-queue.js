/**
 * 診斷「仲有 N 筆資料未同步上雲」——喺 POS / Kiosk 畫面按 F12 → Console 貼上執行。
 *
 * 只讀 localStorage，唔改任何資料。
 * 對應程式碼：src/lib/storage.ts（loadQueue / storeScopedStorageKey）、
 *            src/lib/pos/sync-flush.ts（doFlush 的跨店過濾 + 同 entityId 去重）。
 */
(() => {
  const read = (k, fb) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fb;
    } catch {
      return fb;
    }
  };

  const session = read("macau-pos/auth-session", null);
  const mid = session?.merchantId ?? null;
  const queueKey = mid ? `macau-pos/stores/${mid}/sync-queue` : "macau-pos/sync-queue";

  const out = { merchantId: mid, queueKey, keys: [] };

  // 所有 sync-queue 相關 key（含舊版全局 key 同其他店）
  Object.keys(localStorage).forEach((k) => {
    if (k.includes("sync-queue")) {
      const arr = read(k, []);
      out.keys.push({ key: k, count: Array.isArray(arr) ? arr.length : "非陣列" });
    }
  });

  const queue = read(queueKey, []);
  if (!Array.isArray(queue)) {
    console.log("❌ queue 唔係陣列：", queueKey, queue);
    return out;
  }

  const by = (arr, fn) =>
    arr.reduce((acc, x) => {
      const k = String(fn(x));
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

  const pending = queue.filter((e) => e.status === "pending");
  const failed = queue.filter((e) => e.status === "failed");
  const synced = queue.filter((e) => e.status === "synced");

  out.總覽 = {
    總數: queue.length,
    pending: pending.length,
    synced: synced.length,
    failed: failed.length,
  };

  // A) pending 按「事件自帶 storeId」分組 —— 只有 === 當前店 嘅會被推送
  out.pending_按storeId = by(pending, (e) =>
    e.storeId === undefined ? "(undefined：永遠唔推)" : e.storeId === mid ? "= 當前店（可推）" : `外店 ${e.storeId}（永遠唔推）`,
  );

  // B) pending 按事件類型
  out.pending_按類型 = by(pending, (e) => e.type ?? "(無 type)");

  // C) 「去重輸家」：同一 entityId + 同一店 底下唔係最新嗰條 → doFlush 每次只推最新一條，
  //    呢啲永遠選唔中、永遠留喺 pending（數據其實已經由最新嗰條上咗雲）
  const ts = (e) => Date.parse(e.createdAt ?? "") || 0;
  const scopedAll = queue.filter((e) => e.storeId === mid && e.entityId);
  const latestByEntity = new Map();
  for (const e of scopedAll) {
    const prev = latestByEntity.get(e.entityId);
    if (!prev || ts(prev) < ts(e) || (ts(prev) === ts(e) && String(prev.id) < String(e.id))) {
      latestByEntity.set(e.entityId, e);
    }
  }
  const dedupLosers = pending.filter((e) => {
    if (e.storeId !== mid) return false;
    const latest = latestByEntity.get(e.entityId);
    return latest && latest.id !== e.id;
  });
  out.去重輸家_永遠推唔到 = { 筆數: dedupLosers.length, 按類型: by(dedupLosers, (e) => e.type ?? "(無 type)") };

  // D) 當前店、唔係去重輸家嘅 pending = 真正會被推送嘅（正常會喺 30s 內清走）
  const loserIds = new Set(dedupLosers.map((e) => e.id));
  const realPending = pending.filter((e) => e.storeId === mid && !loserIds.has(e.id));
  out.真_待推送 = { 筆數: realPending.length, 按類型: by(realPending, (e) => e.type ?? "(無 type)") };

  // E) attempts 分佈（>=5 會被標 failed；<5 但一直失敗會累積）
  out.attempts分佈 = by(pending, (e) => `attempts=${e.attempts ?? 0}`);

  // F) 抽樣
  out.pending_最舊5筆 = pending
    .slice()
    .sort((a, b) => ts(a) - ts(b))
    .slice(0, 5)
    .map((e) => ({ id: e.id, type: e.type, entityId: e.entityId, storeId: e.storeId, createdAt: e.createdAt, attempts: e.attempts ?? 0 }));
  out.pending_最新5筆 = pending
    .slice()
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, 5)
    .map((e) => ({ id: e.id, type: e.type, entityId: e.entityId, storeId: e.storeId, createdAt: e.createdAt, attempts: e.attempts ?? 0 }));

  // eslint-disable-next-line no-console
  console.log("%c同步隊列診斷", "font-weight:bold;font-size:14px", out);
  return out;
})();
