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

const DB_NAME = "macau-pos-salon";
const DB_VERSION = 1;
const KV_STORE = "kv";
const QUEUE_STORE = "syncQueue";

export type SalonSyncQueueItem = {
  id: string;
  entity: "orders" | "bookings" | "printJobs";
  refId: string;
  status: "pending" | "synced" | "failed";
  createdAt: string;
  syncedAt?: string;
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
      req.onerror = () => reject(req.error);
    } catch {
      reject(new Error("idb open failed"));
    }
  });
  // 吞掉開啟失敗，caller 不會因 IDB 出事而掛掉
  void dbPromise.catch(() => undefined);
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
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).put({
      id: uid("q"),
      status: "pending",
      createdAt: new Date().toISOString(),
      ...item,
    } satisfies SalonSyncQueueItem);
  } catch {
    // ignore
  }
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
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    const store = tx.objectStore(QUEUE_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as SalonSyncQueueItem | undefined;
      if (existing) store.put({ ...existing, ...patch });
    };
  } catch {
    // ignore
  }
}

/**
 * 真後端 push seam：Ledger / 總部 API 到位後，喺此發送 mutation。
 * 目前 local-only，直接當作成功。回傳 false 會令 queue item 標 failed。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function pushSalonMutation(_item: SalonSyncQueueItem): Promise<boolean> {
  return true;
}

/** 處理 pending 變更：本地模式直接標 synced（模擬成功 push）。 */
export async function flushSalonSyncQueue(): Promise<void> {
  if (typeof window !== "undefined" && typeof navigator !== "undefined" && !navigator.onLine) {
    return;
  }
  const queue = await idbGetQueue();
  const pending = queue.filter((item) => item.status === "pending");
  for (const item of pending) {
    const ok = await pushSalonMutation(item);
    await idbPatchQueueItem(item.id, {
      status: ok ? "synced" : "failed",
      syncedAt: new Date().toISOString(),
    });
  }
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
