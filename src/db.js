// Capa de persistencia. IndexedDB es la FUENTE DE VERDAD.
//
// Regla de diseño no negociable: una escritura nunca se rechaza. El sistema
// anterior validaba las series contra un esquema estricto y descartaba el dato
// real del entrenamiento ("Evento rechazado · validation_error"). Aquí los
// valores se normalizan y se guardan siempre; un dato raro es preferible a un
// dato perdido, y siempre se puede corregir después.

export const DB_NAME = 'gymlog';
export const DB_VERSION = 1;

export const STORES = {
  sessions: 'sessions',
  sets: 'sets',
  measurements: 'measurements',
  meta: 'meta',
};

export function openDb(indexedDBImpl) {
  const idb = indexedDBImpl || globalThis.indexedDB;
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = ev.target.transaction;

      if (!db.objectStoreNames.contains(STORES.sessions)) {
        const s = db.createObjectStore(STORES.sessions, { keyPath: 'id' });
        s.createIndex('byDate', 'date');
        s.createIndex('byDayId', 'dayId');
      }
      if (!db.objectStoreNames.contains(STORES.sets)) {
        const s = db.createObjectStore(STORES.sets, { keyPath: 'id' });
        s.createIndex('bySession', 'sessionId');
        s.createIndex('byExercise', 'exerciseId');
        s.createIndex('byExerciseDate', ['exerciseId', 'date']);
      }
      if (!db.objectStoreNames.contains(STORES.measurements)) {
        const s = db.createObjectStore(STORES.measurements, { keyPath: 'id' });
        s.createIndex('byDate', 'date');
        s.createIndex('byType', 'type');
        s.createIndex('byTypeDate', ['type', 'date']);
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' });
      }
      if (tx) tx.oncomplete = () => {};
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña'));
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transacción abortada'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(db, storeName, value) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await txPromise(tx);
  return value;
}

export async function putMany(db, storeName, values) {
  if (!values.length) return [];
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const v of values) store.put(v);
  await txPromise(tx);
  return values;
}

export async function del(db, storeName, key) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await txPromise(tx);
}

export async function get(db, storeName, key) {
  const tx = db.transaction(storeName, 'readonly');
  return reqPromise(tx.objectStore(storeName).get(key));
}

export async function getAll(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  return reqPromise(tx.objectStore(storeName).getAll());
}

export async function getAllByIndex(db, storeName, indexName, query) {
  const tx = db.transaction(storeName, 'readonly');
  return reqPromise(tx.objectStore(storeName).index(indexName).getAll(query));
}

export async function clearAll(db) {
  const names = Object.values(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await txPromise(tx);
}

// --- meta (ajustes simples clave/valor) ---

export async function getMeta(db, key, fallback = null) {
  const row = await get(db, STORES.meta, key);
  return row === undefined || row === null ? fallback : row.value;
}

export async function setMeta(db, key, value) {
  return put(db, STORES.meta, { key, value });
}
