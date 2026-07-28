// Rescate de la app anterior (Gym Log v2).
//
// La versión anterior guardaba las series en IndexedDB `gymv2` y las enviaba a
// Google Sheets mediante un evento que el backend podía rechazar
// ("validation_error"). Cuando eso pasaba, la serie quedaba atrapada en el
// teléfono. Como la app nueva se sirve desde el mismo origen, puede leer esa
// base y recuperar el entrenamiento sin depender del backend.
//
// Es de solo lectura: nunca modifica ni borra la base antigua.

import { normalizeSet, newId, localDate } from './model.js';
import { EXERCISE_BY_ID, DAY_BY_ID, CATALOG } from './catalog.js';

const OLD_DB = 'gymv2';
const OLD_STORE = 'sets';

async function oldDbExists(idb) {
  if (typeof idb.databases !== 'function') return null; // desconocido: intentar igual
  try {
    const list = await idb.databases();
    return list.some((d) => d.name === OLD_DB);
  } catch {
    return null;
  }
}

function openExisting(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(OLD_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Si dispara upgrade es que la base no existía: se aborta para no crearla.
    req.onupgradeneeded = () => {
      try { req.transaction.abort(); } catch { /* ya abortada */ }
      resolve(null);
    };
  });
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Traduce una fila del esquema antiguo al de la app nueva. */
export function mapOldSet(row) {
  const exerciseId = row.exercise_id || row.exerciseId || 'desconocido';
  const ex = EXERCISE_BY_ID[exerciseId];
  const weight = num(row.peso ?? row.weight_value ?? row.weight);
  const unit = (row.unidad ?? row.weight_unit) === 'lb' ? 'lb' : 'kg';
  return normalizeSet({
    id: row.set_id || row.id || newId(),
    sessionId: row.session_id || row.sessionId || null,
    exerciseId,
    exerciseName: ex ? ex.name : exerciseId,
    setIndex: num(row.set_index ?? row.setIndex) || 1,
    weight: weight === null ? 0 : weight,
    unit,
    reps: num(row.reps) || 0,
    rir: num(row.rir),
    kind: row.tipo || 'peso',
    date: row.fecha || row.date || localDate(),
    createdAt: row.created_at || row.updated_at || undefined,
  });
}

/** Reconstruye sesiones para las series recuperadas que no tengan una. */
export function rebuildSessions(sets, oldRows) {
  const dayBySession = new Map();
  for (const r of oldRows) {
    const sid = r.session_id || r.sessionId;
    const dia = String(r.dia || r.day_id || '').toLowerCase();
    if (sid && dia && !dayBySession.has(sid)) dayBySession.set(sid, dia);
  }

  const grouped = new Map();
  for (const s of sets) {
    const key = s.sessionId || `rescatada-${s.date}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }

  const sessions = [];
  for (const [key, list] of grouped) {
    const dayId = dayBySession.get(key) || guessDay(list);
    const day = DAY_BY_ID[dayId];
    const date = list.map((s) => s.date).sort()[0];
    sessions.push({
      id: key,
      date,
      dayId: dayId || 'd1',
      dayLabel: day ? day.label : 'Sesión recuperada',
      dayName: day ? day.name : '',
      routineVersion: CATALOG.routineVersion,
      blockId: null,
      planSnapshot: day ? JSON.parse(JSON.stringify(day.plan)) : [],
      status: 'completed',
      startedAt: list.map((s) => s.createdAt).sort()[0] || `${date}T12:00:00.000Z`,
      endedAt: list.map((s) => s.createdAt).sort().pop() || null,
      note: 'Recuperada de la app anterior.',
    });
    for (const s of list) s.sessionId = key;
  }
  return sessions;
}

/** Deduce el día de la rutina por coincidencia de ejercicios. */
function guessDay(sets) {
  const ids = new Set(sets.map((s) => s.exerciseId));
  let best = null;
  let bestHits = 0;
  for (const d of CATALOG.days) {
    const hits = d.plan.filter((p) => ids.has(p.exerciseId)).length;
    if (hits > bestHits) { bestHits = hits; best = d.id; }
  }
  return bestHits > 0 ? best : null;
}

/**
 * Lee la base antigua y devuelve un payload compatible con store.importData().
 * Devuelve null si no hay nada que recuperar.
 */
export async function readLegacy(indexedDBImpl) {
  const idb = indexedDBImpl || globalThis.indexedDB;
  if (!idb) return null;
  if ((await oldDbExists(idb)) === false) return null;

  let db = null;
  try {
    db = await openExisting(idb);
  } catch {
    return null;
  }
  if (!db) return null;

  try {
    if (!db.objectStoreNames.contains(OLD_STORE)) return null;
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(OLD_STORE, 'readonly');
      const req = tx.objectStore(OLD_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const live = rows.filter((r) => !r.deleted_at);
    if (!live.length) return null;

    const sets = live.map(mapOldSet);
    const sessions = rebuildSessions(sets, live);
    return { schema: 1, sets, sessions, measurements: [], source: 'gymv2' };
  } finally {
    db.close();
  }
}
