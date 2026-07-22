// app.js — Fases 1-6. Registrar series, guardarlas offline-first en IndexedDB con
// una cola (outbox) de mutaciones pendientes, sincronizarlas con el backend por
// cursor incremental, reintentar solas con backoff exponencial si la red falla,
// con rutina data-driven y UI de acordeón pulida para iPhone (safe areas, dark
// mode, pre-relleno, chips, steppers — plan §9.1).
//
// Todas las funciones puras/de red/de IndexedDB se exportan para poder testearlas
// directo desde Node (ver test/*.test.mjs — el adaptador IndexedDB se prueba con
// fake-indexeddb, un polyfill SOLO de test, ver package.json). La capa DOM (glue)
// se ejecuta solo en el navegador y no se testea en Node (sin jsdom a propósito).

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.6.0-iphone-ui';

// ============================================================================
// Rutina data-driven (Fase 5) — funciones puras. La app ya no trae ejercicios
// hardcodeados: lee `Rutina`+`Ejercicios` del Sheet (fetchRoutineAndCatalog) con
// fallback embebido en `data/rutina-6dias.json` (los 6 días tal cual
// Rutina_Alejandro_Info_peso.xlsx) para cuando no hay red o el Sheet aún no
// tiene esas hojas creadas.
// ============================================================================

export function diaLabel(dia) {
  return 'Día ' + String(dia).replace(/^d/i, '');
}

// Combina las filas de Rutina (el plan) con las de Ejercicios (el catálogo) en
// una estructura agrupada por día, lista para renderizar. Ignora silenciosamente
// filas de Rutina cuyo exercise_id no exista en el catálogo (dato inconsistente
// en el Sheet, no debe romper la app) y ejercicios con activo=false (plan §3.5:
// "retira un ejercicio del selector sin borrar su historial").
export function buildRoutineFromRows(routineRows, catalogRows) {
  const catalogById = new Map();
  for (const c of catalogRows || []) catalogById.set(c.exercise_id, c);

  const byDia = new Map();
  for (const r of routineRows || []) {
    const cat = catalogById.get(r.exercise_id);
    if (!cat || cat.activo === false) continue;
    if (!byDia.has(r.dia)) byDia.set(r.dia, []);
    byDia.get(r.dia).push({
      exercise_id: r.exercise_id,
      orden: Number(r.orden) || 0,
      nombre: cat.nombre || r.exercise_id,
      series: Number(r.series) || 0,
      rep_min: r.rep_min != null ? Number(r.rep_min) : null,
      rep_max: r.rep_max != null ? Number(r.rep_max) : null,
      rir: r.rir != null && r.rir !== '' ? Number(r.rir) : null,
      descanso_seg: r.descanso_seg != null ? Number(r.descanso_seg) : null,
      tipo: r.tipo || 'peso',
      notas: r.notas || '',
      unidad_default: cat.unidad_default === 'lb' ? 'lb' : 'kg',
      incremento_kg: cat.incremento_kg != null ? Number(cat.incremento_kg) : 2.5,
      incremento_lb: cat.incremento_lb != null ? Number(cat.incremento_lb) : 5,
      riesgo_lumbar: cat.riesgo_lumbar != null ? Number(cat.riesgo_lumbar) : 0
    });
  }

  const days = [...byDia.entries()]
    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([dia, exercises]) => ({
      dia,
      label: diaLabel(dia),
      exercises: exercises.sort((a, b) => a.orden - b.orden)
    }));
  return days;
}

// Trae Rutina+Ejercicios en un solo round trip (doGet?what=all). Deliberadamente
// NO usa `since` (así el cursor de sync de las series, en syncCycle, queda
// intacto y desacoplado de esto) — a esta escala (decenas de filas) el costo de
// que el servidor calcule también `rows`/`maxSeq` de paso es insignificante, y
// se descarta aquí sin usar. Mantiene "datos de rutina" y "datos de entreno"
// como dos caminos simples e independientes en vez de uno entrelazado.
export async function fetchRoutineAndCatalog(baseUrl, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'what=all';
    const res = await f(url);
    const data = await res.json();
    if (data.error) return { routine: [], catalog: [], error: data.error };
    return { routine: data.routine || [], catalog: data.catalog || [], error: null };
  } catch (e) {
    return { routine: [], catalog: [], error: String((e && e.message) || e) };
  }
}

// Trae CheckIn+Corporal en un solo round trip (doGet?what=all) — mismo patrón
// que fetchRoutineAndCatalog: otro camino simple e independiente, no acoplado
// al ciclo de sync de series ni al de rutina/catálogo (fase 7).
export async function fetchCheckinsAndCorporal(baseUrl, fetchImpl) {
  const f = fetchImpl || fetch;
  try {
    const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'what=all';
    const res = await f(url);
    const data = await res.json();
    if (data.error) return { checkins: [], corporal: [], error: data.error };
    return { checkins: data.checkins || [], corporal: data.corporal || [], error: null };
  } catch (e) {
    return { checkins: [], corporal: [], error: String((e && e.message) || e) };
  }
}

// Última serie NO borrada de un ejercicio (la más reciente por fecha, luego por
// set_index). Base del pre-relleno "registro en pocos segundos" (plan §9.1) y
// de la sugerencia de progresión.
export function lastSetFor(byId, exerciseId) {
  const sets = Object.values(byId || {}).filter((r) => r.exercise_id === exerciseId && !r.deleted_at);
  if (!sets.length) return null;
  sets.sort((a, b) => {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
    return (b.set_index || 0) - (a.set_index || 0);
  });
  return sets[0];
}

function round2(n) { return Math.round(n * 100) / 100; }

// Sugerencia de progresión simple (doble progresión): si la última serie llegó
// al tope del rango con RIR en objetivo, sugiere subir peso con el incremento
// del ejercicio; si quedó bajo el mínimo a RIR 0, sugiere bajar; si no, mantener
// y buscar +1 rep. Alineado con el Sistema Maestro Físico de Alejandro (Parte 6).
export function suggestNextSet(lastSet, exercise) {
  if (!lastSet) return { text: 'Sin historial. Arranca conservador.', cls: '' };
  if (exercise.tipo !== 'peso') return { text: 'Última vez: ' + lastSet.reps + ' seg.', cls: '' };
  const inc = lastSet.unidad === 'lb' ? (exercise.incremento_lb || 5) : (exercise.incremento_kg || 2.5);
  const atTop = exercise.rep_max != null && lastSet.reps >= exercise.rep_max && (lastSet.rir == null || lastSet.rir >= 1);
  const belowMin = exercise.rep_min != null && lastSet.reps < exercise.rep_min && (lastSet.rir || 0) === 0;
  if (atTop) return { text: '⬆️ Sube a ' + round2(lastSet.peso + inc) + ' ' + lastSet.unidad, cls: 'up' };
  if (belowMin) return { text: '⬇️ Baja a ' + round2(Math.max(0, lastSet.peso - inc)) + ' ' + lastSet.unidad, cls: 'warn' };
  return { text: 'Mantén ' + lastSet.peso + ' ' + lastSet.unidad + ', busca +1 rep', cls: '' };
}

export function todayISO(d) {
  const date = d || new Date();
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

export function newUUID() {
  return crypto.randomUUID();
}

// Construye la mutación exacta que espera Core.upsertSetRow, a partir del
// estado del formulario. Pura: no toca red ni DOM. `type: 'set'` es explícito
// desde fase 7 (antes iba implícito) — Code.gs usa este campo para enrutar
// cada mutación del lote a RAW/CheckIn/Corporal; su ausencia sigue tratándose
// como 'set' en el backend, así que mutaciones viejas en un outbox no se rompen.
export function buildSetMutation(form, ctx) {
  ctx = ctx || {};
  return {
    type: 'set',
    set_id: form.set_id || newUUID(),
    session_id: form.session_id,
    exercise_id: form.exercise_id,
    set_index: form.set_index,
    fecha: form.fecha || todayISO(),
    sem: form.sem != null ? form.sem : null,
    dia: form.dia != null ? form.dia : null,
    routine_version: form.routine_version != null ? form.routine_version : null,
    peso: Number(form.peso),
    unidad: form.unidad,
    reps: Number(form.reps),
    rir: form.rir != null && form.rir !== '' ? Number(form.rir) : null,
    dolor: form.dolor != null && form.dolor !== '' ? Number(form.dolor) : 0,
    updated_at: (ctx.now || new Date()).toISOString(),
    deleted_at: form.deleted_at || null,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION
  };
}

// Marca una mutación existente como borrada (soft-delete): misma clave,
// deleted_at seteado, updated_at refrescado. El historial no se pierde.
// Genérica: sirve para sets/checkins/corporal por igual (todas usan este patrón).
export function buildDeleteMutation(existingMutation, ctx) {
  ctx = ctx || {};
  return Object.assign({}, existingMutation, {
    deleted_at: (ctx.now || new Date()).toISOString(),
    updated_at: (ctx.now || new Date()).toISOString()
  });
}

// Check-in de sesión (energía/pump/técnica/sueño) — upsert por session_id.
// Una sola fila por sesión: guardar de nuevo con el mismo session_id actualiza,
// no duplica.
export function buildCheckinMutation(form, ctx) {
  ctx = ctx || {};
  return {
    type: 'checkin',
    session_id: form.session_id,
    fecha: form.fecha || todayISO(),
    dia: form.dia != null ? form.dia : null,
    energia: form.energia != null && form.energia !== '' ? Number(form.energia) : null,
    pump: form.pump != null && form.pump !== '' ? Number(form.pump) : null,
    tecnica: form.tecnica != null && form.tecnica !== '' ? Number(form.tecnica) : null,
    sueno: form.sueno != null && form.sueno !== '' ? Number(form.sueno) : null,
    comentario: form.comentario || '',
    updated_at: (ctx.now || new Date()).toISOString(),
    deleted_at: form.deleted_at || null,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION
  };
}

// Peso corporal / medidas — upsert por fecha. Una fila por día.
export function buildCorporalMutation(form, ctx) {
  ctx = ctx || {};
  const num = (v) => (v != null && v !== '' ? Number(v) : null);
  return {
    type: 'corporal',
    fecha: form.fecha || todayISO(),
    peso_am_kg: num(form.peso_am_kg),
    cintura_cm: num(form.cintura_cm),
    pecho_cm: num(form.pecho_cm),
    hombros_cm: num(form.hombros_cm),
    brazo_cm: num(form.brazo_cm),
    muslo_cm: num(form.muslo_cm),
    updated_at: (ctx.now || new Date()).toISOString(),
    deleted_at: form.deleted_at || null,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION
  };
}

// Clave lógica de una mutación según su tipo — usada para deduplicar el outbox
// (dos ediciones de la MISMA sesión/fecha/serie antes de sincronizar solo deben
// mandar la más reciente). Sin `type` (mutaciones viejas en un outbox previo a
// fase 7) se asume 'set', igual que hace Code.gs — comportamiento idéntico.
export function mutationKey(mutation) {
  if (mutation.type === 'checkin') return 'checkin:' + mutation.session_id;
  if (mutation.type === 'corporal') return 'corporal:' + mutation.fecha;
  return 'set:' + mutation.set_id;
}

export async function pushMutations(baseUrl, mutations, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(baseUrl, {
    method: 'POST',
    // body text/plain a propósito: evita el preflight CORS de Apps Script (ver README).
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ mutations })
  });
  return res.json();
}

export async function pullSince(baseUrl, since, fetchImpl) {
  const f = fetchImpl || fetch;
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(since || 0);
  const res = await f(url);
  return res.json();
}

// Fusiona filas recibidas del servidor en el estado local, indexado por
// `keyField` (set_id/session_id/fecha según el tipo). El servidor es
// autoritativo: siempre sobreescribe lo local con lo recibido.
export function mergeIncomingByKey(localByKey, incomingRows, keyField) {
  const next = Object.assign({}, localByKey);
  for (const row of incomingRows) {
    next[row[keyField]] = row;
  }
  return next;
}

// Envoltorio delgado para series (set_id) — se conserva el nombre por
// compatibilidad con syncCycle y los tests existentes de fases 1-6.
export function mergeIncoming(localBySetId, incomingRows) {
  return mergeIncomingByKey(localBySetId, incomingRows, 'set_id');
}

// Decide el cursor a usar en el próximo pull. El cursor persistido SOLO es válido
// si el estado local en memoria que representa ya lo alcanzó. Con IndexedDB (fase 3)
// el estado local persiste de verdad entre recargas, así que esto ahora también
// evita bootstraps completos innecesarios en cada sesión — no solo corrige el bug
// original (fase 1-2, cuando el estado se perdía siempre por no haber IndexedDB).
export function computeSyncSince(localRowCount, persistedSince) {
  return localRowCount > 0 ? (persistedSince || 0) : 0;
}

// Ciclo completo de sync (push opcional + pull con el cursor correcto + merge),
// como función pura inyectando fetch: la misma lógica que usa el navegador se
// puede ejercitar en Node contra un backend real u otro sin duplicar el flujo.
export async function syncCycle({ url, localById, lastSeq, newMutations, fetchImpl }) {
  const result = { byId: localById, lastSeq: lastSeq || 0, acked: [], rejected: [], error: null };
  try {
    if (newMutations && newMutations.length) {
      const pushRes = await pushMutations(url, newMutations, fetchImpl);
      if (pushRes.error) throw new Error(pushRes.error);
      result.acked = pushRes.acked || [];
      result.rejected = pushRes.rejected || [];
    }
    const since = computeSyncSince(Object.keys(result.byId).length, result.lastSeq);
    const pull = await pullSince(url, since, fetchImpl);
    if (pull.error) throw new Error(pull.error);
    result.byId = mergeIncoming(result.byId, pull.rows || []);
    if (pull.maxSeq) result.lastSeq = pull.maxSeq;
    return result;
  } catch (e) {
    result.error = String((e && e.message) || e);
    return result;
  }
}

// ============================================================================
// Outbox — funciones puras (sin IndexedDB ni red directa)
// ============================================================================

// De N entradas del outbox para la MISMA clave lógica (mutationKey — ej. el
// usuario guardó y luego borró la misma serie antes de reconectar, o corrigió
// dos veces el check-in de hoy), solo la más reciente vale la pena enviar —
// las anteriores son estado superado. Funciona igual para sets/checkins/
// corporal, todos mezclados en el mismo outbox (Code.gs enruta por `type`).
// Se devuelven también TODOS los outbox_id involucrados (incl. los superados)
// para poder limpiarlos del store una vez que el más reciente se confirme.
export function dedupeOutboxByKey(entries) {
  const latestByKey = new Map();
  for (const entry of entries) latestByKey.set(mutationKey(entry.mutation), entry);
  return {
    toSend: [...latestByKey.values()].map((e) => e.mutation),
    allOutboxIds: entries.map((e) => e.outbox_id)
  };
}

export function rejectedToMap(rejected) {
  const map = {};
  for (const r of rejected || []) map[r.set_id] = r.reason;
  return map;
}

// Orquesta un intento de vaciado del outbox: deduplica, hace push+pull vía
// syncCycle, y decide qué limpiar. NO toca IndexedDB directamente (eso lo hace
// quien llama, con el resultado) — así es testeable en Node con fetch inyectado,
// sin DB real de por medio (ver test/outbox.test.mjs).
export async function flushOutbox({ url, byId, outboxEntries, lastSeq, fetchImpl }) {
  const { toSend, allOutboxIds } = dedupeOutboxByKey(outboxEntries || []);
  const out = await syncCycle({ url, localById: byId, lastSeq, newMutations: toSend, fetchImpl });
  if (out.error) {
    // Nada se confirmó (o no se pudo saber): el outbox se deja INTACTO para
    // reintentar en el próximo disparador. Nunca se limpia en base a una suposición.
    return { ...out, clearedOutboxIds: [], rejectedBySetId: {} };
  }
  // out.acked/out.rejected cubren TODO lo enviado (Code.gs siempre clasifica cada
  // mutación como una u otra), así que todo lo enviado se puede limpiar del outbox.
  // Lo rechazado no se reintenta en bucle (regla del plan §6): reintentar el mismo
  // payload inválido no serviría de nada; queda reflejado en rejectedBySetId para
  // que la UI lo muestre — una edición nueva del usuario encolaría otra mutación.
  return { ...out, clearedOutboxIds: allOutboxIds, rejectedBySetId: rejectedToMap(out.rejected) };
}

// Estado de la barra de sync (§4.5 del plan). 3 de los 4 estados se derivan de
// datos puros; el 4to ("reintentando") es un flag transitorio que pone la UI
// mientras la promesa de flushOutbox está en vuelo, no se deriva de estado persistido.
export function computeSyncStatus({ outboxCount, hasError }) {
  if (hasError) return { state: 'error', label: '⚠️ Error de red — toca para reintentar' };
  if (outboxCount > 0) return { state: 'pending', label: '⏳ ' + outboxCount + ' pendiente' + (outboxCount === 1 ? '' : 's') };
  return { state: 'ok', label: '✓ Sincronizado' };
}

// ============================================================================
// Backoff (Fase 4, §4.4) — funciones puras. Los 5 disparadores (guardar/online/
// abrir/foreground/manual) ya cubren "reintentar cuando pasa algo"; el backoff
// cubre el caso "no pasó nada más, pero la red sigue caída": en vez de esperar
// en silencio al próximo disparador externo, la app reintenta sola con demoras
// crecientes (2s, 8s, 30s, tope 2min) para no martillar el servidor ni la batería.
// ============================================================================

const BACKOFF_STEPS_MS = [2000, 8000, 30000];
const BACKOFF_CAP_MS = 120000;

export function computeBackoffDelay(attempt) {
  if (attempt <= 0) return 0;
  if (attempt <= BACKOFF_STEPS_MS.length) return BACKOFF_STEPS_MS[attempt - 1];
  return BACKOFF_CAP_MS;
}

// Estado siguiente del backoff dado si el último intento falló. Un éxito
// resetea el contador a 0 (sin retraso pendiente); un fallo lo incrementa y
// calcula la demora del próximo reintento automático.
export function nextBackoffState(prevAttempt, hadError) {
  if (!hadError) return { attempt: 0, delay: 0 };
  const attempt = (prevAttempt || 0) + 1;
  return { attempt, delay: computeBackoffDelay(attempt) };
}

// ============================================================================
// IndexedDB — adaptador (funciones siempre definidas; solo fallan en tiempo de
// llamada si `indexedDB` no existe en el entorno). Se prueban en Node con
// fake-indexeddb (devDependency de test, nunca se despliega — ver package.json).
// ============================================================================

export const DB_NAME = 'gymv2';
export const DB_VERSION = 1;
export const STORE_SETS = 'sets';
export const STORE_CHECKINS = 'checkins';
export const STORE_CORPORAL = 'corporal';
export const STORE_OUTBOX = 'outbox';
export const STORE_META = 'meta';

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transacción de IndexedDB abortada'));
  });
}

export function openDB(idbImpl) {
  const idb = idbImpl || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!idb) return Promise.reject(new Error('IndexedDB no disponible en este entorno'));
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SETS)) db.createObjectStore(STORE_SETS, { keyPath: 'set_id' });
      if (!db.objectStoreNames.contains(STORE_CHECKINS)) db.createObjectStore(STORE_CHECKINS, { keyPath: 'session_id' });
      if (!db.objectStoreNames.contains(STORE_CORPORAL)) db.createObjectStore(STORE_CORPORAL, { keyPath: 'fecha' });
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: 'outbox_id', autoIncrement: true });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('apertura de IndexedDB bloqueada (otra pestaña con una versión distinta abierta)'));
  });
}

export function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Escribe una mutación de forma optimista: su store (sets/checkins/corporal,
// estado actual) + outbox (pendiente de confirmar) en la MISMA transacción,
// para que nunca quede una sin la otra (ej. si el navegador se cierra a mitad
// de camino). Genérica desde fase 7 — el keyPath correcto ya lo define cada
// store (ver openDB), put() no necesita saber cuál es.
export async function persistOptimistic(db, storeName, mutation) {
  const t = db.transaction([storeName, STORE_OUTBOX], 'readwrite');
  t.objectStore(storeName).put(mutation);
  const outboxReq = t.objectStore(STORE_OUTBOX).add({ mutation, enqueued_at: new Date().toISOString() });
  await txDone(t);
  return outboxReq.result; // outbox_id asignado
}

// Envoltorio delgado — se conserva el nombre por compatibilidad con el resto
// del código y los tests existentes de fases 1-6.
export async function persistSetOptimistic(db, mutation) {
  return persistOptimistic(db, STORE_SETS, mutation);
}

export async function clearOutboxEntries(db, outboxIds) {
  if (!outboxIds || !outboxIds.length) return;
  const t = db.transaction(STORE_OUTBOX, 'readwrite');
  const store = t.objectStore(STORE_OUTBOX);
  for (const id of outboxIds) store.delete(id);
  await txDone(t);
}

export async function setMeta(db, key, value) {
  const t = db.transaction(STORE_META, 'readwrite');
  t.objectStore(STORE_META).put({ key, value });
  await txDone(t);
}

export async function getMeta(db, key, fallback) {
  const row = await idbGet(db, STORE_META, key);
  return row ? row.value : fallback;
}

// Reconstruye el estado local completo desde IndexedDB al abrir la app: filas
// de series (indexadas por set_id), check-ins (por session_id), corporal (por
// fecha), outbox pendiente (tal cual, con sus outbox_id), y meta (cursor de
// sync, rutina/catálogo cacheados, etc.) como un diccionario simple.
export async function hydrateFromDB(db) {
  const [setsArr, checkinsArr, corporalArr, outboxArr, metaArr] = await Promise.all([
    idbGetAll(db, STORE_SETS),
    idbGetAll(db, STORE_CHECKINS),
    idbGetAll(db, STORE_CORPORAL),
    idbGetAll(db, STORE_OUTBOX),
    idbGetAll(db, STORE_META)
  ]);
  const byId = {};
  for (const row of setsArr) byId[row.set_id] = row;
  const checkinsById = {};
  for (const row of checkinsArr) checkinsById[row.session_id] = row;
  const corporalByFecha = {};
  for (const row of corporalArr) corporalByFecha[row.fecha] = row;
  const meta = {};
  for (const m of metaArr) meta[m.key] = m.value;
  return { byId, checkinsById, corporalByFecha, outbox: outboxArr, meta };
}

// ============================================================================
// Glue de navegador — no se ejecuta en Node (no hay `document`; no se testea
// con jsdom a propósito, ver README). Toda la lógica no trivial vive arriba,
// ya testeada; esto solo conecta esa lógica con el DOM y con IndexedDB.
// ============================================================================
if (typeof document !== 'undefined') {
  const LS_URL = 'gymv2_apps_script_url';
  const LS_THEME = 'gymv2_theme'; // '' (auto) | 'light' | 'dark'

  let db = null;
  let backoffAttempt = 0;
  let backoffTimer = null;
  let toastTimer = null;
  const state = {
    session_id: newUUID(),
    byId: {},
    lastSeq: 0,
    days: [], // [{dia,label,exercises:[...]}], data-driven (Fase 5) — ver buildRoutineFromRows
    currentDayIdx: 0,
    openIdx: null, // índice del ejercicio expandido en el acordeón (uno a la vez)
    curForm: {}, // exercise_id -> {peso, reps, rir, dolor, unidad} — estado del formulario en curso
    checkinsById: {}, // session_id -> fila (fase 7)
    corporalByFecha: {}, // fecha -> fila (fase 7)
    checkinForm: { energia: null, pump: null, tecnica: null, sueno: '', comentario: '' },
    corporalForm: null // se inicializa en defaultsForCorporal() al primer render
  };

  const $ = (sel) => document.querySelector(sel);

  function getUrl() { return localStorage.getItem(LS_URL) || ''; }
  function setUrl(v) { localStorage.setItem(LS_URL, v.trim()); }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', localStorage.getItem(LS_THEME) || '');
  }
  function toggleTheme() {
    const cur = localStorage.getItem(LS_THEME) || '';
    const next = cur === 'dark' ? 'light' : (cur === 'light' ? '' : 'dark');
    localStorage.setItem(LS_THEME, next);
    applyTheme();
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function setStatusState({ state: st, label }) {
    const el = $('#status');
    el.textContent = label;
    el.className = 'status ' + st;
  }

  // Fallback embebido (Fase 5): mismo origen que index.html/app.js, así que
  // funciona incluso sin conexión al Apps Script — solo requiere haber cargado
  // la página una vez. Es la única fuente de verdad para los 6 días cuando el
  // Sheet todavía no tiene las hojas Rutina/Ejercicios (o no hay red).
  async function loadFallbackRoutine() {
    try {
      const res = await fetch('./data/rutina-6dias.json');
      const data = await res.json();
      return { routine: data.routine || [], catalog: data.catalog || [] };
    } catch (e) {
      return { routine: [], catalog: [] };
    }
  }

  // En segundo plano, sin bloquear la UI: si el Sheet ya tiene Rutina/Ejercicios
  // con datos, reemplaza lo cargado (fallback o caché vieja) y re-renderiza.
  // Si el Sheet no tiene esas hojas (o falla la red), NO pisa lo que ya funciona
  // — nunca se reemplaza con listas vacías.
  async function refreshRoutineInBackground() {
    const url = getUrl();
    if (!url) return;
    const res = await fetchRoutineAndCatalog(url);
    if (res.error || !res.routine.length || !res.catalog.length) return;
    await setMeta(db, 'rutina', res.routine);
    await setMeta(db, 'catalogo', res.catalog);
    const currentDia = state.days[state.currentDayIdx] && state.days[state.currentDayIdx].dia;
    state.days = buildRoutineFromRows(res.routine, res.catalog);
    const keepIdx = state.days.findIndex((d) => d.dia === currentDia);
    state.currentDayIdx = keepIdx >= 0 ? keepIdx : 0;
    renderDayTabs();
    renderExerciseList();
  }

  function renderDayTabs() {
    $('#dayTabs').innerHTML = state.days.map((d, i) =>
      `<button class="${i === state.currentDayIdx ? 'on' : ''}" data-day="${i}">${d.label}</button>`
    ).join('');
    $('#dayTabs').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.currentDayIdx = Number(btn.dataset.day);
        state.openIdx = null;
        renderDayTabs();
        renderExerciseList();
      });
    });
  }

  function planSummary(ex) {
    const rango = ex.series + '×' + (ex.rep_min ?? '') + '-' + (ex.rep_max ?? '');
    const rir = ex.tipo === 'peso' ? ' · RIR ' + (ex.rir ?? '—') : '';
    const desc = ex.descanso_seg ? ' · ⏱ ' + ex.descanso_seg + 's' : '';
    return rango + rir + desc;
  }

  function setsToday(exerciseId) {
    return Object.values(state.byId).filter((r) => r.exercise_id === exerciseId && !r.deleted_at && r.fecha === todayISO()).length;
  }

  function defaultsFor(ex) {
    const last = lastSetFor(state.byId, ex.exercise_id);
    return {
      peso: last ? last.peso : '',
      reps: last ? last.reps : '',
      rir: last && last.rir != null ? last.rir : (ex.tipo === 'peso' ? 1 : null),
      dolor: 0,
      unidad: (last && last.unidad) || ex.unidad_default
    };
  }

  function renderExerciseList() {
    const list = $('#exList');
    const day = state.days[state.currentDayIdx];
    if (!day) { list.innerHTML = '<p class="note">Sin rutina cargada.</p>'; return; }
    list.innerHTML = day.exercises.map((ex, i) => {
      const isOpen = state.openIdx === i;
      const done = setsToday(ex.exercise_id);
      const pill = `<div class="setpill${done >= ex.series ? ' done' : ''}">${done}/${ex.series}</div>`;
      const head = `<div class="exhead" data-idx="${i}" data-act="toggle">
          <div><div class="exname">${ex.nombre}</div><div class="plan">${planSummary(ex)}</div></div>
          ${pill}
        </div>`;
      if (!isOpen) return `<div class="card" data-idx="${i}">${head}</div>`;

      if (!state.curForm[ex.exercise_id]) state.curForm[ex.exercise_id] = defaultsFor(ex);
      const f = state.curForm[ex.exercise_id];
      const last = lastSetFor(state.byId, ex.exercise_id);
      const sug = suggestNextSet(last, ex);
      const isPeso = ex.tipo === 'peso';
      const repsLabel = ex.tipo === 'tiempo' ? 'Segundos' : 'Reps';

      return `<div class="card open" data-idx="${i}">
        ${head}
        <div class="exbody">
          <div class="sug ${sug.cls}">${sug.text}</div>
          ${isPeso ? `
          <div class="frow"><div class="flab">Peso</div><div class="step">
            <button type="button" data-idx="${i}" data-act="stepdown-peso">−</button>
            <input type="number" inputmode="decimal" id="peso${i}" value="${f.peso}">
            <button type="button" data-idx="${i}" data-act="stepup-peso">+</button>
            <button type="button" class="ubtn${f.unidad === 'lb' ? ' lb' : ''}" data-idx="${i}" data-act="toggleunit">${f.unidad}</button>
          </div></div>` : ''}
          <div class="frow"><div class="flab">${repsLabel}</div><div class="step">
            <button type="button" data-idx="${i}" data-act="stepdown-reps">−</button>
            <input type="number" inputmode="numeric" id="reps${i}" value="${f.reps}">
            <button type="button" data-idx="${i}" data-act="stepup-reps">+</button>
          </div></div>
          ${isPeso ? `<div class="frow"><div class="flab">RIR</div><div class="chips">${[0, 1, 2, 3, 4, 5].map((v) =>
            `<button type="button" class="${f.rir === v ? 'on' : ''}" data-idx="${i}" data-act="rir" data-v="${v}">${v}</button>`).join('')}</div></div>` : ''}
          <div class="frow"><div class="flab">Dolor</div><div class="chips pain">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) =>
            `<button type="button" class="${f.dolor === v ? 'on' : ''}" data-idx="${i}" data-act="dolor" data-v="${v}">${v}</button>`).join('')}</div></div>
          ${last ? `<button type="button" class="samebtn" data-idx="${i}" data-act="same">= que la vez pasada</button>` : ''}
          <button type="button" class="save" data-idx="${i}" data-act="save">✓ GUARDAR SERIE</button>
        </div>
      </div>`;
    }).join('');
    wireExerciseListEvents();
  }

  function wireExerciseListEvents() {
    $('#exList').querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAction(Number(el.dataset.idx), el.dataset.act, el.dataset.v);
      });
    });
    // Sincroniza lo tecleado directamente (sin pasar por un stepper/chip) para
    // que no se pierda si el usuario colapsa la tarjeta sin tocar otro control.
    $('#exList').querySelectorAll('input[type="number"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.id.replace(/^\D+/, ''));
        const ex = state.days[state.currentDayIdx] && state.days[state.currentDayIdx].exercises[idx];
        if (ex) syncFormFromInputs(idx, ex);
      });
    });
  }

  function syncFormFromInputs(idx, ex) {
    const f = state.curForm[ex.exercise_id];
    if (!f) return;
    const pesoEl = $('#peso' + idx);
    if (pesoEl) f.peso = pesoEl.value === '' ? '' : Number(pesoEl.value);
    const repsEl = $('#reps' + idx);
    if (repsEl) f.reps = repsEl.value === '' ? '' : Number(repsEl.value);
  }

  function handleAction(idx, act, v) {
    const day = state.days[state.currentDayIdx];
    const ex = day && day.exercises[idx];
    if (!ex) return;

    if (act === 'toggle') {
      state.openIdx = state.openIdx === idx ? null : idx;
      renderExerciseList();
      if (state.openIdx != null) {
        const card = $('.card[data-idx="' + state.openIdx + '"]');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    if (!state.curForm[ex.exercise_id]) state.curForm[ex.exercise_id] = defaultsFor(ex);
    syncFormFromInputs(idx, ex);
    const f = state.curForm[ex.exercise_id];

    if (act === 'stepup-peso' || act === 'stepdown-peso') {
      const inc = f.unidad === 'lb' ? (ex.incremento_lb || 5) : (ex.incremento_kg || 2.5);
      const dir = act === 'stepup-peso' ? 1 : -1;
      f.peso = Math.max(0, round2((Number(f.peso) || 0) + dir * inc));
    } else if (act === 'stepup-reps' || act === 'stepdown-reps') {
      const dir = act === 'stepup-reps' ? 1 : -1;
      f.reps = Math.max(0, (Number(f.reps) || 0) + dir);
    } else if (act === 'toggleunit') {
      f.unidad = f.unidad === 'lb' ? 'kg' : 'lb';
    } else if (act === 'rir') {
      f.rir = Number(v);
    } else if (act === 'dolor') {
      f.dolor = Number(v);
    } else if (act === 'same') {
      const last = lastSetFor(state.byId, ex.exercise_id);
      if (last) { f.peso = last.peso; f.reps = last.reps; f.rir = last.rir; f.unidad = last.unidad; }
    } else if (act === 'save') {
      onSaveSet(idx, ex, day);
      return;
    }
    renderExerciseList();
  }

  async function onSaveSet(idx, ex, day) {
    const f = state.curForm[ex.exercise_id];
    const isPeso = ex.tipo === 'peso';
    if ((isPeso && (f.peso === '' || f.peso == null)) || f.reps === '' || f.reps == null) {
      toast('Falta ' + (isPeso ? 'peso o reps' : 'segundos'));
      return;
    }
    const mutation = buildSetMutation({
      session_id: state.session_id,
      exercise_id: ex.exercise_id,
      set_index: setsToday(ex.exercise_id) + 1, // 1..n dentro del ejercicio/SESIÓN (no histórico total)
      dia: day.dia,
      peso: isPeso ? f.peso : 0,
      unidad: isPeso ? f.unidad : ex.unidad_default,
      reps: f.reps,
      rir: isPeso ? f.rir : null,
      dolor: f.dolor
    });
    state.byId[mutation.set_id] = mutation; // optimista, instantáneo en la UI
    renderExerciseList();
    renderLog();
    toast('✓ Serie guardada');
    await persistSetOptimistic(db, mutation); // durable ANTES de intentar red
    triggerSync(); // no bloquea: si falla, queda en el outbox para el próximo disparador
  }

  async function onDeleteSet(set_id) {
    const existing = state.byId[set_id];
    if (!existing) return;
    const del = buildDeleteMutation(existing);
    state.byId[set_id] = del;
    renderExerciseList();
    renderLog();
    await persistSetOptimistic(db, del);
    triggerSync();
  }

  // Punto de entrada de los 5 disparadores (guardar/online/abrir/foreground/manual):
  // un disparador "real" siempre gana sobre un reintento automático programado —
  // se cancela el timer de backoff pendiente (si hay) y se intenta ya.
  function triggerSync() {
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    attemptFlush();
  }

  async function attemptFlush() {
    const url = getUrl();
    if (!url || !db) { setStatusState({ state: 'error', label: 'Configura la URL del Apps Script en Ajustes' }); return; }
    setStatusState({ state: 'sync', label: '↻ Sincronizando…' });
    const outboxEntries = await idbGetAll(db, STORE_OUTBOX);
    const out = await flushOutbox({ url, byId: state.byId, outboxEntries, lastSeq: state.lastSeq });

    if (out.clearedOutboxIds.length) await clearOutboxEntries(db, out.clearedOutboxIds);
    state.byId = out.byId;
    if (!out.error) {
      state.lastSeq = out.lastSeq;
      await setMeta(db, 'last_seq', out.lastSeq);
    }
    for (const [setId, reason] of Object.entries(out.rejectedBySetId)) {
      if (state.byId[setId]) state.byId[setId] = Object.assign({}, state.byId[setId], { _syncError: reason });
    }
    renderExerciseList();
    renderLog();

    const remaining = await idbGetAll(db, STORE_OUTBOX);
    setStatusState(computeSyncStatus({ outboxCount: remaining.length, hasError: !!out.error }));

    // Backoff: si falló y nadie más programó ya un reintento, agenda el próximo
    // con demora creciente. Un éxito resetea el contador (regla de nextBackoffState).
    const nb = nextBackoffState(backoffAttempt, !!out.error);
    backoffAttempt = nb.attempt;
    if (out.error && nb.delay > 0 && !backoffTimer) {
      backoffTimer = setTimeout(() => { backoffTimer = null; attemptFlush(); }, nb.delay);
    }
  }

  function renderLog() {
    const rows = Object.values(state.byId).filter((r) => !r.deleted_at).sort((a, b) => (a.set_id > b.set_id ? 1 : -1));
    $('#log').innerHTML = rows.map((r) =>
      `<tr class="${r._syncError ? 'rowerr' : ''}" title="${r._syncError ? String(r._syncError).replace(/"/g, '&quot;') : ''}">
       <td>${r.exercise_id}</td><td>${r.set_index}</td><td>${r.peso} ${r.unidad}</td><td>${r.reps}</td><td>${r.rir ?? '—'}</td>
       <td><button data-del="${r.set_id}">✕</button></td></tr>`
    ).join('');
    $('#log').querySelectorAll('button[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => onDeleteSet(btn.dataset.del));
    });
  }

  // ---- Fase 7: Check-in de sesión + Peso corporal (UI mínima) ----

  function defaultsForCorporal() {
    const existing = state.corporalByFecha[todayISO()];
    return { peso_am_kg: existing && existing.peso_am_kg != null ? existing.peso_am_kg : '', cintura_cm: existing && existing.cintura_cm != null ? existing.cintura_cm : '' };
  }

  function renderCheckin() {
    const f = state.checkinForm;
    const chips = (field, max) => [...Array(max)].map((_, idx) => {
      const v = idx + 1;
      return `<button type="button" class="${f[field] === v ? 'on' : ''}" data-checkin-chip="${field}" data-v="${v}">${v}</button>`;
    }).join('');
    $('#checkinPanel').innerHTML = `
      <div class="frow"><div class="flab">Energía</div><div class="chips">${chips('energia', 5)}</div></div>
      <div class="frow"><div class="flab">Pump</div><div class="chips">${chips('pump', 5)}</div></div>
      <div class="frow"><div class="flab">Técnica</div><div class="chips">${chips('tecnica', 5)}</div></div>
      <div class="frow"><div class="flab">Sueño</div><div class="step">
        <input type="number" inputmode="decimal" id="checkinSueno" placeholder="horas" value="${f.sueno}">
      </div></div>
      <button type="button" class="samebtn" id="checkinComentarioToggle">+ comentario</button>
      <textarea id="checkinComentario" placeholder="Dolores, máquinas ocupadas, etc." style="display:none;width:100%;min-height:60px;margin-bottom:10px;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--in);color:var(--txt);font:inherit;">${f.comentario}</textarea>
      <button type="button" class="save" id="checkinSaveBtn">✓ GUARDAR CHECK-IN</button>
    `;
    $('#checkinPanel').querySelectorAll('[data-checkin-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.checkinChip;
        const v = Number(btn.dataset.v);
        state.checkinForm[field] = state.checkinForm[field] === v ? null : v;
        renderCheckin();
      });
    });
    $('#checkinComentarioToggle').addEventListener('click', () => {
      $('#checkinComentario').style.display = 'block';
      $('#checkinComentarioToggle').style.display = 'none';
    });
    $('#checkinSaveBtn').addEventListener('click', () => onSaveCheckin());
  }

  async function onSaveCheckin() {
    const f = state.checkinForm;
    f.sueno = $('#checkinSueno') ? $('#checkinSueno').value : f.sueno;
    f.comentario = $('#checkinComentario') ? $('#checkinComentario').value : f.comentario;
    if (f.energia == null && f.pump == null && f.tecnica == null && f.sueno === '' && !f.comentario) {
      toast('Check-in vacío'); return;
    }
    const day = state.days[state.currentDayIdx];
    const mutation = buildCheckinMutation({
      session_id: state.session_id, dia: day && day.dia,
      energia: f.energia, pump: f.pump, tecnica: f.tecnica, sueno: f.sueno, comentario: f.comentario
    });
    state.checkinsById[mutation.session_id] = mutation;
    toast('✓ Check-in guardado');
    await persistOptimistic(db, STORE_CHECKINS, mutation);
    triggerSync();
  }

  function renderCorporal() {
    if (!state.corporalForm) state.corporalForm = defaultsForCorporal();
    const f = state.corporalForm;
    $('#corporalPanel').innerHTML = `
      <div class="frow"><div class="flab">Peso</div><div class="step">
        <button type="button" data-corp-act="stepdown-peso">−</button>
        <input type="number" inputmode="decimal" id="corpPeso" value="${f.peso_am_kg}">
        <button type="button" data-corp-act="stepup-peso">+</button>
      </div></div>
      <div class="frow"><div class="flab">Cintura</div><div class="step">
        <button type="button" data-corp-act="stepdown-cintura">−</button>
        <input type="number" inputmode="decimal" id="corpCintura" value="${f.cintura_cm}">
        <button type="button" data-corp-act="stepup-cintura">+</button>
      </div></div>
      <button type="button" class="save" data-corp-act="save">✓ GUARDAR MEDIDAS DE HOY</button>
    `;
    $('#corporalPanel').querySelectorAll('[data-corp-act]').forEach((btn) => {
      btn.addEventListener('click', () => handleCorporalAction(btn.dataset.corpAct));
    });
  }

  function syncCorporalFromInputs() {
    const f = state.corporalForm;
    const pesoEl = $('#corpPeso');
    if (pesoEl) f.peso_am_kg = pesoEl.value === '' ? '' : Number(pesoEl.value);
    const cinturaEl = $('#corpCintura');
    if (cinturaEl) f.cintura_cm = cinturaEl.value === '' ? '' : Number(cinturaEl.value);
  }

  function handleCorporalAction(act) {
    if (!state.corporalForm) state.corporalForm = defaultsForCorporal();
    syncCorporalFromInputs();
    const f = state.corporalForm;
    if (act === 'stepup-peso') f.peso_am_kg = round2(Math.max(0, (Number(f.peso_am_kg) || 0) + 0.1));
    else if (act === 'stepdown-peso') f.peso_am_kg = round2(Math.max(0, (Number(f.peso_am_kg) || 0) - 0.1));
    else if (act === 'stepup-cintura') f.cintura_cm = round2(Math.max(0, (Number(f.cintura_cm) || 0) + 0.5));
    else if (act === 'stepdown-cintura') f.cintura_cm = round2(Math.max(0, (Number(f.cintura_cm) || 0) - 0.5));
    else if (act === 'save') { onSaveCorporal(); return; }
    renderCorporal();
  }

  async function onSaveCorporal() {
    const f = state.corporalForm;
    if (f.peso_am_kg === '' && f.cintura_cm === '') { toast('Ingresa peso o cintura'); return; }
    const mutation = buildCorporalMutation({ peso_am_kg: f.peso_am_kg, cintura_cm: f.cintura_cm });
    state.corporalByFecha[mutation.fecha] = mutation;
    toast('✓ Medidas guardadas');
    await persistOptimistic(db, STORE_CORPORAL, mutation);
    triggerSync();
  }

  // En segundo plano, igual que refreshRoutineInBackground: si el Sheet tiene
  // check-ins/corporal de otro dispositivo, los trae y actualiza la UI — nunca
  // pisa el formulario en curso, solo el estado ya guardado.
  async function refreshCheckinsCorporalInBackground() {
    const url = getUrl();
    if (!url) return;
    const res = await fetchCheckinsAndCorporal(url);
    if (res.error) return;
    state.checkinsById = mergeIncomingByKey(state.checkinsById, res.checkins, 'session_id');
    state.corporalByFecha = mergeIncomingByKey(state.corporalByFecha, res.corporal, 'fecha');
    state.corporalForm = defaultsForCorporal();
    renderCorporal();
  }

  window.addEventListener('DOMContentLoaded', async () => {
    applyTheme();
    $('#themeBtn').addEventListener('click', () => toggleTheme());
    $('#urlInput').value = getUrl();
    $('#urlInput').addEventListener('change', (e) => setUrl(e.target.value));
    $('#syncBtn').addEventListener('click', () => triggerSync());
    $('#status').addEventListener('click', () => triggerSync()); // "toca para reintentar" (§4.5)

    db = await openDB();
    const hydrated = await hydrateFromDB(db);
    state.byId = hydrated.byId;
    state.checkinsById = hydrated.checkinsById;
    state.corporalByFecha = hydrated.corporalByFecha;
    state.lastSeq = hydrated.meta.last_seq || 0;
    state.corporalForm = defaultsForCorporal();

    let routineRows = hydrated.meta.rutina;
    let catalogRows = hydrated.meta.catalogo;
    if (!routineRows || !routineRows.length || !catalogRows || !catalogRows.length) {
      const fallback = await loadFallbackRoutine();
      routineRows = fallback.routine;
      catalogRows = fallback.catalog;
      if (routineRows.length) { await setMeta(db, 'rutina', routineRows); await setMeta(db, 'catalogo', catalogRows); }
    }
    state.days = buildRoutineFromRows(routineRows, catalogRows);

    renderDayTabs();
    renderExerciseList();
    renderLog();
    renderCheckin();
    renderCorporal();
    setStatusState(computeSyncStatus({ outboxCount: hydrated.outbox.length, hasError: false }));

    if (getUrl()) { triggerSync(); refreshRoutineInBackground(); refreshCheckinsCorporalInBackground(); }
  });

  window.addEventListener('online', () => triggerSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') triggerSync();
  });

  // Service worker: solo cachea el app-shell (estáticos) para que abra offline
  // en el iPhone — no interviene en el sync de datos (eso ya lo hace IndexedDB
  // + outbox). Falla en silencio si el navegador no lo soporta.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}
