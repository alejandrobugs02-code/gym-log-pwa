// Núcleo de dominio: funciones puras, sin IndexedDB ni DOM. Todo lo que aquí
// se prueba con `node --test` es lo que decide qué peso sugerir, qué se
// considera progreso y cómo se lee el historial.

export const LB_TO_KG = 0.45359237;

/**
 * UUIDv4 RFC 4122. El contrato del log compartido exige este formato para
 * session.id, set.id y measurement.id, así que el fallback (navegador sin
 * `crypto.randomUUID`: contexto no seguro, WebView antiguo) también lo cumple.
 * Implementación única: `event-log.js` la reutiliza en vez de duplicarla.
 */
export function uuid4() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newId() {
  return uuid4();
}

export function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Fecha local YYYY-MM-DD (no UTC: entrenar 21:00 en Lima no debe contar como el día siguiente). */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function toKg(weight, unit) {
  const w = Number(weight) || 0;
  return unit === 'lb' ? round(w * LB_TO_KG, 3) : round(w, 3);
}

export function fromKg(kg, unit) {
  const v = Number(kg) || 0;
  return unit === 'lb' ? round(v / LB_TO_KG, 2) : round(v, 2);
}

/** Epley. Comparable entre series de distinto peso/reps del mismo ejercicio. */
export function epley1RM(weightKg, reps) {
  const w = Number(weightKg) || 0;
  const r = Number(reps) || 0;
  if (w <= 0 || r <= 0) return 0;
  return round(w * (1 + r / 30), 2);
}

/**
 * Normaliza una serie ANTES de guardarla. Nunca lanza ni rechaza: recorta a
 * rangos sanos y rellena lo que falte. Perder el registro de una serie real es
 * mucho peor que guardar un número atípico.
 */
export function normalizeSet(input = {}) {
  const unit = input.unit === 'lb' ? 'lb' : 'kg';
  const kind = ['peso', 'tiempo', 'peso_corporal'].includes(input.kind) ? input.kind : 'peso';

  const weight = clampNum(input.weight, 0, 1000, 0);
  const reps = Math.round(clampNum(input.reps, 0, 200, 0));
  const rir = input.rir === null || input.rir === undefined || input.rir === ''
    ? null
    : Math.round(clampNum(input.rir, 0, 10, 0));
  const duration = input.duration === null || input.duration === undefined || input.duration === ''
    ? null
    : clampNum(input.duration, 0, 100000, 0);

  const now = new Date();
  return {
    id: input.id || newId(),
    sessionId: input.sessionId || null,
    exerciseId: String(input.exerciseId || 'desconocido'),
    // Nombre denormalizado a propósito: si mañana el ejercicio sale de la
    // rutina, el historial sigue siendo legible sin depender del catálogo.
    exerciseName: input.exerciseName || String(input.exerciseId || 'desconocido'),
    setIndex: Math.max(1, Math.round(clampNum(input.setIndex, 1, 100, 1))),
    kind,
    weight,
    unit,
    weightKg: toKg(weight, unit),
    reps,
    rir,
    duration,
    durationUnit: input.durationUnit || null,
    isWarmup: Boolean(input.isWarmup),
    note: typeof input.note === 'string' ? input.note.slice(0, 500) : '',
    date: input.date || localDate(now),
    createdAt: input.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    e1rm: kind === 'peso' ? epley1RM(toKg(weight, unit), reps) : 0,
  };
}

function clampNum(v, min, max, fallback) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Crea una sesión con una COPIA del plan del día. Esta copia es lo que permite
 * cambiar la rutina más adelante sin invalidar ni reescribir entrenamientos ya
 * hechos: cada sesión conserva lo que estaba prescrito el día que se entrenó.
 */
export function newSession({ dayId, day, routineVersion, date, blockId }) {
  const now = new Date();
  return {
    id: newId(),
    date: date || localDate(now),
    dayId,
    dayLabel: day ? day.label : dayId,
    dayName: day ? day.name : '',
    routineVersion: routineVersion || 'desconocida',
    blockId: blockId || null,
    planSnapshot: day ? JSON.parse(JSON.stringify(day.plan)) : [],
    status: 'open',
    startedAt: now.toISOString(),
    endedAt: null,
    note: '',
  };
}

export function closeSession(session, status = 'completed') {
  return { ...session, status, endedAt: new Date().toISOString() };
}

/** Siguiente día de la secuencia. Calendario flexible: continúa donde quedó. */
export function nextDayId(sequence, lastDayId) {
  if (!sequence || !sequence.length) return null;
  if (!lastDayId) return sequence[0];
  const i = sequence.indexOf(lastDayId);
  if (i === -1) return sequence[0];
  return sequence[(i + 1) % sequence.length];
}

// --- Consultas de historial -------------------------------------------------

const byDateDesc = (a, b) => (a.date === b.date
  ? String(b.createdAt).localeCompare(String(a.createdAt))
  : String(b.date).localeCompare(String(a.date)));

/** Series del ejercicio en la última sesión en que se entrenó, en orden. */
export function lastSessionSets(sets, exerciseId) {
  const mine = sets.filter((s) => s.exerciseId === exerciseId && !s.isWarmup);
  if (!mine.length) return [];
  const sorted = [...mine].sort(byDateDesc);
  const lastSessionId = sorted[0].sessionId;
  const lastDate = sorted[0].date;
  return mine
    .filter((s) => (lastSessionId ? s.sessionId === lastSessionId : s.date === lastDate))
    .sort((a, b) => a.setIndex - b.setIndex);
}

/** La serie más reciente de un ejercicio: el número que quieres ver en el gym. */
export function lastSet(sets, exerciseId) {
  const last = lastSessionSets(sets, exerciseId);
  return last.length ? last[last.length - 1] : null;
}

/** Mejor serie histórica por e1RM (récord personal estimado). */
export function bestSet(sets, exerciseId) {
  const mine = sets.filter((s) => s.exerciseId === exerciseId && !s.isWarmup && s.kind === 'peso');
  if (!mine.length) return null;
  return mine.reduce((best, s) => ((s.e1rm || 0) > (best.e1rm || 0) ? s : best));
}

/**
 * Sugerencia de carga (doble progresión): sube el peso cuando llegas al tope
 * del rango con el RIR objetivo o menos; baja si te quedaste por debajo del
 * mínimo estando ya al fallo; si no, mismo peso buscando una repetición más.
 * Es una sugerencia editable, no una imposición.
 */
export function suggestNext(prescription, previousSets, exercise) {
  const step = (exercise && (prescription?.unitPref === 'lb' ? exercise.stepLb : exercise.stepKg)) || 2.5;
  const unit = (exercise && exercise.unit) || 'kg';

  if (!previousSets || !previousSets.length) {
    return { weight: null, reps: prescription?.repMin ?? null, unit, reason: 'primera-vez' };
  }

  const top = previousSets[previousSets.length - 1];
  const target = prescription?.rir ?? 1;
  const repMax = prescription?.repMax ?? top.reps;
  const repMin = prescription?.repMin ?? 1;
  const prevUnit = top.unit || unit;
  const prevStep = prevUnit === 'lb' ? (exercise?.stepLb || 5) : (exercise?.stepKg || 2.5);

  const allHitTop = previousSets.every((s) => s.reps >= repMax);
  const rirOk = top.rir === null || top.rir === undefined || top.rir <= target;

  if (allHitTop && rirOk) {
    return {
      weight: round(top.weight + prevStep, 2),
      reps: repMin,
      unit: prevUnit,
      reason: 'subir-peso',
    };
  }
  if (top.reps < repMin && (top.rir ?? 0) <= 0) {
    return {
      weight: Math.max(0, round(top.weight - prevStep, 2)),
      reps: repMin,
      unit: prevUnit,
      reason: 'bajar-peso',
    };
  }
  return {
    weight: top.weight,
    reps: Math.min(repMax, top.reps + 1),
    unit: prevUnit,
    reason: 'sumar-rep',
  };
}

/** Serie temporal por sesión para graficar progresión de un ejercicio. */
export function exerciseHistory(sets, exerciseId) {
  const mine = sets.filter((s) => s.exerciseId === exerciseId && !s.isWarmup);
  const bySession = new Map();
  for (const s of mine) {
    const key = s.sessionId || s.date;
    if (!bySession.has(key)) {
      bySession.set(key, { key, date: s.date, sets: [], volumeKg: 0, topE1rm: 0, topWeightKg: 0 });
    }
    const g = bySession.get(key);
    g.sets.push(s);
    g.volumeKg = round(g.volumeKg + s.weightKg * s.reps, 2);
    g.topE1rm = Math.max(g.topE1rm, s.e1rm || 0);
    g.topWeightKg = Math.max(g.topWeightKg, s.weightKg || 0);
  }
  return [...bySession.values()]
    .map((g) => ({ ...g, sets: g.sets.sort((a, b) => a.setIndex - b.setIndex) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Tendencia de un ejercicio comparando las primeras y últimas N sesiones por
 * e1RM. Responde "¿estoy progresando en esto?" sin necesidad de IA.
 */
export function trend(sets, exerciseId, window = 3) {
  const hist = exerciseHistory(sets, exerciseId).filter((h) => h.topE1rm > 0);
  if (hist.length < 2) return { status: 'sin-datos', deltaKg: 0, sessions: hist.length };
  const recent = hist.slice(-window);
  const prior = hist.slice(-(window * 2), -window);
  if (!prior.length) return { status: 'pocos-datos', deltaKg: 0, sessions: hist.length };
  const avg = (xs) => xs.reduce((a, h) => a + h.topE1rm, 0) / xs.length;
  const delta = round(avg(recent) - avg(prior), 2);
  let status = 'estancado';
  if (delta > 0.75) status = 'progresando';
  else if (delta < -0.75) status = 'retrocediendo';
  return { status, deltaKg: delta, sessions: hist.length };
}

/** Volumen (kg levantados) y series por grupo muscular en un rango de fechas. */
export function volumeByMuscle(sets, exerciseById, fromDate, toDate) {
  const out = {};
  for (const s of sets) {
    if (s.isWarmup || s.kind !== 'peso') continue;
    if (fromDate && s.date < fromDate) continue;
    if (toDate && s.date > toDate) continue;
    const muscle = exerciseById[s.exerciseId]?.muscle || 'otro';
    if (!out[muscle]) out[muscle] = { muscle, volumeKg: 0, sets: 0 };
    out[muscle].volumeKg = round(out[muscle].volumeKg + s.weightKg * s.reps, 2);
    out[muscle].sets += 1;
  }
  return Object.values(out).sort((a, b) => b.volumeKg - a.volumeKg);
}

export function sessionVolumeKg(sets) {
  return round(
    sets.filter((s) => !s.isWarmup && s.kind === 'peso')
      .reduce((a, s) => a + s.weightKg * s.reps, 0),
    2,
  );
}
