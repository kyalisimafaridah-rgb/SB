// Thin, generic wrapper around IndexedDB — no external dependency, since we
// can't verify a new npm package would actually resolve/build correctly in
// this environment. Two kinds of stores:
//   - cache_* stores: last-known-good copies of server data (students,
//     classes, fee records, fee structures) so pages have something real to
//     render when there's no connection, instead of an empty/broken screen.
//   - outbox: mutations recorded while offline, queued in the order they
//     happened, waiting to be replayed against the server once back online.
//
// IMPORTANT: this cache is scoped per school (schoolId is part of every key)
// so switching accounts on the same device never leaks one school's cached
// student list into another's.

const DB_NAME = "scholarbase-offline";
const DB_VERSION = 1;

export const STORES = {
  students: "cache_students",
  classes: "cache_classes",
  feeRecords: "cache_feeRecords",
  feeStructures: "cache_feeStructures",
  outbox: "outbox",
  meta: "meta",
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available in this browser"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.students)) {
        db.createObjectStore(STORES.students, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(STORES.classes)) {
        db.createObjectStore(STORES.classes, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(STORES.feeRecords)) {
        db.createObjectStore(STORES.feeRecords, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(STORES.feeStructures)) {
        db.createObjectStore(STORES.feeStructures, { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        const outbox = db.createObjectStore(STORES.outbox, { keyPath: "localId" });
        outbox.createIndex("byCreatedAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode) {
  return db.transaction(store, mode).objectStore(store);
}

export async function idbPut<T>(store: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readwrite").put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readonly").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readonly").getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Cache helpers — key every cached collection by schoolId so nothing leaks
// across accounts, and store the whole array under one record per school
// rather than one record per row (simpler, and these lists are small enough
// — a few hundred students at most — that this isn't a real cost).
export async function cacheSet(store: string, cacheKey: number | string, data: unknown): Promise<void> {
  await idbPut(store, { cacheKey: String(cacheKey), data, cachedAt: new Date().toISOString() });
}

export async function cacheGet<T>(store: string, cacheKey: number | string): Promise<{ data: T; cachedAt: string } | undefined> {
  const record = await idbGet<{ cacheKey: string; data: T; cachedAt: string }>(store, String(cacheKey));
  return record ? { data: record.data, cachedAt: record.cachedAt } : undefined;
}
