/* =========================================================
   db.js — IndexedDB persistence layer, with an automatic
   in-memory fallback.

   Why the fallback exists: this file is the only "database" the
   app has. That's fine in a real deployed browser tab, but some
   preview/sandboxed iframes (like an in-chat artifact preview)
   block IndexedDB and even localStorage outright for security
   reasons. Rather than the whole app silently breaking in that
   context, every store here transparently falls back to an
   in-memory Map with the exact same async API. On a real device
   (GitHub Pages, installed PWA, plain browser tab) IndexedDB is
   available and everything persists across reloads as intended;
   in a locked-down preview, data just won't survive a refresh —
   the app still works so you can click through every screen.
   ========================================================= */
(function () {
  "use strict";

  const DB_NAME = "justus_db";
  const DB_VERSION = 1;
  const STORES = [
    "notes",
    "messages",
    "tasks",
    "memories",
    "files",
    "settings",
    "syncQueue",
  ];

  let dbPromise = null;
  let useMemoryFallback = false;
  const memoryStores = {}; // storeName -> Map(id -> record)
  STORES.forEach((s) => (memoryStores[s] = new Map()));

  function open() {
    if (useMemoryFallback) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        useMemoryFallback = true;
        Utils.log("IndexedDB unavailable, using in-memory store:", e.message);
        resolve(null);
        return;
      }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        useMemoryFallback = true;
        Utils.log("IndexedDB blocked, using in-memory store:", req.error && req.error.message);
        resolve(null);
      };
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    if (!db) return null; // signals memory-fallback mode to callers
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function stampRecord(record) {
    if (!record.id) record.id = Utils.uid();
    if (!record.createdAt) record.createdAt = Utils.nowISO();
    record.updatedAt = Utils.nowISO();
    if (!record.deviceId) record.deviceId = Utils.deviceId();
    return record;
  }

  async function put(storeName, record) {
    stampRecord(record);
    return putRaw(storeName, record);
  }

  // Used by the sync layer to write a record exactly as received,
  // without stamping local metadata over the remote peer's values.
  async function putRaw(storeName, record) {
    const store = await tx(storeName, "readwrite");
    if (!store) {
      if (!record.id) record.id = Utils.uid();
      memoryStores[storeName].set(record.id, record);
      return record;
    }
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(storeName, id) {
    const store = await tx(storeName, "readonly");
    if (!store) return memoryStores[storeName].get(id) || null;
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(storeName) {
    const store = await tx(storeName, "readonly");
    if (!store) return Array.from(memoryStores[storeName].values());
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(storeName, id) {
    const store = await tx(storeName, "readwrite");
    if (!store) {
      memoryStores[storeName].delete(id);
      return true;
    }
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearStore(storeName) {
    const store = await tx(storeName, "readwrite");
    if (!store) {
      memoryStores[storeName].clear();
      return true;
    }
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll() {
    for (const s of STORES) await clearStore(s);
  }

  async function exportAll() {
    const dump = {};
    for (const s of STORES) {
      if (s === "syncQueue") continue;
      dump[s] = await getAll(s);
    }
    dump._exportedAt = Utils.nowISO();
    dump._version = DB_VERSION;
    return dump;
  }

  async function importAll(dump) {
    for (const s of STORES) {
      if (s === "syncQueue" || !dump[s]) continue;
      for (const record of dump[s]) {
        await putRaw(s, record);
      }
    }
  }

  // ---- tiny synchronous key/value flags (NOT app content) ----
  // Falls back to an in-memory object if localStorage throws
  // (also blocked in some sandboxed preview frames).
  let memoryFlags = {};
  let storageOk = true;
  try {
    localStorage.setItem("ju_probe", "1");
    localStorage.removeItem("ju_probe");
  } catch {
    storageOk = false;
  }

  const flags = {
    get(key, fallback = null) {
      if (!storageOk) return key in memoryFlags ? memoryFlags[key] : fallback;
      try {
        const v = localStorage.getItem("ju_" + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      if (!storageOk) {
        memoryFlags[key] = value;
        return;
      }
      try {
        localStorage.setItem("ju_" + key, JSON.stringify(value));
      } catch {
        memoryFlags[key] = value;
      }
    },
    remove(key) {
      if (!storageOk) {
        delete memoryFlags[key];
        return;
      }
      try {
        localStorage.removeItem("ju_" + key);
      } catch {
        delete memoryFlags[key];
      }
    },
  };

  window.DB = {
    STORES,
    open,
    put,
    putRaw,
    get,
    getAll,
    remove,
    clearStore,
    clearAll,
    exportAll,
    importAll,
    flags,
  };
})();
