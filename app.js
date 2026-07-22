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
export const APP_VERSION = '0.7.0-progresion-bloque';

// Ejercicios indicadores del Sistema Maestro Físico (Parte 6.7): "si 4+ de 6
// suben su 1RM estimado mes a mes, todo lo demás es detalle". Se marcan en la
// UI para que Alejandro sepa dónde mirar primero.
export const INDICATOR_EXERCISE_IDS = [
  'press_incl_db', 'press_militar', 'jalon_pecho', 'remo_pecho_apoyado', 'prensa_inclinada', 'curl_femoral_sentado'
];

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

const LB_TO_KG = 0.45359237;

// Convierte a kg — mismo factor que Core.gs::computePesoKg, para que el 1RM
// estimado del cliente sea consistente con `peso_kg` calculado en el backend.
export function toKg(peso, unidad) {
  if (peso == null) return null;
  return unidad === 'lb' ? peso * LB_TO_KG : peso;
}

// 1RM estimado (Epley ajustado por RIR, Sistema Maestro Físico Parte 9.2):
// peso_kg * (1 + (reps + rir) / 30). rir null se trata como 0 (conservador:
// no asume margen que no se registró).
export function epley1RM(pesoKg, reps, rir) {
  if (pesoKg == null || reps == null) return null;
  const r = rir != null ? rir : 0;
  return pesoKg * (1 + (reps + r) / 30);
}

// "Semana N / M" — el bloque y la semana los controla Alejandro a mano (no se
// derivan del calendario): entrena de forma asíncrona (si falta un día,
// retoma el mismo día de rutina al siguiente), así que una semana de rutina
// no equivale a 7 días de calendario.
export function blockLabel(sem, blockWeeks) {
  const total = blockWeeks || 12;
  const n = sem || 1;
  return 'Semana ' + n + ' / ' + total;
}

// Agrupa las series NO borradas de un ejercicio por fecha ("sesión" = todas
// las series de ese ejercicio hechas el mismo día), excluyendo opcionalmente
// una fecha (típicamente hoy — para que "la vez pasada" no se contamine con
// series que ya registraste en la sesión en curso). Ordenadas de la más
// reciente a la más antigua; dentro de cada sesión, por set_index ascendente
// (así sets[0] es la primera serie de esa sesión y sets[sets.length-1] la
// última). Base tanto de `lastSessionSetFor` como del motor de progresión
// (Parte 6) en `suggestNextSet`.
export function groupSessionsFor(byId, exerciseId, excludeFecha) {
  const byFecha = new Map();
  for (const r of Object.values(byId || {})) {
    if (r.exercise_id !== exerciseId || r.deleted_at) continue;
    if (excludeFecha && r.fecha === excludeFecha) continue;
    if (!byFecha.has(r.fecha)) byFecha.set(r.fecha, []);
    byFecha.get(r.fecha).push(r);
  }
  const sessions = [...byFecha.entries()].map(([fecha, sets]) => ({
    fecha,
    sem: sets[0].sem != null ? sets[0].sem : null,
    sets: sets.slice().sort((a, b) => (a.set_index || 0) - (b.set_index || 0))
  }));
  sessions.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return sessions;
}

// La última serie registrada de la sesión anterior más reciente de un
// ejercicio (excluyendo `excludeFecha`, típicamente hoy) — o null si no hay
// historial previo. Es la base de "Última vez: …" en la UI. Distinto de
// `lastSetFor`: ese incluye el día de hoy a propósito (sirve para el
// pre-relleno/"= que la vez pasada" dentro de la MISMA sesión en curso); este
// existe específicamente para comparar contra una sesión distinta.
export function lastSessionSetFor(byId, exerciseId, excludeFecha) {
  const sessions = groupSessionsFor(byId, exerciseId, excludeFecha);
  if (!sessions.length) return null;
  const sets = sessions[0].sets;
  return sets[sets.length - 1];
}

// Sugerencia de progresión — motor de doble progresión del Sistema Maestro
// Físico (Parte 6), evaluado sobre la ÚLTIMA SESIÓN COMPLETA del ejercicio
// (todas sus series, no solo una). Acepta un array de series (orden por
// set_index) o, por compatibilidad, una sola serie suelta (se trata como
// sesión de una única serie — mismo comportamiento que la versión anterior
// de esta función).
//
// Reglas aplicadas (Parte 6, en este orden):
//  1. SUBIR PESO — todas las series de la sesión llegaron al tope del rango
//     con RIR ≥ objetivo → +incremento del ejercicio.
//  2. MANTENER (regla 3 del sistema) — solo la PRIMERA serie llegó al tope →
//     mismo peso, sube reps en el resto.
//  3. BAJAR PESO — todas las series quedaron bajo el fondo del rango a RIR 0.
//     (Simplificado a la sesión más reciente: la regla original pide 2
//     sesiones seguidas por seguridad; esta versión mantiene el mismo nivel
//     de conservadurismo que la implementación anterior, no es una regresión.)
//  4. SUBIR REPS (regla 2, estado normal) — ninguna de las anteriores →
//     mantener peso, buscar +1 rep.
export function suggestNextSet(prevSets, exercise) {
  const sets = Array.isArray(prevSets) ? prevSets.filter(Boolean) : (prevSets ? [prevSets] : []);
  if (!sets.length) return { text: 'Sin historial. Arranca conservador.', cls: '' };
  const last = sets[sets.length - 1];
  if (exercise.tipo !== 'peso') return { text: 'Última vez: ' + last.reps + ' seg.', cls: '' };

  const objetivoRir = exercise.rir != null ? exercise.rir : 1;
  const inc = last.unidad === 'lb' ? (exercise.incremento_lb || 5) : (exercise.incremento_kg || 2.5);
  const atTop = (s) => exercise.rep_max != null && s.reps >= exercise.rep_max && (s.rir == null || s.rir >= objetivoRir);
  const belowMin = (s) => exercise.rep_min != null && s.reps < exercise.rep_min && (s.rir || 0) <= 0;

  const allAtTop = sets.every(atTop);
  const onlyFirstAtTop = sets.length > 1 && atTop(sets[0]) && sets.slice(1).every((s) => !atTop(s));
  const allBelowMin = sets.every(belowMin);

  if (allAtTop) return { text: '⬆️ Sube a ' + round2(last.peso + inc) + ' ' + last.unidad, cls: 'up' };
  if (onlyFirstAtTop) return { text: 'Mantén ' + last.peso + ' ' + last.unidad + ' — sube reps en el resto de series', cls: '' };
  if (allBelowMin) return { text: '⬇️ Baja a ' + round2(Math.max(0, last.peso - inc)) + ' ' + last.unidad, cls: 'warn' };
  return { text: 'Mantén ' + last.peso + ' ' + last.unidad + ', busca +1 rep', cls: '' };
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
    corporalForm: null, // se inicializa en defaultsForCorporal() al primer render
    currentSem: 1, // semana ACTUAL dentro del bloque — la controla Alejandro a mano, no el calendario
    blockNum: 1,
    blockWeeks: 12
  };

  const $ = (sel) => document.querySelector(sel);

  // Persistencia robusta de la URL del Apps Script: localStorage es la lectura
  // rápida de siempre, pero la PWA instalada en iOS ("Añadir a inicio") corre
  // en un contenedor de almacenamiento separado del Safari de navegación, así
  // que localStorage puede llegar vacío ahí aunque ya se haya guardado antes.
  // `meta` (IndexedDB) es la copia de respaldo: se restaura sola al boot (ver
  // DOMContentLoaded) y se escribe en paralelo en cada guardado.
  function getUrl() { return localStorage.getItem(LS_URL) || ''; }
  async function setUrl(v) {
    const trimmed = v.trim();
    localStorage.setItem(LS_URL, trimmed);
    if (db) await setMeta(db, 'apps_script_url', trimmed);
  }

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

  // Indicador de semana/bloque (§0.A del plan) — Alejandro lo controla a mano
  // con ▲▼, no se deriva del calendario (entrena de forma asíncrona: si falta
  // un día, retoma el mismo día de rutina al siguiente).
  function renderBlockBar() {
    $('#blockBar').innerHTML = `
      <button type="button" data-block-act="down" aria-label="Semana anterior">−</button>
      <span>Bloque ${state.blockNum} · ${blockLabel(state.currentSem, state.blockWeeks)}</span>
      <button type="button" data-block-act="up" aria-label="Semana siguiente">+</button>
    `;
    $('#blockBar').querySelectorAll('[data-block-act]').forEach((btn) => {
      btn.addEventListener('click', () => handleBlockAction(btn.dataset.blockAct));
    });
  }

  async function handleBlockAction(act) {
    if (act === 'up') state.currentSem = Math.min(state.blockWeeks, state.currentSem + 1);
    else if (act === 'down') state.currentSem = Math.max(1, state.currentSem - 1);
    await setMeta(db, 'current_sem', state.currentSem);
    renderBlockBar();
    renderExerciseList(); // la sugerencia/última-vez no cambia, pero el peso guardado sí llevará esta semana
  }

  // "Empezar bloque limpio": soft-delete de todas las series activas locales
  // (no se pierden del historial en el Sheet — quedan con deleted_at, igual
  // que un borrado manual) + reinicia el contador a Semana 1. Se usa ahora
  // para descartar las series de prueba, y a futuro al cerrar un bloque real
  // (el número de bloque en sí se ajusta a mano en Ajustes, no aquí — evita
  // etiquetar "Bloque 2" algo que en realidad es solo limpieza de pruebas).
  async function onResetBlock() {
    const activos = Object.values(state.byId).filter((r) => !r.deleted_at);
    if (!confirm('¿Empezar bloque limpio? Se van a borrar (soft-delete) ' + activos.length + ' serie(s) activa(s) y la semana vuelve a 1. No se pierden del historial en el Sheet.')) return;
    for (const s of activos) {
      const del = buildDeleteMutation(s);
      state.byId[s.set_id] = del;
      await persistSetOptimistic(db, del);
    }
    state.currentSem = 1;
    await setMeta(db, 'current_sem', state.currentSem);
    renderBlockBar();
    renderExerciseList();
    renderLog();
    toast('✓ Bloque reiniciado');
    triggerSync();
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

  // "Última vez (Sem N): 60 kg × 8 @ RIR 1 · 1RM est 78 kg (+2.3% vs Sem 2)" —
  // presentacional, DOM-only (no se testea en Node, ver README). Usa
  // `groupSessionsFor` (excluye hoy) para no comparar la sesión en curso
  // contra sí misma; el Δ1RM sale de comparar la última sesión contra la
  // anterior a esa (si existe).
  function formatLastTimeInfo(sessions, ex) {
    if (!sessions.length) return '';
    const last = sessions[0];
    const lastSet = last.sets[last.sets.length - 1];
    const semTxt = last.sem != null ? ('Sem ' + last.sem) : last.fecha;
    let line = 'Última vez (' + semTxt + '): ' + lastSet.peso + ' ' + lastSet.unidad + ' × ' + lastSet.reps +
      (lastSet.rir != null ? ' @ RIR ' + lastSet.rir : '');
    if (ex.tipo === 'peso') {
      const rmLast = epley1RM(toKg(lastSet.peso, lastSet.unidad), lastSet.reps, lastSet.rir);
      if (rmLast != null) {
        if (sessions[1]) {
          const prevSet = sessions[1].sets[sessions[1].sets.length - 1];
          const rmPrev = epley1RM(toKg(prevSet.peso, prevSet.unidad), prevSet.reps, prevSet.rir);
          if (rmPrev) {
            const delta = ((rmLast - rmPrev) / rmPrev) * 100;
            const prevSemTxt = sessions[1].sem != null ? ('Sem ' + sessions[1].sem) : sessions[1].fecha;
            line += ' · 1RM est ' + round2(rmLast) + ' kg (' + (delta >= 0 ? '+' : '') + round2(delta) + '% vs ' + prevSemTxt + ')';
          }
        } else {
          line += ' · 1RM est ' + round2(rmLast) + ' kg';
        }
      }
    }
    return line;
  }

  function renderExerciseList() {
    const list = $('#exList');
    const day = state.days[state.currentDayIdx];
    if (!day) { list.innerHTML = '<p class="note">Sin rutina cargada.</p>'; return; }
    list.innerHTML = day.exercises.map((ex, i) => {
      const isOpen = state.openIdx === i;
      const done = setsToday(ex.exercise_id);
      const pill = `<div class="setpill${done >= ex.series ? ' done' : ''}">${done}/${ex.series}</div>`;
      const isIndicator = INDICATOR_EXERCISE_IDS.includes(ex.exercise_id);
      const head = `<div class="exhead" data-idx="${i}" data-act="toggle">
          <div><div class="exname">${isIndicator ? '🎯 ' : ''}${ex.nombre}</div><div class="plan">${planSummary(ex)}</div></div>
          ${pill}
        </div>`;
      if (!isOpen) return `<div class="card" data-idx="${i}">${head}</div>`;

      if (!state.curForm[ex.exercise_id]) state.curForm[ex.exercise_id] = defaultsFor(ex);
      const f = state.curForm[ex.exercise_id];
      const last = lastSetFor(state.byId, ex.exercise_id); // incluye hoy — base del pre-relleno/"= que la vez pasada"
      const sessions = groupSessionsFor(state.byId, ex.exercise_id, todayISO()); // excluye hoy — base de la comparación
      const sug = suggestNextSet(sessions[0] ? sessions[0].sets : null, ex);
      const lastInfo = formatLastTimeInfo(sessions, ex);
      const isPeso = ex.tipo === 'peso';
      const repsLabel = ex.tipo === 'tiempo' ? 'Segundos' : 'Reps';

      return `<div class="card open" data-idx="${i}">
        ${head}
        <div class="exbody">
          ${lastInfo ? `<div class="lastinfo">${lastInfo}</div>` : ''}
          <div class="sug ${sug.cls}">${sug.text}</div>
          ${isPeso ? `
          <div class="frow"><div class="flab">Peso</div><div class="step">
            <button type="button" data-idx="${i}" data-act="stepdown-peso">−</button>
            <input type="number" inputmode="decimal" id="peso${i}" value="${f.peso}">
            <button type="button" data-idx="${i}" data-act="stepup-peso">+</button>
          </div></div>
          <div class="frow"><div class="flab">Unidad</div><div class="unit-seg">
            <button type="button" class="${f.unidad === 'kg' ? 'on' : ''}" data-idx="${i}" data-act="setunit" data-v="kg">kg</button>
            <button type="button" class="${f.unidad === 'lb' ? 'on' : ''}" data-idx="${i}" data-act="setunit" data-v="lb">lb</button>
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
    } else if (act === 'setunit') {
      f.unidad = v === 'lb' ? 'lb' : 'kg';
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
      sem: state.currentSem, // semana ACTUAL del bloque, controlada a mano (ver renderBlockBar)
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
    $('#syncBtn').addEventListener('click', () => triggerSync());
    $('#status').addEventListener('click', () => triggerSync()); // "toca para reintentar" (§4.5)

    db = await openDB();

    // Persistencia robusta de la URL (§0.C del plan): si localStorage llegó
    // vacío (típico al abrir por primera vez la PWA YA INSTALADA en iOS, cuyo
    // contenedor de almacenamiento es distinto al de Safari normal), se
    // restaura desde la copia en `meta` guardada la vez anterior.
    if (!getUrl()) {
      const savedUrl = await getMeta(db, 'apps_script_url', '');
      if (savedUrl) localStorage.setItem(LS_URL, savedUrl);
    }
    $('#urlInput').value = getUrl();
    $('#urlInput').addEventListener('change', async (e) => { await setUrl(e.target.value); });

    const hydrated = await hydrateFromDB(db);
    state.byId = hydrated.byId;
    state.checkinsById = hydrated.checkinsById;
    state.corporalByFecha = hydrated.corporalByFecha;
    state.lastSeq = hydrated.meta.last_seq || 0;
    state.currentSem = hydrated.meta.current_sem || 1;
    state.blockNum = hydrated.meta.block_num || 1;
    state.blockWeeks = hydrated.meta.block_weeks || 12;
    state.corporalForm = defaultsForCorporal();

    $('#blockNumInput').value = state.blockNum;
    $('#blockNumInput').addEventListener('change', async (e) => {
      state.blockNum = Math.max(1, parseInt(e.target.value, 10) || 1);
      await setMeta(db, 'block_num', state.blockNum);
      renderBlockBar();
    });
    $('#blockWeeksInput').value = state.blockWeeks;
    $('#blockWeeksInput').addEventListener('change', async (e) => {
      state.blockWeeks = Math.max(1, parseInt(e.target.value, 10) || 12);
      state.currentSem = Math.min(state.currentSem, state.blockWeeks);
      await setMeta(db, 'block_weeks', state.blockWeeks);
      await setMeta(db, 'current_sem', state.currentSem);
      renderBlockBar();
    });
    $('#resetBlockBtn').addEventListener('click', () => onResetBlock());

    let routineRows = hydrated.meta.rutina;
    let catalogRows = hydrated.meta.catalogo;
    if (!routineRows || !routineRows.length || !catalogRows || !catalogRows.length) {
      const fallback = await loadFallbackRoutine();
      routineRows = fallback.routine;
      catalogRows = fallback.catalog;
      if (routineRows.length) { await setMeta(db, 'rutina', routineRows); await setMeta(db, 'catalogo', catalogRows); }
    }
    state.days = buildRoutineFromRows(routineRows, catalogRows);

    renderBlockBar();
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
