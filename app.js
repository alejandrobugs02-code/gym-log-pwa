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

// Las filas materializadas mantienen el shape v1 durante el cutover. El sobre
// append-only usa v2; separar ambas versiones evita reinterpretar datos locales.
export const SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 2;
export const APP_VERSION = '0.9.0-sistema-fisico';
export const CONFIG_RELEASE_ID = 'rutina-6d-flex-v1';
export const DEFAULT_BLOCK_WEEKS = 12;
export const TIMEZONE = 'America/Lima';
export const CYCLE_DAY_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];

// ============================================================================
// Rutina data-driven (Fase 5) — funciones puras. La app ya no trae ejercicios
// hardcodeados: lee `Rutina`+`Ejercicios` del Sheet (fetchRoutineAndCatalog) con
// caché autenticada del último release válido para abrir sin conexión.
// ============================================================================

export function diaLabel(dia) {
  return 'Día ' + String(dia).replace(/^d/i, '');
}

export function normalizeDayId(dayId) {
  const normalized = String(dayId || '').trim().toLowerCase();
  return CYCLE_DAY_IDS.includes(normalized) ? normalized : null;
}

export function nextDayId(dayId) {
  const normalized = normalizeDayId(dayId);
  if (!normalized) return 'd1';
  const idx = CYCLE_DAY_IDS.indexOf(normalized);
  return idx === CYCLE_DAY_IDS.length - 1 ? 'd1' : CYCLE_DAY_IDS[idx + 1];
}

// Normaliza una configuración que el backend ya publicó y auditó. El bundle
// público no conoce ejercicios, exclusiones ni indicadores personales.
export function applyCanonicalRoutineRelease(routineRows, catalogRows) {
  const catalog = (catalogRows || []).map((row) => Object.assign({}, row));
  const routine = (routineRows || []).map((row) => Object.assign({}, row, {
    routine_version: CONFIG_RELEASE_ID,
    config_release_id: CONFIG_RELEASE_ID,
    day_id: normalizeDayId(row.day_id || row.dia) || row.day_id || row.dia
  }));
  return { routine, catalog, config_release_id: CONFIG_RELEASE_ID };
}

export function isValidCanonicalRoutineRelease(activeReleaseId, routineRows, catalogRows, validation) {
  if (activeReleaseId !== CONFIG_RELEASE_ID) return false;
  if (!validation || validation.ok !== true) return false;
  if (!(routineRows || []).length || !(catalogRows || []).length) return false;
  const canonical = applyCanonicalRoutineRelease(routineRows, catalogRows);
  const days = buildRoutineFromRows(canonical.routine, canonical.catalog).map((day) => day.dia);
  return CYCLE_DAY_IDS.every((dayId) => days.includes(dayId));
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
    if (!cat || cat.activo === false || cat.active === false) continue;
    const dayId = normalizeDayId(r.day_id || r.dia);
    if (!dayId) continue;
    if (!byDia.has(dayId)) byDia.set(dayId, []);
    byDia.get(dayId).push({
      exercise_id: r.exercise_id,
      orden: Number(r.orden) || 0,
      nombre: cat.nombre || r.exercise_id,
      series: Number(r.series) || 0,
      rep_min: r.rep_min != null ? Number(r.rep_min) : null,
      rep_max: r.rep_max != null ? Number(r.rep_max) : null,
      rir: r.rir != null && r.rir !== '' ? Number(r.rir) : null,
      descanso_seg: r.descanso_seg != null ? Number(r.descanso_seg) : null,
      tipo: r.tipo || 'peso',
      duration_unit: r.duration_unit || (r.exercise_id === 'cardio_zona2' ? 'min' : (r.tipo === 'tiempo' ? 's' : null)),
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

// ============================================================================
// Bloques, ciclos y sesiones explícitas. Son funciones puras para que el flujo
// D1→D6 se pueda validar sin DOM ni reloj global.
// ============================================================================

export function createBlock(input, ctx) {
  input = input || {};
  ctx = ctx || {};
  const now = ctx.now || new Date();
  return {
    block_id: input.block_id || (ctx.uuid ? ctx.uuid() : newUUID()),
    config_release_id: input.config_release_id || CONFIG_RELEASE_ID,
    started_at: input.started_at || now.toISOString(),
    start_local_date: input.start_local_date || todayISO(now),
    planned_weeks: Math.max(1, Number(input.planned_weeks) || DEFAULT_BLOCK_WEEKS),
    status: input.status || 'active',
    closed_at: input.closed_at || null,
    close_reason: input.close_reason || null,
    schema_version: EVENT_SCHEMA_VERSION
  };
}

export function blockWeek(block, at) {
  if (!block || !block.start_local_date) return 1;
  const parseDate = (value) => {
    const parts = String(value).split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  };
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateParts = {};
  for (const part of formatter.formatToParts(at || new Date())) if (part.type !== 'literal') dateParts[part.type] = part.value;
  const currentDate = dateParts.year + '-' + dateParts.month + '-' + dateParts.day;
  const elapsedDays = Math.max(0, Math.floor((parseDate(currentDate) - parseDate(block.start_local_date)) / 86400000));
  return Math.min(block.planned_weeks || DEFAULT_BLOCK_WEEKS, Math.floor(elapsedDays / 7) + 1);
}

export function createCycle(block, input, ctx) {
  input = input || {};
  ctx = ctx || {};
  const now = ctx.now || new Date();
  if (!block || !block.block_id) throw new Error('block_id requerido');
  return {
    cycle_id: input.cycle_id || (ctx.uuid ? ctx.uuid() : newUUID()),
    block_id: block.block_id,
    config_release_id: block.config_release_id || CONFIG_RELEASE_ID,
    started_at: input.started_at || now.toISOString(),
    started_day_id: normalizeDayId(input.started_day_id) || 'd1',
    status: input.status || 'active',
    closed_at: input.closed_at || null,
    close_status: input.close_status || null,
    schema_version: EVENT_SCHEMA_VERSION
  };
}

export function suggestedDayForCycle(cycle, sessions) {
  if (!cycle || cycle.status !== 'active') return 'd1';
  const closed = (sessions || [])
    .filter((s) => s.cycle_id === cycle.cycle_id && (s.status === 'completed' || s.status === 'partial'))
    .sort((a, b) => String(a.ended_at || a.started_at).localeCompare(String(b.ended_at || b.started_at)));
  if (!closed.length) return normalizeDayId(cycle.started_day_id) || 'd1';
  return nextDayId(closed[closed.length - 1].day_id);
}

export function createSession(input, ctx) {
  input = input || {};
  ctx = ctx || {};
  const now = ctx.now || new Date();
  const dayId = normalizeDayId(input.day_id);
  if (!input.block_id) throw new Error('block_id requerido');
  if (!input.cycle_id) throw new Error('cycle_id requerido');
  if (!dayId) throw new Error('day_id inválido');
  if (input.suggested_day_id && dayId !== normalizeDayId(input.suggested_day_id) && !String(input.sequence_exception_reason || '').trim()) {
    throw new Error('motivo requerido para excepción de secuencia');
  }
  return {
    session_id: input.session_id || (ctx.uuid ? ctx.uuid() : newUUID()),
    block_id: input.block_id,
    cycle_id: input.cycle_id,
    day_id: dayId,
    dia: dayId,
    config_release_id: input.config_release_id || CONFIG_RELEASE_ID,
    routine_version: input.config_release_id || CONFIG_RELEASE_ID,
    suggested_day_id: normalizeDayId(input.suggested_day_id) || dayId,
    sequence_exception_reason: String(input.sequence_exception_reason || '').trim() || null,
    started_at: input.started_at || now.toISOString(),
    local_date: input.local_date || todayISO(now),
    status: 'active',
    ended_at: null,
    schema_version: EVENT_SCHEMA_VERSION
  };
}

export function closeSession(session, status, validSetCount, ctx) {
  ctx = ctx || {};
  if (!session || session.status !== 'active') throw new Error('sesión activa requerida');
  if (!['completed', 'partial'].includes(status)) throw new Error('status de cierre inválido');
  if (status === 'completed' && Number(validSetCount) < 1) throw new Error('una sesión completada requiere al menos una serie válida');
  return Object.assign({}, session, {
    status,
    valid_set_count: Math.max(0, Number(validSetCount) || 0),
    ended_at: (ctx.now || new Date()).toISOString()
  });
}

export function closeCycleForSession(cycle, session) {
  if (!cycle || !session || normalizeDayId(session.day_id) !== 'd6') return cycle;
  return Object.assign({}, cycle, {
    status: 'closed',
    close_status: session.status === 'partial' ? 'partial' : 'completed',
    end_day: normalizeDayId(session.day_id),
    closed_at: session.ended_at || new Date().toISOString()
  });
}

// Adaptadores GET heredados, conservados únicamente para los mocks locales de
// regresión. Producción usa bootstrap POST autenticado y estas funciones se
// niegan a salir de loopback.
export async function fetchRoutineAndCatalog(baseUrl, fetchImpl) {
  if (!isLoopbackUrl(baseUrl)) return { routine: [], catalog: [], error: 'transporte GET heredado deshabilitado fuera de loopback' };
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

export async function fetchCheckinsAndCorporal(baseUrl, fetchImpl) {
  if (!isLoopbackUrl(baseUrl)) return { checkins: [], corporal: [], error: 'transporte GET heredado deshabilitado fuera de loopback' };
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

// 1RM estimado principal: Epley estándar, sin ajustar por RIR.
// peso_kg * (1 + reps / 30). La variante por RIR queda experimental y no se
// usa para comparar rendimiento ni mostrar tendencias canónicas.
export function epley1RM(pesoKg, reps) {
  if (pesoKg == null || reps == null) return null;
  return pesoKg * (1 + reps / 30);
}

// "Semana N / M" — etiqueta de la semana temporal del bloque. La semana se
// deriva de fechas reales; la secuencia D1-D6 sigue siendo independiente del
// calendario y un descanso no constituye incumplimiento.
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
    const groupKey = r.block_id && r.session_id ? r.session_id : r.fecha;
    if (excludeFecha && (r.fecha === excludeFecha || r.session_id === excludeFecha)) continue;
    if (!byFecha.has(groupKey)) byFecha.set(groupKey, []);
    byFecha.get(groupKey).push(r);
  }
  const sessions = [...byFecha.entries()].map(([key, sets]) => ({
    fecha: sets[0].fecha,
    session_id: sets[0].session_id || key,
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
  if (exercise.tipo !== 'peso') {
    const isLegacyDuration = last.duration_value == null;
    const value = isLegacyDuration ? last.reps : last.duration_value;
    const unit = isLegacyDuration ? 'seg' : (last.duration_unit || 's');
    return { text: 'Última vez: ' + value + ' ' + unit + '.', cls: '' };
  }

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
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  for (const part of formatter.formatToParts(date)) if (part.type !== 'literal') parts[part.type] = part.value;
  return parts.year + '-' + parts.month + '-' + parts.day;
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
  const isDuration = form.tipo === 'tiempo' || form.duration_value != null;
  const hasExternalLoad = !isDuration && (form.tipo == null || form.tipo === 'peso');
  const durationValue = isDuration
    ? Number(form.duration_value != null ? form.duration_value : form.reps)
    : null;
  return {
    type: 'set',
    set_id: form.set_id || newUUID(),
    session_id: form.session_id,
    exercise_id: form.exercise_id,
    set_index: form.set_index,
    fecha: form.fecha || todayISO(),
    sem: form.sem != null ? form.sem : null,
    dia: normalizeDayId(form.day_id || form.dia) || (form.dia != null ? form.dia : null),
    day_id: normalizeDayId(form.day_id || form.dia),
    block_id: form.block_id || null,
    cycle_id: form.cycle_id || null,
    config_release_id: form.config_release_id || form.routine_version || null,
    routine_version: form.config_release_id || form.routine_version || null,
    peso: hasExternalLoad ? Number(form.peso) : null,
    unidad: hasExternalLoad ? form.unidad : null,
    reps: isDuration ? null : Number(form.reps),
    duration_value: isDuration ? durationValue : null,
    duration_unit: isDuration ? (form.duration_unit === 'min' ? 'min' : 's') : null,
    rir: !isDuration && form.rir != null && form.rir !== '' ? Number(form.rir) : null,
    dolor: form.dolor != null && form.dolor !== '' ? Number(form.dolor) : 0,
    updated_at: (ctx.now || new Date()).toISOString(),
    deleted_at: form.deleted_at || null,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION
  };
}

// Sobre append-only para el API v2. El payload preserva el valor introducido;
// una edición/tombstone crea otro event_id y referencia la versión anterior.
export function canonicalEventPayload(entityType, entity) {
  entity = entity || {};
  const common = {};
  if (entity.notes != null) common.notes = String(entity.notes);
  if (entity.comment != null) common.comment = String(entity.comment);
  if (entity.comentario != null) common.comentario = String(entity.comentario);
  if (entity.reason != null) common.reason = String(entity.reason);
  if (entityType === 'block') return Object.assign(common, {
    release_id: entity.release_id || entity.config_release_id || CONFIG_RELEASE_ID,
    objective: entity.objective || null,
    start_date: entity.start_date || entity.start_local_date || null,
    planned_weeks: Number(entity.planned_weeks) || DEFAULT_BLOCK_WEEKS,
    status: entity.status || 'active',
    end_date: entity.end_date || (entity.closed_at ? String(entity.closed_at).slice(0, 10) : null)
  });
  if (entityType === 'cycle') return Object.assign(common, {
    status: entity.status || 'active',
    started_at_utc: entity.started_at_utc || entity.started_at || null,
    completed_at_utc: entity.completed_at_utc || entity.closed_at || null,
    start_day: entity.start_day || String(entity.started_day_id || 'd1').toUpperCase(),
    end_day: entity.end_day ? String(entity.end_day).toUpperCase() : null,
    close_status: entity.close_status || null,
    exception_reason: entity.exception_reason || entity.sequence_exception_reason || null
  });
  if (entityType === 'session') return Object.assign(common, {
    day_id: String(entity.day_id || entity.dia || '').toUpperCase(),
    started_at_utc: entity.started_at_utc || entity.started_at || null,
    ended_at_utc: entity.ended_at_utc || entity.ended_at || null,
    status: entity.status === 'active' ? 'open' : entity.status,
    exception_reason: entity.exception_reason || entity.sequence_exception_reason || null
  });
  if (entityType === 'set') return Object.assign(common, {
    session_id: entity.session_id,
    exercise_id: entity.exercise_id,
    set_index: Number(entity.set_index),
    set_type: entity.set_type || 'work',
    weight_value: entity.weight_value != null ? Number(entity.weight_value) : (entity.peso != null ? Number(entity.peso) : null),
    weight_unit: entity.weight_unit || entity.unidad || null,
    reps: entity.reps != null ? Number(entity.reps) : null,
    rir: entity.rir != null ? Number(entity.rir) : null,
    pain: entity.pain != null ? Number(entity.pain) : (entity.dolor != null ? Number(entity.dolor) : null),
    technique: entity.technique != null ? Number(entity.technique) : null,
    duration_value: entity.duration_value != null ? Number(entity.duration_value) : null,
    duration_unit: entity.duration_unit || null
  });
  if (entityType === 'session_checkin') return Object.assign(common, {
    session_id: entity.session_id,
    energy: entity.energy != null ? Number(entity.energy) : (entity.energia != null ? Number(entity.energia) : null),
    pump: entity.pump != null ? Number(entity.pump) : null,
    technique: entity.technique != null ? Number(entity.technique) : (entity.tecnica != null ? Number(entity.tecnica) : null),
    sleep_hours: entity.sleep_hours != null ? Number(entity.sleep_hours) : (entity.sueno != null ? Number(entity.sueno) : null),
    pain: entity.pain != null ? Number(entity.pain) : (entity.dolor != null ? Number(entity.dolor) : null)
  });
  if (entityType === 'body_measurement') return Object.assign(common, {
    measurement_type: entity.measurement_type,
    value: Number(entity.value),
    unit: entity.unit,
    protocol: entity.protocol || null
  });
  if (entityType === 'recovery_daily') return Object.assign(common, {
    sleep_hours: entity.sleep_hours ?? null, sleep_quality: entity.sleep_quality ?? null,
    energy: entity.energy ?? null, steps: entity.steps ?? null, pain: entity.pain ?? null,
    pain_location: entity.pain_location || null
  });
  if (entityType === 'nutrition_daily') return Object.assign(common, {
    kcal: entity.kcal ?? null, protein_g: entity.protein_g ?? null,
    carbs_g: entity.carbs_g ?? null, fat_g: entity.fat_g ?? null, source: entity.source || null
  });
  if (entityType === 'extraordinary_event') return Object.assign(common, {
    event_type: entity.event_type, starts_at: entity.starts_at || null,
    ends_at: entity.ends_at || null, severity: entity.severity ?? null
  });
  return common;
}

export function buildEventEnvelope(entityType, entity, operation, context, ctx) {
  context = context || {};
  ctx = ctx || {};
  const now = ctx.now || new Date();
  const idFields = {
    set: 'set_id', session: 'session_id', cycle: 'cycle_id', block: 'block_id',
    session_checkin: 'session_id', body_measurement: 'body_measurement_id',
    recovery_daily: 'entity_id', nutrition_daily: 'entity_id', extraordinary_event: 'extraordinary_event_id'
  };
  const entityId = entity && (entity.entity_id || entity[idFields[entityType]]);
  if (!entityId) throw new Error('entity_id requerido para ' + entityType);
  return {
    event_id: ctx.event_id || (ctx.uuid ? ctx.uuid() : newUUID()),
    person_id: context.person_id || null,
    entity_type: entityType,
    entity_id: String(entityId),
    operation: operation || 'create',
    base_event_id: context.base_event_id || (entity && entity._last_event_id) || null,
    occurred_at_utc: now.toISOString(),
    local_date: context.local_date || (entity && (entity.local_date || entity.fecha)) || todayISO(now),
    timezone: context.timezone || TIMEZONE,
    device_id: context.device_id || null,
    schema_version: EVENT_SCHEMA_VERSION,
    app_version: APP_VERSION,
    config_release_id: context.config_release_id || (entity && (entity.config_release_id || entity.routine_version)) || CONFIG_RELEASE_ID,
    block_id: context.block_id || (entity && entity.block_id) || null,
    cycle_id: context.cycle_id || (entity && entity.cycle_id) || null,
    payload: canonicalEventPayload(entityType, entity)
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
    dia: normalizeDayId(form.day_id || form.dia) || (form.dia != null ? form.dia : null),
    day_id: normalizeDayId(form.day_id || form.dia),
    block_id: form.block_id || null,
    cycle_id: form.cycle_id || null,
    config_release_id: form.config_release_id || null,
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

function isLoopbackUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) {
    return false;
  }
}

export function validateBackendUrl(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl || '').trim()); } catch (_) { throw new Error('URL del backend inválida'); }
  if (isLoopbackUrl(url.href)) return url.href;
  const validHost = url.protocol === 'https:' && url.hostname === 'script.google.com';
  const validPath = /^\/macros\/s\/[^/]+\/exec$/.test(url.pathname);
  if (!validHost || !validPath || url.username || url.password) {
    throw new Error('Usa una URL HTTPS /macros/s/.../exec de script.google.com');
  }
  url.search = ''; url.hash = '';
  return url.href;
}

// Adaptador v1 exclusivo para mocks locales y pruebas de migración. El cliente
// del navegador no lo invoca: producción exige token y API POST v2.
export async function pushMutations(baseUrl, mutations, fetchImpl) {
  if (!isLoopbackUrl(baseUrl)) throw new Error('transporte v1 deshabilitado fuera de loopback');
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
  if (!isLoopbackUrl(baseUrl)) throw new Error('transporte v1 deshabilitado fuera de loopback');
  const f = fetchImpl || fetch;
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(since || 0);
  const res = await f(url);
  return res.json();
}

export async function postApiAction(baseUrl, action, payload, auth, fetchImpl) {
  if (!baseUrl) throw new Error('URL del backend requerida');
  if (!auth || !String(auth.token || '').trim()) throw new Error('token de dispositivo requerido');
  if (!auth.device_id) throw new Error('device_id requerido');
  if (!['push', 'pull', 'bootstrap'].includes(action)) throw new Error('action inválida');
  const f = fetchImpl || fetch;
  const requestUrl = fetchImpl ? baseUrl : validateBackendUrl(baseUrl);
  const body = Object.assign({
    action,
    request_id: (payload && payload.request_id) || newUUID(),
    device_id: auth.device_id,
    token: String(auth.token).trim()
  }, payload || {});
  delete body.request_id_override;
  const res = await f(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  if (res && 'ok' in res && !res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function uniqueEvents(events) {
  const byId = new Map();
  for (const event of events || []) {
    if (event && event.event_id) byId.set(event.event_id, event);
  }
  return [...byId.values()].sort((a, b) => Number(a.server_seq || 0) - Number(b.server_seq || 0));
}

export async function syncEventCycle({ url, token, deviceId, cursor, events, requireBootstrap, fetchImpl }) {
  const result = { events: [], nextCursor: Number(cursor) || 0, acked: [], rejected: [], conflicts: [], configRelease: null, error: null };
  try {
    if (events && events.length) {
      const pushed = await postApiAction(url, 'push', { events }, { token, device_id: deviceId }, fetchImpl);
      const results = pushed.results || [];
      result.acked = results.filter((row) => row.status === 'accepted' ||
        (row.status === 'idempotent' && row.acceptance_status !== 'conflict'));
      result.rejected = results.filter((row) => row.status === 'rejected');
      result.conflicts = results.filter((row) => row.status === 'conflict' ||
        (row.status === 'idempotent' && row.acceptance_status === 'conflict'));
      // El next_cursor de push NO avanza el cursor local: podría saltarse
      // eventos de otro dispositivo. Solo un pull persistido puede avanzarlo.
    }
    let hasMore = true;
    let page = 0;
    while (hasMore && page < 100) {
      const action = page === 0 && (requireBootstrap || result.nextCursor === 0) ? 'bootstrap' : 'pull';
      const pulled = await postApiAction(url, action, { cursor: result.nextCursor }, { token, device_id: deviceId }, fetchImpl);
      result.events.push(...(pulled.events || []));
      result.nextCursor = Number(pulled.next_cursor ?? result.nextCursor) || result.nextCursor;
      result.configRelease = pulled.config || result.configRelease;
      hasMore = !!pulled.has_more;
      page += 1;
    }
    if (hasMore) throw new Error('pull incompleto: más de 100 páginas');
    result.events = uniqueEvents(result.events);
  } catch (e) {
    result.error = String((e && e.message) || e);
  }
  return result;
}

export function canonicalEntityTypeFromLegacy(mutation) {
  if (!mutation) return 'set';
  if (mutation.type === 'checkin') return 'session_checkin';
  if (mutation.type === 'corporal') return 'body_measurement';
  return mutation.entity_type || mutation.type || 'set';
}

export function normalizeOutboxEvent(entry, context, ctx) {
  const value = entry && entry.mutation ? entry.mutation : entry;
  if (value && value.event_id && value.payload) return value;
  const operation = value && value.deleted_at ? 'tombstone' : 'create';
  return buildEventEnvelope(canonicalEntityTypeFromLegacy(value), value, operation, context, ctx);
}

function ackId(value) {
  return typeof value === 'string' ? value : (value && (value.event_id || value.entity_id || value.set_id));
}

export async function flushEventOutbox({ url, token, deviceId, cursor, outboxEntries, eventContext, requireBootstrap, fetchImpl }) {
  const entries = (outboxEntries || []).slice(0, 100);
  const events = entries.map((entry) => normalizeOutboxEvent(entry, Object.assign({}, eventContext, { device_id: deviceId })));
  const out = await syncEventCycle({ url, token, deviceId, cursor, events, requireBootstrap, fetchImpl });
  if (out.error) return Object.assign(out, { clearedOutboxIds: [] });
  const terminal = [...(out.acked || []), ...(out.rejected || []), ...(out.conflicts || [])];
  const resolved = new Set(terminal.map(ackId).filter(Boolean));
  const issueByEventId = new Map([...(out.rejected || []).map((row) => [row.event_id, Object.assign({ kind: 'rejected' }, row)]),
    ...(out.conflicts || []).map((row) => [row.event_id, Object.assign({ kind: 'conflict' }, row)])]);
  const clearedOutboxIds = [];
  const syncIssues = [];
  for (let i = 0; i < entries.length; i += 1) {
    const event = events[i];
    if (resolved.has(event.event_id) || resolved.has(event.entity_id)) clearedOutboxIds.push(entries[i].outbox_id);
    const issue = issueByEventId.get(event.event_id);
    if (issue) syncIssues.push(Object.assign({}, issue, { event, recorded_at_utc: new Date().toISOString() }));
  }
  return Object.assign(out, { clearedOutboxIds, syncIssues });
}

export function mergeSyncIssues(previous, incoming, acknowledged) {
  const byId = new Map((previous || []).filter((row) => row && row.event_id).map((row) => [row.event_id, row]));
  for (const row of acknowledged || []) if (row && row.event_id) byId.delete(row.event_id);
  for (const row of incoming || []) if (row && row.event_id) byId.set(row.event_id, row);
  return [...byId.values()].sort((a, b) => String(a.recorded_at_utc || '').localeCompare(String(b.recorded_at_utc || '')));
}

export function conflictRetryEvent(issue, ctx) {
  if (!issue || issue.kind !== 'conflict' || !issue.event || !issue.current_event_id) throw new Error('conflicto sin versión actual');
  ctx = ctx || {};
  return Object.assign({}, issue.event, {
    event_id: ctx.event_id || (ctx.uuid ? ctx.uuid() : newUUID()),
    operation: 'resolve_conflict',
    base_event_id: issue.current_event_id,
    occurred_at_utc: (ctx.now || new Date()).toISOString()
  });
}

export function currentStateAsAcceptedEvent(current) {
  if (!current || !current.current_event_id) throw new Error('versión de servidor ausente');
  return {
    event_id: current.current_event_id, entity_type: current.entity_type, entity_id: current.entity_id,
    operation: current.operation || 'update', server_seq: current.server_seq, acceptance_status: 'accepted',
    occurred_at_utc: current.occurred_at_utc, local_date: current.local_date,
    block_id: current.block_id || null, cycle_id: current.cycle_id || null,
    config_release_id: current.config_release_id, payload: current.payload || {}
  };
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
export const DB_VERSION = 2;
export const STORE_SETS = 'sets';
export const STORE_CHECKINS = 'checkins';
export const STORE_CORPORAL = 'corporal';
export const STORE_CONTEXT = 'context';
export const STORE_OUTBOX = 'outbox';
export const STORE_META = 'meta';
export const META_CLIENT_MODEL = 'client_model_v2';

export function emptyClientModel() {
  return {
    blocksById: {}, cyclesById: {}, sessionsById: {},
    active_block_id: null, active_cycle_id: null, active_session_id: null,
    model_version: 2
  };
}

export function normalizeClientModel(value) {
  const model = Object.assign(emptyClientModel(), value || {});
  model.blocksById = Object.assign({}, model.blocksById || {});
  model.cyclesById = Object.assign({}, model.cyclesById || {});
  model.sessionsById = Object.assign({}, model.sessionsById || {});
  const activeSession = model.sessionsById[model.active_session_id];
  if (!activeSession || activeSession.status !== 'active') model.active_session_id = null;
  const activeCycle = model.cyclesById[model.active_cycle_id];
  if (!activeCycle || activeCycle.status !== 'active') model.active_cycle_id = null;
  const activeBlock = model.blocksById[model.active_block_id];
  if (!activeBlock || activeBlock.status !== 'active') model.active_block_id = null;
  return model;
}

function payloadFromEvent(event) {
  if (!event) return {};
  if (event.payload && typeof event.payload === 'object') return event.payload;
  if (typeof event.payload_json === 'string') {
    try { return JSON.parse(event.payload_json); } catch (_) { return {}; }
  }
  return {};
}

function materializedRow(existing, event, keyField) {
  const payload = payloadFromEvent(event);
  const next = Object.assign({}, existing || {}, payload, {
    [keyField]: payload[keyField] || event.entity_id,
    _last_event_id: event.event_id,
    _server_seq: event.server_seq || null
  });
  delete next._syncError;
  if (event.operation === 'tombstone') next.deleted_at = payload.deleted_at || event.occurred_at_utc || new Date().toISOString();
  return next;
}

export function applyRemoteEvents(snapshot, events) {
  const next = {
    byId: Object.assign({}, snapshot.byId || {}),
    checkinsById: Object.assign({}, snapshot.checkinsById || {}),
    corporalByFecha: Object.assign({}, snapshot.corporalByFecha || {}),
    contextByKey: Object.assign({}, snapshot.contextByKey || {}),
    clientModel: normalizeClientModel(snapshot.clientModel)
  };
  for (const event of uniqueEvents(events)) {
    if (event.acceptance_status && event.acceptance_status !== 'accepted') continue;
    const type = event.entity_type;
    if (type === 'set') {
      const payload = payloadFromEvent(event);
      next.byId[event.entity_id] = materializedRow(next.byId[event.entity_id], Object.assign({}, event, { payload: Object.assign({}, payload, {
        fecha: event.local_date,
        block_id: event.block_id,
        cycle_id: event.cycle_id,
        config_release_id: event.config_release_id,
        peso: payload.weight_value,
        unidad: payload.weight_unit,
        dolor: payload.pain
      }) }), 'set_id');
    } else if (type === 'session_checkin') {
      const payload = payloadFromEvent(event);
      next.checkinsById[event.entity_id] = materializedRow(next.checkinsById[event.entity_id], Object.assign({}, event, { payload: Object.assign({}, payload, {
        fecha: event.local_date, block_id: event.block_id, cycle_id: event.cycle_id,
        config_release_id: event.config_release_id, energia: payload.energy,
        tecnica: payload.technique, sueno: payload.sleep_hours, dolor: payload.pain
      }) }), 'session_id');
    } else if (type === 'body_measurement') {
      const payload = payloadFromEvent(event);
      const fecha = event.local_date;
      const row = Object.assign({ fecha, _measurement_ids: {}, _measurement_event_ids: {} }, next.corporalByFecha[fecha] || {});
      if (payload.measurement_type === 'weight') row.peso_am_kg = event.operation === 'tombstone' ? null : (payload.unit === 'lb' ? Number(payload.value) * LB_TO_KG : Number(payload.value));
      if (payload.measurement_type === 'waist') row.cintura_cm = event.operation === 'tombstone' ? null : Number(payload.value);
      row._measurement_ids = Object.assign({}, row._measurement_ids, { [payload.measurement_type]: event.entity_id });
      row._measurement_event_ids = Object.assign({}, row._measurement_event_ids, { [payload.measurement_type]: event.event_id });
      row._server_seq = event.server_seq || null;
      row.deleted_at = row.peso_am_kg == null && row.cintura_cm == null ? event.occurred_at_utc : null;
      next.corporalByFecha[fecha] = row;
    } else if (type === 'recovery_daily' || type === 'nutrition_daily' || type === 'extraordinary_event') {
      const key = type === 'extraordinary_event' ? 'extra:' + event.entity_id : type + ':' + event.local_date;
      const payload = payloadFromEvent(event);
      next.contextByKey[key] = materializedRow(next.contextByKey[key], Object.assign({}, event, {
        payload: Object.assign({}, payload, {
          entity_key: key, entity_id: event.entity_id, entity_type: type, fecha: event.local_date
        })
      }), 'entity_key');
    } else if (type === 'session') {
      const payload = payloadFromEvent(event);
      next.clientModel.sessionsById[event.entity_id] = materializedRow(next.clientModel.sessionsById[event.entity_id], Object.assign({}, event, { payload: Object.assign({}, payload, {
        day_id: normalizeDayId(payload.day_id), dia: normalizeDayId(payload.day_id),
        block_id: event.block_id, cycle_id: event.cycle_id, config_release_id: event.config_release_id,
        started_at: payload.started_at_utc, ended_at: payload.ended_at_utc,
        status: payload.status === 'open' ? 'active' : payload.status,
        sequence_exception_reason: payload.exception_reason
      }) }), 'session_id');
    } else if (type === 'cycle') {
      const payload = payloadFromEvent(event);
      next.clientModel.cyclesById[event.entity_id] = materializedRow(next.clientModel.cyclesById[event.entity_id], Object.assign({}, event, { payload: Object.assign({}, payload, {
        block_id: event.block_id, config_release_id: event.config_release_id,
        started_at: payload.started_at_utc, closed_at: payload.completed_at_utc,
        started_day_id: normalizeDayId(payload.start_day), end_day: normalizeDayId(payload.end_day),
        close_status: payload.close_status, sequence_exception_reason: payload.exception_reason
      }) }), 'cycle_id');
    } else if (type === 'block') {
      const payload = payloadFromEvent(event);
      next.clientModel.blocksById[event.entity_id] = materializedRow(next.clientModel.blocksById[event.entity_id], Object.assign({}, event, { payload: Object.assign({}, payload, {
        config_release_id: payload.release_id || event.config_release_id,
        start_local_date: payload.start_date,
        started_at: payload.start_date ? payload.start_date + 'T00:00:00.000Z' : event.occurred_at_utc,
        closed_at: payload.end_date ? payload.end_date + 'T00:00:00.000Z' : null
      }) }), 'block_id');
    }
  }
  const newestActive = (rows) => {
    const active = rows.filter((row) => row.status === 'active' && !row.deleted_at)
      .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
    return active.length ? active[active.length - 1] : null;
  };
  const block = newestActive(Object.values(next.clientModel.blocksById));
  const cycle = newestActive(Object.values(next.clientModel.cyclesById));
  const session = newestActive(Object.values(next.clientModel.sessionsById));
  next.clientModel.active_block_id = block ? block.block_id : null;
  next.clientModel.active_cycle_id = cycle ? cycle.cycle_id : null;
  next.clientModel.active_session_id = session ? session.session_id : null;
  for (const row of Object.values(next.byId)) {
    const owner = next.clientModel.sessionsById[row.session_id];
    if (owner) { row.day_id = owner.day_id; row.dia = owner.day_id; }
  }
  return next;
}

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
      if (!db.objectStoreNames.contains(STORE_CONTEXT)) db.createObjectStore(STORE_CONTEXT, { keyPath: 'entity_key' });
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
export async function persistOptimistic(db, storeName, mutation, outboxPayload) {
  const t = db.transaction([storeName, STORE_OUTBOX], 'readwrite');
  t.objectStore(storeName).put(mutation);
  const outboxReq = t.objectStore(STORE_OUTBOX).add({ mutation: outboxPayload || mutation, enqueued_at: new Date().toISOString() });
  await txDone(t);
  return outboxReq.result; // outbox_id asignado
}

export async function persistOptimisticEvents(db, storeName, mutation, events) {
  const t = db.transaction([storeName, STORE_OUTBOX], 'readwrite');
  t.objectStore(storeName).put(mutation);
  const store = t.objectStore(STORE_OUTBOX);
  const ids = [];
  for (const event of events || []) {
    const req = store.add({ mutation: event, enqueued_at: new Date().toISOString() });
    req.onsuccess = () => ids.push(req.result);
  }
  await txDone(t);
  return ids;
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

export async function upgradeLegacyOutboxEntries(db, entries, context) {
  const pending = (entries || []).filter((entry) => {
    const event = entry.mutation;
    return !(event && event.event_id && event.payload) || !event.person_id || !event.device_id;
  });
  if (!pending.length) return entries || [];
  const t = db.transaction(STORE_OUTBOX, 'readwrite');
  const store = t.objectStore(STORE_OUTBOX);
  const replacements = new Map();
  for (const entry of pending) {
    const current = entry.mutation;
    const event = current && current.event_id && current.payload
      ? Object.assign({}, current, { person_id: current.person_id || context.person_id, device_id: current.device_id || context.device_id })
      : normalizeOutboxEvent(entry, context);
    const next = Object.assign({}, entry, { mutation: event, migrated_from_v1: true });
    replacements.set(entry.outbox_id, next);
    store.put(next);
  }
  await txDone(t);
  return (entries || []).map((entry) => replacements.get(entry.outbox_id) || entry);
}

export async function setMeta(db, key, value) {
  const t = db.transaction(STORE_META, 'readwrite');
  t.objectStore(STORE_META).put({ key, value });
  await txDone(t);
}

export async function persistClientModelOptimistic(db, clientModel, event) {
  const t = db.transaction([STORE_META, STORE_OUTBOX], 'readwrite');
  t.objectStore(STORE_META).put({ key: META_CLIENT_MODEL, value: normalizeClientModel(clientModel) });
  const req = t.objectStore(STORE_OUTBOX).add({ mutation: event, enqueued_at: new Date().toISOString() });
  await txDone(t);
  return req.result;
}

// Remotos + cursor + limpieza de ack viven en una sola transacción. Este es el
// invariante que evita saltarse para siempre filas recibidas de otro dispositivo.
export async function persistRemoteStateAndCursor(db, snapshot, cursor, clearIds, syncIssues) {
  const stores = [STORE_SETS, STORE_CHECKINS, STORE_CORPORAL, STORE_CONTEXT, STORE_META, STORE_OUTBOX];
  const t = db.transaction(stores, 'readwrite');
  const setsStore = t.objectStore(STORE_SETS);
  const checkinsStore = t.objectStore(STORE_CHECKINS);
  const corporalStore = t.objectStore(STORE_CORPORAL);
  const contextStore = t.objectStore(STORE_CONTEXT);
  for (const row of Object.values(snapshot.byId || {})) setsStore.put(row);
  for (const row of Object.values(snapshot.checkinsById || {})) checkinsStore.put(row);
  for (const row of Object.values(snapshot.corporalByFecha || {})) corporalStore.put(row);
  for (const row of Object.values(snapshot.contextByKey || {})) contextStore.put(row);
  const meta = t.objectStore(STORE_META);
  meta.put({ key: META_CLIENT_MODEL, value: normalizeClientModel(snapshot.clientModel) });
  meta.put({ key: 'last_seq', value: Number(cursor) || 0 });
  if (Array.isArray(syncIssues)) meta.put({ key: 'sync_issues', value: syncIssues });
  const outbox = t.objectStore(STORE_OUTBOX);
  for (const id of clearIds || []) outbox.delete(id);
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
  const [setsArr, checkinsArr, corporalArr, contextArr, outboxArr, metaArr] = await Promise.all([
    idbGetAll(db, STORE_SETS),
    idbGetAll(db, STORE_CHECKINS),
    idbGetAll(db, STORE_CORPORAL),
    idbGetAll(db, STORE_CONTEXT),
    idbGetAll(db, STORE_OUTBOX),
    idbGetAll(db, STORE_META)
  ]);
  const byId = {};
  for (const row of setsArr) byId[row.set_id] = row;
  const checkinsById = {};
  for (const row of checkinsArr) checkinsById[row.session_id] = row;
  const corporalByFecha = {};
  for (const row of corporalArr) corporalByFecha[row.fecha] = row;
  const contextByKey = {};
  for (const row of contextArr) contextByKey[row.entity_key] = row;
  const meta = {};
  for (const m of metaArr) meta[m.key] = m.value;
  return {
    byId, checkinsById, corporalByFecha, contextByKey, outbox: outboxArr, meta,
    clientModel: normalizeClientModel(meta[META_CLIENT_MODEL])
  };
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
  let syncPromise = null;
  let syncRequested = false;
  const state = {
    byId: {},
    lastSeq: 0,
    days: [], // [{dia,label,exercises:[...]}], data-driven (Fase 5) — ver buildRoutineFromRows
    currentDayIdx: 0,
    openIdx: null, // índice del ejercicio expandido en el acordeón (uno a la vez)
    curForm: {}, // exercise_id -> {peso, reps, rir, dolor, unidad} — estado del formulario en curso
    checkinsById: {}, // session_id -> fila (fase 7)
    corporalByFecha: {}, // fecha -> fila (fase 7)
    contextByKey: {}, // recovery/nutrition por día + eventos extraordinarios
    checkinForm: { energia: null, pump: null, tecnica: null, sueno: '', comentario: '' },
    corporalForm: null, // se inicializa en defaultsForCorporal() al primer render
    clientModel: emptyClientModel(),
    deviceId: null,
    token: '',
    personId: '',
    blockWeeks: DEFAULT_BLOCK_WEEKS,
    selectedDayId: 'd1',
    suggestedDayId: 'd1',
    bootstrapPending: true,
    pendingCheckinPromptSessionId: null,
    syncIssues: []
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
    const trimmed = v.trim() ? validateBackendUrl(v) : '';
    localStorage.setItem(LS_URL, trimmed);
    if (db) await setMeta(db, 'apps_script_url', trimmed);
  }

  async function setToken(v) {
    state.token = String(v || '').trim();
    if (db) await setMeta(db, 'device_token', state.token);
  }

  async function setPersonId(v) {
    state.personId = String(v || '').trim();
    if (db) await setMeta(db, 'person_id', state.personId);
  }

  function activeBlock() { return state.clientModel.blocksById[state.clientModel.active_block_id] || null; }
  function activeCycle() { return state.clientModel.cyclesById[state.clientModel.active_cycle_id] || null; }
  function activeSession() { return state.clientModel.sessionsById[state.clientModel.active_session_id] || null; }
  function modelSessions() { return Object.values(state.clientModel.sessionsById || {}); }

  function currentEventContext(extra) {
    const session = activeSession();
    const cycle = activeCycle();
    const block = activeBlock();
    return Object.assign({
    person_id: state.personId,
      timezone: TIMEZONE,
      device_id: state.deviceId,
      config_release_id: (session && session.config_release_id) || (block && block.config_release_id) || CONFIG_RELEASE_ID,
      block_id: (session && session.block_id) || (block && block.block_id) || null,
      cycle_id: (session && session.cycle_id) || (cycle && cycle.cycle_id) || null
    }, extra || {});
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

  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function computeSuggestedDay() {
    state.suggestedDayId = suggestedDayForCycle(activeCycle(), modelSessions());
    if (!normalizeDayId(state.selectedDayId)) state.selectedDayId = state.suggestedDayId;
    return state.suggestedDayId;
  }

  // El bloque se identifica por UUID y la semana se deriva de la fecha real.
  function renderBlockBar() {
    const bar = $('#blockBar');
    const block = activeBlock();
    const cycle = activeCycle();
    const label = block
      ? 'Bloque ' + block.block_id.slice(0, 8) + ' · ' + blockLabel(blockWeek(block), block.planned_weeks)
      : 'Sin bloque activo';
    const sub = cycle ? 'Ciclo ' + cycle.cycle_id.slice(0, 8) + ' · siguiente ' + diaLabel(computeSuggestedDay()) : 'Siguiente ' + diaLabel('d1');
    const wrap = makeEl('div', 'block-copy');
    wrap.append(makeEl('strong', '', label), makeEl('span', '', sub));
    bar.replaceChildren(wrap);
  }

  async function persistModelEvent(entityType, entity, operation, baseEventId) {
    const event = buildEventEnvelope(entityType, entity, operation, currentEventContext({ base_event_id: baseEventId }));
    entity._last_event_id = event.event_id;
    await persistClientModelOptimistic(db, state.clientModel, event);
    return event;
  }

  async function ensureActiveBlock() {
    if (activeBlock()) return activeBlock();
    if (!state.personId) throw new Error('Completa el ID de persona antes de crear el bloque');
    if (!state.days.length) throw new Error('Sin release de rutina validado');
    const block = createBlock({ planned_weeks: state.blockWeeks, config_release_id: CONFIG_RELEASE_ID });
    state.clientModel.blocksById[block.block_id] = block;
    state.clientModel.active_block_id = block.block_id;
    await persistModelEvent('block', block, 'create');
    return block;
  }

  async function onStartNewBlock() {
    if (activeSession()) { toast('Cierra la sesión activa primero'); return; }
    if (!state.personId || !state.days.length) { toast('Completa el emparejamiento y carga la rutina primero'); return; }
    const prior = activeBlock();
    if (prior && !confirm('¿Cerrar el bloque actual e iniciar uno nuevo? El historial se conserva completo.')) return;
    if (prior) {
      const base = prior._last_event_id;
      prior.status = 'closed';
      prior.closed_at = new Date().toISOString();
      prior.close_reason = 'inicio_manual_bloque_nuevo';
      await persistModelEvent('block', prior, 'update', base);
    }
    const cycle = activeCycle();
    if (cycle) {
      const base = cycle._last_event_id;
      cycle.status = 'closed';
      cycle.closed_at = new Date().toISOString();
      cycle.close_status = 'block_closed';
      await persistModelEvent('cycle', cycle, 'update', base);
    }
    state.clientModel.active_cycle_id = null;
    state.clientModel.active_block_id = null;
    await ensureActiveBlock();
    state.selectedDayId = 'd1';
    computeSuggestedDay();
    renderBlockBar();
    renderSessionPanel();
    renderDayTabs();
    renderExerciseList();
    toast('✓ Bloque nuevo; historial intacto');
    triggerSync();
  }

  function renderDayTabs() {
    const tabs = $('#dayTabs');
    const session = activeSession();
    const buttons = state.days.map((day, i) => {
      const btn = makeEl('button', i === state.currentDayIdx ? 'on' : '', day.label);
      btn.type = 'button';
      btn.dataset.day = String(i);
      btn.disabled = !!session && day.dia !== session.day_id;
      btn.addEventListener('click', () => {
        state.currentDayIdx = i;
        state.selectedDayId = day.dia;
        state.openIdx = null;
        renderDayTabs();
        renderSessionPanel();
        renderExerciseList();
      });
      return btn;
    });
    tabs.replaceChildren(...buttons);
  }

  function sessionSetCount(sessionId) {
    return Object.values(state.byId).filter((row) => row.session_id === sessionId && !row.deleted_at).length;
  }

  function renderSessionPanel() {
    const panel = $('#sessionPanel');
    if (!panel) return;
    const session = activeSession();
    if (!session && !state.days.length) {
      panel.replaceChildren(
        makeEl('strong', '', 'Rutina no disponible'),
        makeEl('p', 'session-detail', 'Completa el emparejamiento y sincroniza una vez. Después, el último release válido quedará disponible offline.')
      );
      return;
    }
    const suggested = computeSuggestedDay();
    const selected = state.days[state.currentDayIdx] ? state.days[state.currentDayIdx].dia : state.selectedDayId;
    state.selectedDayId = normalizeDayId(selected) || suggested;
    const title = makeEl('strong', '', session
      ? 'Sesión activa · ' + diaLabel(session.day_id)
      : 'Próxima sesión sugerida · ' + diaLabel(suggested));
    const detail = makeEl('p', 'session-detail', session
      ? sessionSetCount(session.session_id) + ' serie(s) · abierta ' + new Date(session.started_at).toLocaleString()
      : 'Calendario flexible: descansa cuando lo necesites y retoma la secuencia.');
    const nodes = [title, detail];
    if (!session) {
      if (state.selectedDayId !== suggested) {
        const label = makeEl('label', '', 'Motivo de excepción de secuencia');
        label.htmlFor = 'sequenceReason';
        const input = makeEl('textarea', 'sequence-reason');
        input.id = 'sequenceReason';
        input.maxLength = 240;
        input.placeholder = 'Ej.: equipo ocupado, reprogramación o recuperación';
        nodes.push(label, input);
      }
      const start = makeEl('button', 'save', '▶ INICIAR ' + diaLabel(state.selectedDayId).toUpperCase());
      start.type = 'button';
      start.addEventListener('click', () => onStartSession());
      nodes.push(start);
    } else {
      const actions = makeEl('div', 'session-actions');
      const completed = makeEl('button', 'save', '✓ CERRAR COMPLETADA');
      completed.type = 'button';
      completed.addEventListener('click', () => onCloseSession('completed'));
      const partial = makeEl('button', 'samebtn', 'Cerrar como parcial');
      partial.type = 'button';
      partial.addEventListener('click', () => onCloseSession('partial'));
      actions.append(completed, partial);
      nodes.push(actions);
    }
    panel.replaceChildren(...nodes);
  }

  async function onStartSession() {
    if (activeSession()) return;
    if (!state.personId || !state.days.length) { toast('Completa el emparejamiento y carga la rutina primero'); return; }
    const block = await ensureActiveBlock();
    const dayId = normalizeDayId(state.selectedDayId) || computeSuggestedDay();
    const suggested = computeSuggestedDay();
    const reasonEl = $('#sequenceReason');
    const reason = reasonEl ? reasonEl.value.trim() : '';
    let cycle = activeCycle();

    if (!cycle && dayId !== 'd1') {
      toast('D1 debe abrir un ciclo nuevo');
      return;
    }
    if (cycle && dayId === 'd1' && suggested !== 'd1') {
      if (!reason) { toast('Escribe el motivo para reiniciar antes de D6'); return; }
      const base = cycle._last_event_id;
      cycle.status = 'closed';
      cycle.close_status = 'partial';
      cycle.closed_at = new Date().toISOString();
      await persistModelEvent('cycle', cycle, 'update', base);
      state.clientModel.active_cycle_id = null;
      cycle = null;
    }
    if (!cycle) {
      cycle = createCycle(block, { started_day_id: 'd1' });
      state.clientModel.cyclesById[cycle.cycle_id] = cycle;
      state.clientModel.active_cycle_id = cycle.cycle_id;
      await persistModelEvent('cycle', cycle, 'create');
    }
    try {
      const session = createSession({
        block_id: block.block_id,
        cycle_id: cycle.cycle_id,
        day_id: dayId,
        suggested_day_id: suggested,
        sequence_exception_reason: reason,
        config_release_id: block.config_release_id
      });
      state.clientModel.sessionsById[session.session_id] = session;
      state.clientModel.active_session_id = session.session_id;
      await persistModelEvent('session', session, 'create');
      state.checkinForm = { energia: null, pump: null, tecnica: null, sueno: '', comentario: '' };
      renderBlockBar(); renderDayTabs(); renderSessionPanel(); renderExerciseList(); renderCheckin();
      toast('✓ Sesión iniciada');
      triggerSync();
    } catch (e) {
      toast(String(e.message || e));
    }
  }

  async function onCloseSession(status) {
    const session = activeSession();
    if (!session) return;
    if (!state.checkinsById[session.session_id] && state.pendingCheckinPromptSessionId !== session.session_id) {
      state.pendingCheckinPromptSessionId = session.session_id;
      renderCheckin();
      const panel = $('#checkinPanel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Completa y guarda el check-in; toca cerrar otra vez para omitirlo');
      return;
    }
    state.pendingCheckinPromptSessionId = null;
    const count = sessionSetCount(session.session_id);
    try {
      const closed = closeSession(session, status, count);
      const base = session._last_event_id;
      state.clientModel.sessionsById[session.session_id] = closed;
      await persistModelEvent('session', closed, 'update', base);
      let cycle = activeCycle();
      if (cycle && closed.day_id === 'd6') {
        const cycleBase = cycle._last_event_id;
        cycle = closeCycleForSession(cycle, closed);
        state.clientModel.cyclesById[cycle.cycle_id] = cycle;
        state.clientModel.active_cycle_id = null;
        await persistModelEvent('cycle', cycle, 'update', cycleBase);
      }
      state.clientModel.active_session_id = null;
      await setMeta(db, META_CLIENT_MODEL, state.clientModel);
      state.suggestedDayId = closed.day_id === 'd6' ? 'd1' : nextDayId(closed.day_id);
      state.selectedDayId = state.suggestedDayId;
      const nextIdx = state.days.findIndex((d) => d.dia === state.selectedDayId);
      state.currentDayIdx = nextIdx >= 0 ? nextIdx : 0;
      state.openIdx = null;
      renderBlockBar(); renderDayTabs(); renderSessionPanel(); renderExerciseList(); renderLog();
      toast(status === 'completed' ? '✓ Sesión completada' : 'Sesión guardada como parcial');
      triggerSync();
    } catch (e) {
      toast(String(e.message || e));
    }
  }

  function planSummary(ex) {
    const rango = ex.series + '×' + (ex.rep_min ?? '') + '-' + (ex.rep_max ?? '');
    const rir = ex.tipo === 'peso' ? ' · RIR ' + (ex.rir ?? '—') : '';
    const desc = ex.descanso_seg ? ' · ⏱ ' + ex.descanso_seg + 's' : '';
    return rango + rir + desc;
  }

  function setsToday(exerciseId) {
    const session = activeSession();
    if (!session) return 0;
    return Object.values(state.byId).filter((r) => r.exercise_id === exerciseId && !r.deleted_at && r.session_id === session.session_id).length;
  }

  function defaultsFor(ex) {
    const last = lastSetFor(state.byId, ex.exercise_id);
    return {
      peso: last ? last.peso : '',
      reps: last && last.reps != null ? last.reps : '',
      duration_value: last && last.duration_value != null ? last.duration_value : (ex.tipo === 'tiempo' && last ? last.reps : ''),
      duration_unit: (last && last.duration_unit) || ex.duration_unit || (ex.exercise_id === 'cardio_zona2' ? 'min' : 's'),
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
    if (!day) { list.replaceChildren(makeEl('p', 'note', 'Sin rutina cargada.')); return; }
    const cards = day.exercises.map((ex, i) => {
      const isOpen = state.openIdx === i;
      const done = setsToday(ex.exercise_id);
      const card = makeEl('div', 'card' + (isOpen ? ' open' : ''));
      card.dataset.idx = String(i);
      const head = makeEl('div', 'exhead');
      head.dataset.idx = String(i); head.dataset.act = 'toggle';
      const copy = makeEl('div');
      copy.append(makeEl('div', 'exname', ex.nombre), makeEl('div', 'plan', planSummary(ex)));
      head.append(copy, makeEl('div', 'setpill' + (done >= ex.series ? ' done' : ''), done + '/' + ex.series));
      card.append(head);
      if (!isOpen) return card;

      if (!state.curForm[ex.exercise_id]) state.curForm[ex.exercise_id] = defaultsFor(ex);
      const f = state.curForm[ex.exercise_id];
      const last = lastSetFor(state.byId, ex.exercise_id); // incluye hoy — base del pre-relleno/"= que la vez pasada"
      const currentSession = activeSession();
      const sessions = groupSessionsFor(state.byId, ex.exercise_id, currentSession ? currentSession.session_id : todayISO());
      const lastInfo = formatLastTimeInfo(sessions, ex);
      const isPeso = ex.tipo === 'peso';
      const isDuration = ex.tipo === 'tiempo';
      const body = makeEl('div', 'exbody');
      if (lastInfo) body.append(makeEl('div', 'lastinfo', lastInfo));

      const stepRow = (label, id, value, downAct, upAct, inputMode) => {
        const row = makeEl('div', 'frow');
        const step = makeEl('div', 'step');
        const down = makeEl('button', '', '−'); down.type = 'button'; down.dataset.idx = String(i); down.dataset.act = downAct;
        const input = makeEl('input'); input.type = 'number'; input.inputMode = inputMode; input.id = id; input.value = value == null ? '' : String(value);
        const up = makeEl('button', '', '+'); up.type = 'button'; up.dataset.idx = String(i); up.dataset.act = upAct;
        step.append(down, input, up); row.append(makeEl('div', 'flab', label), step); return row;
      };
      const chipsRow = (label, values, selected, action, extraClass) => {
        const row = makeEl('div', 'frow');
        const chips = makeEl('div', 'chips' + (extraClass ? ' ' + extraClass : ''));
        for (const value of values) {
          const btn = makeEl('button', selected === value ? 'on' : '', value); btn.type = 'button';
          btn.dataset.idx = String(i); btn.dataset.act = action; btn.dataset.v = String(value); chips.append(btn);
        }
        row.append(makeEl('div', 'flab', label), chips); return row;
      };

      if (isPeso) {
        body.append(stepRow('Peso', 'peso' + i, f.peso, 'stepdown-peso', 'stepup-peso', 'decimal'));
        const unitRow = makeEl('div', 'frow');
        const units = makeEl('div', 'unit-seg');
        for (const unit of ['kg', 'lb']) {
          const btn = makeEl('button', f.unidad === unit ? 'on' : '', unit); btn.type = 'button';
          btn.dataset.idx = String(i); btn.dataset.act = 'setunit'; btn.dataset.v = unit; units.append(btn);
        }
        unitRow.append(makeEl('div', 'flab', 'Unidad'), units); body.append(unitRow);
      }
      if (isDuration) {
        body.append(stepRow('Duración', 'duration' + i, f.duration_value, 'stepdown-duration', 'stepup-duration', 'decimal'));
        const unitRow = makeEl('div', 'frow');
        const units = makeEl('div', 'unit-seg');
        for (const unit of ['s', 'min']) {
          const btn = makeEl('button', f.duration_unit === unit ? 'on' : '', unit); btn.type = 'button';
          btn.dataset.idx = String(i); btn.dataset.act = 'setdurationunit'; btn.dataset.v = unit; units.append(btn);
        }
        unitRow.append(makeEl('div', 'flab', 'Unidad'), units); body.append(unitRow);
      } else {
        body.append(stepRow('Reps', 'reps' + i, f.reps, 'stepdown-reps', 'stepup-reps', 'numeric'));
      }
      if (isPeso) body.append(chipsRow('RIR', [0, 1, 2, 3, 4, 5], f.rir, 'rir'));
      body.append(chipsRow('Dolor', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], f.dolor, 'dolor', 'pain'));
      if (last) {
        const same = makeEl('button', 'samebtn', '= que la vez pasada'); same.type = 'button';
        same.dataset.idx = String(i); same.dataset.act = 'same'; body.append(same);
      }
      const save = makeEl('button', 'save', activeSession() ? '✓ GUARDAR SERIE' : 'INICIA UNA SESIÓN PARA REGISTRAR');
      save.type = 'button'; save.dataset.idx = String(i); save.dataset.act = 'save'; save.disabled = !activeSession(); body.append(save);
      card.append(body);
      return card;
    });
    list.replaceChildren(...cards);
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
    const durationEl = $('#duration' + idx);
    if (durationEl) f.duration_value = durationEl.value === '' ? '' : Number(durationEl.value);
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
    } else if (act === 'stepup-duration' || act === 'stepdown-duration') {
      const dir = act === 'stepup-duration' ? 1 : -1;
      const step = f.duration_unit === 'min' ? 1 : 5;
      f.duration_value = Math.max(0, (Number(f.duration_value) || 0) + dir * step);
    } else if (act === 'setunit') {
      f.unidad = v === 'lb' ? 'lb' : 'kg';
    } else if (act === 'setdurationunit') {
      f.duration_unit = v === 'min' ? 'min' : 's';
    } else if (act === 'rir') {
      f.rir = Number(v);
    } else if (act === 'dolor') {
      f.dolor = Number(v);
    } else if (act === 'same') {
      const last = lastSetFor(state.byId, ex.exercise_id);
      if (last) {
        f.peso = last.peso; f.reps = last.reps; f.rir = last.rir; f.unidad = last.unidad;
        f.duration_value = last.duration_value != null ? last.duration_value : (ex.tipo === 'tiempo' ? last.reps : f.duration_value);
        f.duration_unit = last.duration_unit || f.duration_unit;
      }
    } else if (act === 'save') {
      onSaveSet(idx, ex, day);
      return;
    }
    renderExerciseList();
  }

  async function onSaveSet(idx, ex, day) {
    const session = activeSession();
    if (!session) { toast('Inicia una sesión primero'); return; }
    const f = state.curForm[ex.exercise_id];
    const isPeso = ex.tipo === 'peso';
    const isDuration = ex.tipo === 'tiempo';
    if ((isPeso && (f.peso === '' || f.peso == null)) || (!isDuration && (f.reps === '' || f.reps == null)) || (isDuration && (f.duration_value === '' || f.duration_value == null))) {
      toast('Falta ' + (isPeso ? 'peso o reps' : (isDuration ? 'duración' : 'reps')));
      return;
    }
    const mutation = buildSetMutation({
      session_id: session.session_id,
      block_id: session.block_id,
      cycle_id: session.cycle_id,
      day_id: session.day_id,
      config_release_id: session.config_release_id,
      exercise_id: ex.exercise_id,
      set_index: setsToday(ex.exercise_id) + 1, // 1..n dentro del ejercicio/SESIÓN (no histórico total)
      dia: session.day_id,
      sem: blockWeek(activeBlock()),
      tipo: ex.tipo,
      peso: isPeso ? f.peso : 0,
      unidad: isPeso ? f.unidad : ex.unidad_default,
      reps: f.reps,
      duration_value: isDuration ? f.duration_value : null,
      duration_unit: isDuration ? f.duration_unit : null,
      rir: isPeso ? f.rir : null,
      dolor: f.dolor
    });
    const event = buildEventEnvelope('set', mutation, 'create', currentEventContext());
    mutation._last_event_id = event.event_id;
    state.byId[mutation.set_id] = mutation; // optimista, instantáneo en la UI
    renderExerciseList();
    renderLog();
    toast('✓ Serie guardada');
    await persistOptimistic(db, STORE_SETS, mutation, event); // durable ANTES de intentar red
    triggerSync(); // no bloquea: si falla, queda en el outbox para el próximo disparador
  }

  async function onDeleteSet(set_id) {
    const existing = state.byId[set_id];
    if (!existing) return;
    if (!existing._last_event_id) {
      toast('Sincroniza primero esta serie legado antes de borrarla');
      return;
    }
    const del = buildDeleteMutation(existing);
    const event = buildEventEnvelope('set', del, 'tombstone', currentEventContext({ base_event_id: existing._last_event_id }));
    del._last_event_id = event.event_id;
    state.byId[set_id] = del;
    renderExerciseList();
    renderLog();
    await persistOptimistic(db, STORE_SETS, del, event);
    triggerSync();
  }

  // Punto de entrada de los 5 disparadores (guardar/online/abrir/foreground/manual):
  // un disparador "real" siempre gana sobre un reintento automático programado —
  // se cancela el timer de backoff pendiente (si hay) y se intenta ya.
  function triggerSync() {
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    if (syncPromise) { syncRequested = true; return syncPromise; }
    syncPromise = attemptFlush().finally(() => {
      syncPromise = null;
      if (syncRequested) { syncRequested = false; triggerSync(); }
    });
    return syncPromise;
  }

  async function applyServerConfig(config) {
    if (!config) return null;
    const routineRows = config.routine || config.routine_items || [];
    const catalogRows = config.catalog || config.exercises || [];
    if (!isValidCanonicalRoutineRelease(config.active_release_id, routineRows, catalogRows, config.validation)) {
      setStatusState({ state: 'error', label: 'Release de rutina inválido o incompleto; se conserva la caché anterior' });
      return false;
    }
    const canonical = applyCanonicalRoutineRelease(routineRows, catalogRows);
    await setMeta(db, 'rutina', canonical.routine);
    await setMeta(db, 'catalogo', canonical.catalog);
    await setMeta(db, 'routine_release_id', CONFIG_RELEASE_ID);
    await setMeta(db, 'routine_validation_ok', true);
    const currentDia = state.days[state.currentDayIdx] && state.days[state.currentDayIdx].dia;
    state.days = buildRoutineFromRows(canonical.routine, canonical.catalog);
    const keep = state.days.findIndex((day) => day.dia === currentDia);
    state.currentDayIdx = keep >= 0 ? keep : Math.max(0, state.days.findIndex((day) => day.dia === state.selectedDayId));
    state.bootstrapPending = false;
    return true;
  }

  async function attemptFlush() {
    const url = getUrl();
    if (!url || !db) { setStatusState({ state: 'error', label: 'Configura la URL del Apps Script en Ajustes' }); return; }
    if (!state.token) { setStatusState({ state: 'pending', label: 'Captura offline · configura el token para sincronizar' }); return; }
    if (!state.personId) { setStatusState({ state: 'pending', label: 'Captura offline · configura el ID de persona para sincronizar' }); return; }
    setStatusState({ state: 'sync', label: '↻ Sincronizando…' });
    let outboxEntries = await idbGetAll(db, STORE_OUTBOX);
    outboxEntries = await upgradeLegacyOutboxEntries(db, outboxEntries, currentEventContext());
    const out = await flushEventOutbox({
      url, token: state.token, deviceId: state.deviceId, cursor: state.lastSeq,
      outboxEntries, eventContext: currentEventContext(), requireBootstrap: state.bootstrapPending
    });

    if (!out.error) {
      const snapshot = applyRemoteEvents({
        byId: state.byId, checkinsById: state.checkinsById,
        corporalByFecha: state.corporalByFecha, contextByKey: state.contextByKey, clientModel: state.clientModel
      }, out.events);
      state.syncIssues = mergeSyncIssues(state.syncIssues, out.syncIssues, out.acked);
      await persistRemoteStateAndCursor(db, snapshot, out.nextCursor, out.clearedOutboxIds, state.syncIssues);
      state.byId = snapshot.byId;
      state.checkinsById = snapshot.checkinsById;
      state.corporalByFecha = snapshot.corporalByFecha;
      state.contextByKey = snapshot.contextByKey;
      state.clientModel = snapshot.clientModel;
      state.lastSeq = out.nextCursor;
      out.configApplied = await applyServerConfig(out.configRelease);
      for (const issue of state.syncIssues) {
        const event = issue.event || {};
        if (event.entity_type === 'set' && state.byId[event.entity_id]) {
          state.byId[event.entity_id]._syncError = issue.reason || issue.kind || 'requiere revisión';
        }
      }
    }
    computeSuggestedDay();
    renderBlockBar(); renderDayTabs(); renderSessionPanel();
    renderExerciseList();
    renderLog();
    renderSyncIssues();

    const remaining = await idbGetAll(db, STORE_OUTBOX);
    if (state.syncIssues.length) setStatusState({ state: 'error', label: '⚠️ ' + state.syncIssues.length + ' evento(s) requieren resolución' });
    else if (out.configApplied === false) setStatusState({ state: 'error', label: 'Release sin publicar o inválido; se conserva la última rutina válida' });
    else setStatusState(computeSyncStatus({ outboxCount: remaining.length, hasError: !!out.error }));
    if (!out.error && remaining.length > 0) syncRequested = true;

    // Backoff: si falló y nadie más programó ya un reintento, agenda el próximo
    // con demora creciente. Un éxito resetea el contador (regla de nextBackoffState).
    const nb = nextBackoffState(backoffAttempt, !!out.error);
    backoffAttempt = nb.attempt;
    if (out.error && nb.delay > 0 && !backoffTimer) {
      backoffTimer = setTimeout(() => { backoffTimer = null; triggerSync(); }, nb.delay);
    }
  }

  function renderLog() {
    const rows = Object.values(state.byId).filter((r) => !r.deleted_at).sort((a, b) => (a.set_id > b.set_id ? 1 : -1));
    const nodes = rows.map((row) => {
      const tr = makeEl('tr', row._syncError ? 'rowerr' : '');
      tr.title = row._syncError ? String(row._syncError) : '';
      const duration = row.duration_value != null ? row.duration_value + ' ' + (row.duration_unit || 's') : null;
      const values = [row.exercise_id, row.set_index, duration || ((row.peso ?? '—') + (row.unidad ? ' ' + row.unidad : '')), duration ? '—' : (row.reps ?? '—'), row.rir ?? '—'];
      for (const value of values) tr.append(makeEl('td', '', value));
      const action = makeEl('td');
      const button = makeEl('button', '', '✕'); button.type = 'button'; button.dataset.del = row.set_id;
      button.addEventListener('click', () => onDeleteSet(row.set_id)); action.append(button); tr.append(action);
      return tr;
    });
    $('#log').replaceChildren(...nodes);
  }

  function renderSyncIssues() {
    const panel = $('#syncIssuesPanel');
    if (!panel) return;
    const nodes = (state.syncIssues || []).map((issue) => {
      const event = issue.event || {};
      const box = makeEl('div', 'sync-issue');
      box.append(makeEl('strong', '', issue.kind === 'conflict' ? 'Conflicto conservado' : 'Evento rechazado'),
        makeEl('span', '', (event.entity_type || 'evento') + ' · ' + (issue.reason || 'requiere revisión')));
      if (issue.kind === 'conflict' && issue.current_state && issue.current_event_id) {
        const actions = makeEl('div', 'sync-issue-actions');
        const server = makeEl('button', '', 'Usar versión del servidor'); server.type = 'button';
        server.addEventListener('click', () => resolveSyncIssue(issue.event_id, 'server'));
        const local = makeEl('button', '', 'Reintentar mi cambio'); local.type = 'button';
        local.addEventListener('click', () => resolveSyncIssue(issue.event_id, 'local'));
        actions.append(server, local); box.append(actions);
      }
      return box;
    });
    panel.replaceChildren(...nodes);
  }

  async function resolveSyncIssue(eventId, choice) {
    const issue = state.syncIssues.find((row) => row.event_id === eventId);
    if (!issue) return;
    const remainingIssues = state.syncIssues.filter((row) => row.event_id !== eventId);
    if (choice === 'server') {
      const snapshot = applyRemoteEvents({
        byId: state.byId, checkinsById: state.checkinsById, corporalByFecha: state.corporalByFecha,
        contextByKey: state.contextByKey, clientModel: state.clientModel
      }, [currentStateAsAcceptedEvent(issue.current_state)]);
      await persistRemoteStateAndCursor(db, snapshot, state.lastSeq, [], remainingIssues);
      state.byId = snapshot.byId; state.checkinsById = snapshot.checkinsById;
      state.corporalByFecha = snapshot.corporalByFecha; state.clientModel = snapshot.clientModel;
      state.contextByKey = snapshot.contextByKey;
    } else {
      const retry = conflictRetryEvent(issue);
      const t = db.transaction([STORE_OUTBOX, STORE_META], 'readwrite');
      t.objectStore(STORE_OUTBOX).add({ mutation: retry, enqueued_at: new Date().toISOString() });
      t.objectStore(STORE_META).put({ key: 'sync_issues', value: remainingIssues });
      await txDone(t);
    }
    state.syncIssues = remainingIssues;
    renderBlockBar(); renderDayTabs(); renderSessionPanel(); renderExerciseList(); renderLog(); renderSyncIssues();
    toast(choice === 'server' ? '✓ Se conservó la versión del servidor' : 'Cambio reenviado sobre la versión actual');
    if (choice === 'local') triggerSync();
  }

  // ---- Fase 7: Check-in de sesión + Peso corporal (UI mínima) ----

  function defaultsForCorporal() {
    const existing = state.corporalByFecha[todayISO()];
    return { peso_am_kg: existing && existing.peso_am_kg != null ? existing.peso_am_kg : '', cintura_cm: existing && existing.cintura_cm != null ? existing.cintura_cm : '' };
  }

  function renderCheckin() {
    const panel = $('#checkinPanel');
    const session = activeSession();
    if (!session) { panel.replaceChildren(makeEl('p', 'note', 'Inicia una sesión para registrar su check-in.')); return; }
    const f = state.checkinForm;
    const nodes = [];
    for (const [field, label] of [['energia', 'Energía'], ['pump', 'Pump'], ['tecnica', 'Técnica']]) {
      const row = makeEl('div', 'frow'); const chips = makeEl('div', 'chips');
      for (let v = 1; v <= 5; v += 1) {
        const btn = makeEl('button', f[field] === v ? 'on' : '', v); btn.type = 'button';
        btn.addEventListener('click', () => { captureCheckinInputs(); state.checkinForm[field] = state.checkinForm[field] === v ? null : v; renderCheckin(); });
        chips.append(btn);
      }
      row.append(makeEl('div', 'flab', label), chips); nodes.push(row);
    }
    const sleepRow = makeEl('div', 'frow'); const sleepWrap = makeEl('div', 'step');
    const sleep = makeEl('input'); sleep.type = 'number'; sleep.inputMode = 'decimal'; sleep.id = 'checkinSueno'; sleep.placeholder = 'horas'; sleep.value = f.sueno;
    sleepWrap.append(sleep); sleepRow.append(makeEl('div', 'flab', 'Sueño'), sleepWrap); nodes.push(sleepRow);
    const comment = makeEl('textarea', 'checkin-comment'); comment.id = 'checkinComentario'; comment.placeholder = 'Dolores, máquinas ocupadas, etc.'; comment.maxLength = 2000; comment.value = f.comentario || '';
    nodes.push(comment);
    const save = makeEl('button', 'save', '✓ GUARDAR CHECK-IN'); save.type = 'button'; save.addEventListener('click', () => onSaveCheckin()); nodes.push(save);
    panel.replaceChildren(...nodes);
  }

  function captureCheckinInputs() {
    const sleep = $('#checkinSueno');
    const comment = $('#checkinComentario');
    if (sleep) state.checkinForm.sueno = sleep.value;
    if (comment) state.checkinForm.comentario = comment.value;
  }

  async function onSaveCheckin() {
    const session = activeSession();
    if (!session) { toast('Inicia una sesión primero'); return; }
    const f = state.checkinForm;
    captureCheckinInputs();
    if (f.energia == null && f.pump == null && f.tecnica == null && f.sueno === '' && !f.comentario) {
      toast('Check-in vacío'); return;
    }
    const day = state.days[state.currentDayIdx];
    const mutation = buildCheckinMutation({
      session_id: session.session_id, dia: session.day_id, day_id: session.day_id,
      block_id: session.block_id, cycle_id: session.cycle_id, config_release_id: session.config_release_id,
      energia: f.energia, pump: f.pump, tecnica: f.tecnica, sueno: f.sueno, comentario: f.comentario
    });
    const priorCheckin = state.checkinsById[mutation.session_id];
    const operation = priorCheckin && priorCheckin._last_event_id ? 'update' : 'create';
    const event = buildEventEnvelope('session_checkin', mutation, operation, currentEventContext({
      base_event_id: priorCheckin && priorCheckin._last_event_id
    }));
    mutation._last_event_id = event.event_id;
    state.checkinsById[mutation.session_id] = mutation;
    toast('✓ Check-in guardado');
    await persistOptimistic(db, STORE_CHECKINS, mutation, event);
    triggerSync();
  }

  function renderCorporal() {
    if (!state.corporalForm) state.corporalForm = defaultsForCorporal();
    const f = state.corporalForm;
    const makeMeasure = (label, id, value, suffix) => {
      const row = makeEl('div', 'frow'); const step = makeEl('div', 'step');
      const down = makeEl('button', '', '−'); down.type = 'button'; down.addEventListener('click', () => handleCorporalAction('stepdown-' + suffix));
      const input = makeEl('input'); input.type = 'number'; input.inputMode = 'decimal'; input.id = id; input.value = value;
      const up = makeEl('button', '', '+'); up.type = 'button'; up.addEventListener('click', () => handleCorporalAction('stepup-' + suffix));
      step.append(down, input, up); row.append(makeEl('div', 'flab', label), step); return row;
    };
    const save = makeEl('button', 'save', '✓ GUARDAR MEDIDAS DE HOY'); save.type = 'button'; save.addEventListener('click', () => handleCorporalAction('save'));
    $('#corporalPanel').replaceChildren(makeMeasure('Peso', 'corpPeso', f.peso_am_kg, 'peso'), makeMeasure('Cintura', 'corpCintura', f.cintura_cm, 'cintura'), save);
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
    if (!state.personId) { toast('Completa el emparejamiento antes de guardar'); return; }
    const f = state.corporalForm;
    if (f.peso_am_kg === '' && f.cintura_cm === '') { toast('Ingresa peso o cintura'); return; }
    const mutation = buildCorporalMutation({ peso_am_kg: f.peso_am_kg, cintura_cm: f.cintura_cm });
    const existing = state.corporalByFecha[mutation.fecha];
    mutation._measurement_ids = Object.assign({}, existing && existing._measurement_ids);
    mutation._measurement_event_ids = Object.assign({}, existing && existing._measurement_event_ids);
    const specs = [];
    if (mutation.peso_am_kg != null) specs.push({ type: 'weight', value: mutation.peso_am_kg, unit: 'kg', protocol: 'morning' });
    if (mutation.cintura_cm != null) specs.push({ type: 'waist', value: mutation.cintura_cm, unit: 'cm', protocol: 'standard' });
    const events = specs.map((spec) => {
      const entityId = mutation._measurement_ids[spec.type] || newUUID();
      const base = mutation._measurement_event_ids[spec.type] || null;
      const event = buildEventEnvelope('body_measurement', {
        body_measurement_id: entityId,
        measurement_type: spec.type,
        value: spec.value,
        unit: spec.unit,
        protocol: spec.protocol
      }, base ? 'update' : 'create', currentEventContext({ base_event_id: base, local_date: mutation.fecha }));
      mutation._measurement_ids[spec.type] = entityId;
      mutation._measurement_event_ids[spec.type] = event.event_id;
      return event;
    });
    state.corporalByFecha[mutation.fecha] = mutation;
    toast('✓ Medidas guardadas');
    await persistOptimisticEvents(db, STORE_CORPORAL, mutation, events);
    triggerSync();
  }

  function numberOrNull(value) {
    if (value === '' || value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function contextField(label, id, value, options) {
    const wrap = makeEl('div', 'context-field');
    const lab = makeEl('label', '', label); lab.htmlFor = id;
    let input;
    if (options && options.choices) {
      input = makeEl('select');
      for (const choice of options.choices) {
        const option = makeEl('option', '', choice.label); option.value = choice.value;
        if (String(value || '') === choice.value) option.selected = true;
        input.append(option);
      }
    } else if (options && options.multiline) {
      input = makeEl('textarea'); input.value = value || ''; input.maxLength = options.maxLength || 2000;
    } else {
      input = makeEl('input'); input.type = 'number'; input.inputMode = 'decimal';
      input.value = value == null ? '' : String(value);
      if (options && options.min != null) input.min = String(options.min);
      if (options && options.max != null) input.max = String(options.max);
      if (options && options.step != null) input.step = String(options.step);
    }
    input.id = id; wrap.append(lab, input); return wrap;
  }

  function renderDailyContext() {
    const date = todayISO();
    const recovery = state.contextByKey['recovery_daily:' + date] || {};
    const nutrition = state.contextByKey['nutrition_daily:' + date] || {};
    const recoverySection = makeEl('section', 'context-section');
    recoverySection.append(makeEl('h3', '', 'Recuperación'));
    const recoveryGrid = makeEl('div', 'context-grid');
    recoveryGrid.append(
      contextField('Sueño (h)', 'recoverySleep', recovery.sleep_hours, { min: 0, max: 24, step: 0.25 }),
      contextField('Energía (1–5)', 'recoveryEnergy', recovery.energy, { min: 1, max: 5, step: 1 }),
      contextField('Pasos', 'recoverySteps', recovery.steps, { min: 0, max: 200000, step: 1 }),
      contextField('Dolor (0–10)', 'recoveryPain', recovery.pain, { min: 0, max: 10, step: 1 })
    );
    recoverySection.append(recoveryGrid, contextField('Ubicación del dolor', 'recoveryPainLocation', recovery.pain_location, { multiline: true, maxLength: 240 }));
    const recoverySave = makeEl('button', 'context-save', 'Guardar recuperación'); recoverySave.type = 'button';
    recoverySave.addEventListener('click', () => saveDailyEntity('recovery_daily')); recoverySection.append(recoverySave);

    const nutritionSection = makeEl('section', 'context-section');
    nutritionSection.append(makeEl('h3', '', 'Nutrición'));
    const nutritionGrid = makeEl('div', 'context-grid');
    nutritionGrid.append(
      contextField('kcal', 'nutritionKcal', nutrition.kcal, { min: 0, max: 10000, step: 1 }),
      contextField('Proteína (g)', 'nutritionProtein', nutrition.protein_g, { min: 0, max: 1000, step: 1 }),
      contextField('Carbohidratos (g)', 'nutritionCarbs', nutrition.carbs_g, { min: 0, max: 2000, step: 1 }),
      contextField('Grasa (g)', 'nutritionFat', nutrition.fat_g, { min: 0, max: 1000, step: 1 })
    );
    const nutritionSave = makeEl('button', 'context-save', 'Guardar nutrición'); nutritionSave.type = 'button';
    nutritionSave.addEventListener('click', () => saveDailyEntity('nutrition_daily'));
    nutritionSection.append(nutritionGrid, nutritionSave);
    $('#dailyContextPanel').replaceChildren(recoverySection, nutritionSection);
  }

  async function saveDailyEntity(entityType) {
    if (!state.personId) { toast('Completa el emparejamiento antes de guardar'); return; }
    const date = todayISO();
    const key = entityType + ':' + date;
    const existing = state.contextByKey[key] || {};
    const values = entityType === 'recovery_daily' ? {
      sleep_hours: numberOrNull($('#recoverySleep').value), energy: numberOrNull($('#recoveryEnergy').value),
      steps: numberOrNull($('#recoverySteps').value), pain: numberOrNull($('#recoveryPain').value),
      pain_location: $('#recoveryPainLocation').value.trim() || null
    } : {
      kcal: numberOrNull($('#nutritionKcal').value), protein_g: numberOrNull($('#nutritionProtein').value),
      carbs_g: numberOrNull($('#nutritionCarbs').value), fat_g: numberOrNull($('#nutritionFat').value), source: 'manual'
    };
    if (!Object.values(values).some((value) => value != null && value !== '')) { toast('No hay datos para guardar'); return; }
    const row = Object.assign({}, existing, values, {
      entity_key: key, entity_id: existing.entity_id || newUUID(), entity_type: entityType, fecha: date
    });
    const base = existing._last_event_id || null;
    const event = buildEventEnvelope(entityType, row, base ? 'update' : 'create', currentEventContext({ base_event_id: base, local_date: date }));
    row._last_event_id = event.event_id; state.contextByKey[key] = row;
    await persistOptimistic(db, STORE_CONTEXT, row, event);
    toast(entityType === 'recovery_daily' ? '✓ Recuperación guardada' : '✓ Nutrición guardada');
    triggerSync();
  }

  function renderExtraordinary() {
    const section = makeEl('section', 'context-section');
    const grid = makeEl('div', 'context-grid');
    grid.append(
      contextField('Tipo', 'extraType', 'fatiga_extraordinaria', { choices: [
        { value: 'fatiga_extraordinaria', label: 'Fatiga extraordinaria' },
        { value: 'dolor', label: 'Dolor' }, { value: 'enfermedad', label: 'Enfermedad' },
        { value: 'viaje', label: 'Viaje' }, { value: 'estres', label: 'Estrés' },
        { value: 'descanso_adicional', label: 'Descanso adicional' }, { value: 'deload', label: 'Deload' }
      ] }),
      contextField('Severidad (1–5)', 'extraSeverity', 1, { min: 1, max: 5, step: 1 })
    );
    section.append(grid, contextField('Contexto', 'extraComment', '', { multiline: true, maxLength: 2000 }));
    const save = makeEl('button', 'context-save', 'Registrar evento'); save.type = 'button';
    save.addEventListener('click', () => saveExtraordinaryEvent()); section.append(save);
    const prior = Object.values(state.contextByKey).filter((row) => row.entity_type === 'extraordinary_event' && !row.deleted_at);
    if (prior.length) section.append(makeEl('p', 'note', prior.length + ' evento(s) extraordinario(s) conservados'));
    $('#extraordinaryPanel').replaceChildren(section);
  }

  async function saveExtraordinaryEvent() {
    if (!state.personId) { toast('Completa el emparejamiento antes de guardar'); return; }
    const id = newUUID();
    const date = todayISO();
    const row = {
      entity_key: 'extra:' + id, entity_id: id, extraordinary_event_id: id, entity_type: 'extraordinary_event',
      fecha: date, event_type: $('#extraType').value, severity: numberOrNull($('#extraSeverity').value),
      starts_at: new Date().toISOString(), ends_at: null, comment: $('#extraComment').value.trim() || null
    };
    const event = buildEventEnvelope('extraordinary_event', row, 'create', currentEventContext({ local_date: date }));
    row._last_event_id = event.event_id; state.contextByKey[row.entity_key] = row;
    await persistOptimistic(db, STORE_CONTEXT, row, event);
    renderExtraordinary(); toast('✓ Evento extraordinario registrado'); triggerSync();
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
    $('#urlInput').addEventListener('change', async (e) => {
      try { await setUrl(e.target.value); e.target.value = getUrl(); }
      catch (error) { e.target.value = getUrl(); toast(String(error.message || error)); }
    });

    const hydrated = await hydrateFromDB(db);
    state.byId = hydrated.byId;
    state.checkinsById = hydrated.checkinsById;
    state.corporalByFecha = hydrated.corporalByFecha;
    state.contextByKey = hydrated.contextByKey;
    state.lastSeq = hydrated.meta.last_seq || 0;
    state.clientModel = hydrated.clientModel;
    state.deviceId = hydrated.meta.device_id || newUUID();
    if (!hydrated.meta.device_id) await setMeta(db, 'device_id', state.deviceId);
    $('#deviceIdOutput').value = state.deviceId;
    $('#copyDeviceIdBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.deviceId);
        toast('✓ ID de dispositivo copiado');
      } catch (_error) {
        const output = $('#deviceIdOutput');
        output.focus();
        output.select();
        toast('ID seleccionado; usa Copiar');
      }
    });
    state.token = hydrated.meta.device_token || '';
    state.personId = hydrated.meta.person_id || '';
    state.syncIssues = Array.isArray(hydrated.meta.sync_issues) ? hydrated.meta.sync_issues : [];
    state.blockWeeks = Math.max(1, Number(hydrated.meta.block_weeks) || DEFAULT_BLOCK_WEEKS);
    state.corporalForm = defaultsForCorporal();

    $('#tokenInput').value = state.token;
    $('#tokenInput').addEventListener('change', async (e) => {
      await setToken(e.target.value);
      setStatusState({ state: 'pending', label: state.token ? 'Token guardado · toca para sincronizar' : 'Captura offline · token requerido' });
    });
    $('#personIdInput').value = state.personId;
    $('#personIdInput').addEventListener('change', async (e) => {
      await setPersonId(e.target.value);
      setStatusState({ state: 'pending', label: state.personId ? 'Emparejamiento guardado · toca para sincronizar' : 'Captura offline · ID de persona requerido' });
    });
    $('#blockWeeksInput').value = state.blockWeeks;
    $('#blockWeeksInput').addEventListener('change', async (e) => {
      state.blockWeeks = Math.max(1, parseInt(e.target.value, 10) || DEFAULT_BLOCK_WEEKS);
      await setMeta(db, 'block_weeks', state.blockWeeks);
      const block = activeBlock();
      if (block) {
        const base = block._last_event_id;
        block.planned_weeks = state.blockWeeks;
        await persistModelEvent('block', block, 'update', base);
      }
      renderBlockBar();
    });
    $('#newBlockBtn').addEventListener('click', () => onStartNewBlock());

    let routineRows = hydrated.meta.rutina;
    let catalogRows = hydrated.meta.catalogo;
    if (hydrated.meta.routine_release_id !== CONFIG_RELEASE_ID || hydrated.meta.routine_validation_ok !== true) {
      routineRows = [];
      catalogRows = [];
    }
    routineRows = routineRows || [];
    catalogRows = catalogRows || [];
    const canonical = applyCanonicalRoutineRelease(routineRows, catalogRows);
    state.days = buildRoutineFromRows(canonical.routine, canonical.catalog);
    if (state.days.length) {
      await setMeta(db, 'rutina', canonical.routine);
      await setMeta(db, 'catalogo', canonical.catalog);
    }

    const session = activeSession();
    computeSuggestedDay();
    state.selectedDayId = session ? session.day_id : state.suggestedDayId;
    const initialDay = state.days.findIndex((day) => day.dia === state.selectedDayId);
    state.currentDayIdx = initialDay >= 0 ? initialDay : 0;
    if (session && state.checkinsById[session.session_id]) {
      const prior = state.checkinsById[session.session_id];
      state.checkinForm = {
        energia: prior.energia ?? null, pump: prior.pump ?? null, tecnica: prior.tecnica ?? null,
        sueno: prior.sueno ?? '', comentario: prior.comentario || ''
      };
    }

    renderBlockBar();
    renderDayTabs();
    renderSessionPanel();
    renderExerciseList();
    renderLog();
    renderSyncIssues();
    renderCheckin();
    renderCorporal();
    renderDailyContext();
    renderExtraordinary();
    setStatusState(state.token && state.personId
      ? computeSyncStatus({ outboxCount: hydrated.outbox.length, hasError: false })
      : { state: 'pending', label: 'Captura offline · completa el emparejamiento para sincronizar' });

    if (getUrl() && state.token && state.personId) triggerSync();
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
