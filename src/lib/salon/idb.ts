// Salon IndexedDB 離線硬化（Phase 7-C）
//
// 設計：
// - `kv` store：鏡像 salon localStorage 數據。斷網 / crash 後 reload，
//   可從 IDB 補回 localStorage（hydrateSalonFromIdb）。
// - `syncQueue` store：記 pending 變更（orders / bookings / printJobs），
//   重連網絡或页面可見時 flush 成 synced。
//
// 所有操作 best-effort、絕不拋錯，絕不影響現有 localStorage 熱路徑。
// 真後端 push 留 pushSalonMutation() seam，待 Ledger / 總部 API 到位。

import { SALON_STORAGE_KEYS } from "@/lib/salon/types";

const DB_NAME = "macau-pos-salon";
const DB_VERSION = 1;
const KV_STORE = "kv";
const QUEUE_STORE = "syncQueue";

export type SalonSyncQueueItem = {
  id: string;
  entity: "orders" | "bookings" | "printJobs" | "customers" | "bootstrap" | "packageTemplates" | "customerPackages" | "productSales" | "staffLeaves" | "staffShifts";
  refId: string;
  /** 整個 entity 陣列（由客戶端 save* 一併放入，避免再由 localStorage 還原造成循環 import） */
  payload: unknown;
  status: "pending" | "synced" | "failed";
  createdAt: string;
  syncedAt?: string;
  /** 失敗重推次數（舊 code 漏咗，導致 failed item 永遠唔刪、queue 無限增長） */
  attempts?: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> | null {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV_STORE)) {
          db.createObjectStore(KV_STORE, { keyPath: "k" });
        }
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null; // 開啟失敗唔快取，下次 call 再試
        reject(req.error);
      };
    } catch {
      dbPromise = null;
      reject(new Error("idb open failed"));
    }
  });
  return dbPromise;
}

// ── kv 鏡像 ──

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).put({ k: key, v: value });
  } catch {
    // ignore
  }
}

export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(KV_STORE, "readonly");
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? ((req.result as { v: T }).v) : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// ── sync-queue ──

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export async function idbEnqueue(item: Omit<SalonSyncQueueItem, "id" | "status" | "createdAt">): Promise<void> {
  const dbOrNull = openDb();
  const db = dbOrNull == null ? null : await dbOrNull.catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).put({
        id: uid("q"),
        status: "pending",
        createdAt: new Date().toISOString(),
        ...item,
      } satisfies SalonSyncQueueItem);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
  // 排完即試 flush：解決「一直 online、冇切 tab」時 queue 永遠冇人 push 嘅問題。
  // flush 經 chain 序列化（唔會同時開多個），內部按 entity dedupe + 離線時 fetch 自然失敗標 failed，零成本。
  void flushSalonSyncQueue();
}

export async function idbGetQueue(): Promise<SalonSyncQueueItem[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise<SalonSyncQueueItem[]>((resolve) => {
    try {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const req = tx.objectStore(QUEUE_STORE).getAll();
      req.onsuccess = () => resolve((req.result as SalonSyncQueueItem[]) ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function idbPatchQueueItem(id: string, patch: Partial<SalonSyncQueueItem>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      const store = tx.objectStore(QUEUE_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as SalonSyncQueueItem | undefined;
        if (existing) store.put({ ...existing, ...patch });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  }
}

async function idbDeleteQueueItem(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  }
}

function readActiveSalonStore(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SALON_STORAGE_KEYS.activeStore);
  } catch {
    return null;
  }
}

function eventTypeForEntity(entity: SalonSyncQueueItem["entity"]): string {
  if (entity === "customers") return "CUSTOMER_UPDATED";
  if (entity === "printJobs") return "PRINT_JOB_CREATED";
  if (entity === "orders") return "ORDER_SETTLED";
  if (entity === "bootstrap") return "BOOTSTRAP_UPDATED";
  if (entity === "packageTemplates") return "PACKAGE_TEMPLATE_UPDATED";
  if (entity === "customerPackages") return "CUSTOMER_PACKAGE_UPDATED";
  if (entity === "productSales") return "PRODUCT_SALE_CREATED";
  if (entity === "staffLeaves") return "STAFF_LEAVE_UPDATED";
  if (entity === "staffShifts") return "STAFF_SHIFT_UPDATED";
  return "BOOKING_UPDATED";
}

/**
 * 真後端 push：將 pending 變更 POST 去 /api/salon/sync（POS Supabase）。
 * payload 由客戶端 save* 一併放入 sync-queue，唔使再由 localStorage 還原，
 * 避免與 storage.ts 形成循環 import。
 */
async function pushSalonMutation(item: SalonSyncQueueItem): Promise<boolean> {
  if (item.payload === undefined || item.payload === null) return true;
  const storeId = readActiveSalonStore() ?? undefined;
  try {
    const res = await fetch("/api/salon/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId,
        events: [{ type: eventTypeForEntity(item.entity), entityId: item.refId, payload: item.payload }],
      }),
    });
    console.log(`[salon-sync] pushed ${item.entity} -> ${res.ok ? "ok" : "http " + res.status}`);
    return res.ok;
  } catch {
    console.log(`[salon-sync] push failed (offline?): ${item.entity}`);
    return false;
  }
}

// ── flush（序列化 + 去重 + 成功即刪，解決 queue 無限增長 + 寫覆蓋競態）──

const MAX_SYNC_ATTEMPTS = 5; // 同一 item 最多推 MAX 次，之後放棄（數據已喺 localStorage / IDB kv mirror，唔會丟失）
const MAX_FLUSH_LOOP = 50; // 防止離線時 flush 內部無限重推嘅安全閥

// 用 chain 串起所有 flush：並發呼叫者排喺上一趟之後跑，確保新 enqueue 嘅 item 唔會漏推，
// 又唔會同時開多個 flush 搶同一個 queue（解決重複上推 + 寫覆蓋競態）。
let flushChain: Promise<void> = Promise.resolve();

/**
 * 重連 / 頁面可見 / 每次 enqueue 後都會 call。
 * 唔再用 navigator.onLine 做硬性擋（好多環境會誤報 offline，令 sync 永遠唔發）；
 * 直接試 fetch，離線嗰陣 fetch 自然失敗並標 failed，下次 retry。
 */
export async function flushSalonSyncQueue(): Promise<void> {
  const run = flushChain.then(() => flushLoop());
  flushChain = run.catch(() => {}); // 永遠指去最新一趟，等下次 call 會等埋今次
  return run;
}

async function flushLoop(): Promise<void> {
  for (let i = 0; i < MAX_FLUSH_LOOP; i++) {
    const queue = await idbGetQueue();
    if (queue.length === 0) return;

    // 清屋仔：舊 code 成功後標 `synced` 但永遠唔刪，留低嘅殘餘 entry 一併清走（修無限增長）
    const synced = queue.filter((it) => it.status === "synced");
    for (const s of synced) await idbDeleteQueueItem(s.id);

    const pending = queue.filter((it) => it.status === "pending" || it.status === "failed");
    if (pending.length === 0) return;

    const deleted = await flushBatch(pending);
    // 離線 / 後端未到位：呢輪全部失敗（deleted=0）就收手，等下次觸發，避免無限重推
    if (deleted === 0) return;
  }
}

/** 處理一批 pending / failed：同一 entity 只推最新一份（payload 已係整個陣列），成功即刪、失敗計次。 */
async function flushBatch(pending: SalonSyncQueueItem[]): Promise<number> {
  // 同一 entity 只推最新一份（按 createdAt 取最新，payload 已係整個陣列），減少重複上傳
  const latestByEntity = new Map<SalonSyncQueueItem["entity"], SalonSyncQueueItem>();
  for (const item of pending) {
    const cur = latestByEntity.get(item.entity);
    if (!cur || item.createdAt > cur.createdAt) latestByEntity.set(item.entity, item);
  }

  let deleted = 0;
  for (const latest of latestByEntity.values()) {
    const ok = await pushSalonMutation(latest);
    for (const item of pending) {
      if (item.entity !== latest.entity) continue;
      if (ok) {
        // 成功：直接刪（最新 payload 已含整個陣列，同 entity 舊 entry 被涵蓋，唔使留）
        await idbDeleteQueueItem(item.id);
        deleted++;
      } else {
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts >= MAX_SYNC_ATTEMPTS) {
          // 試夠 MAX 次都推唔出（後端未到位 / 離線）：放棄呢個通知，唔使留低霸住 IDB
          await idbDeleteQueueItem(item.id);
        } else {
          await idbPatchQueueItem(item.id, {
            status: "failed",
            attempts,
            syncedAt: new Date().toISOString(),
          });
        }
      }
    }
  }
  return deleted;
}

/**
 * 從 IDB 補回 localStorage：只補「localStorage 現時無、但 IDB 有」嘅鍵。
 * 用喺 reload / 清空 localStorage 後嘅恢復。best-effort。
 */
export async function hydrateSalonFromIdb(mirrorKeys: string[]): Promise<void> {
  if (typeof window === "undefined") return;
  for (const key of mirrorKeys) {
    let hasLocal = false;
    try {
      hasLocal = window.localStorage.getItem(key) !== null;
    } catch {
      hasLocal = false;
    }
    if (hasLocal) continue;
    const value = await idbGet<unknown>(key);
    if (value === null) continue;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota / private mode
    }
  }
}
