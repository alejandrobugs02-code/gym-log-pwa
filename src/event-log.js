// Contrato pequeño del log compartido. La PWA conserva una outbox offline;
// el adaptador Python la incorpora al log canónico sin servidor ni daemon.

import { addDays, uuid4 } from './model.js';

export const EVENT_CHANNEL = 'pwa';

function timestamp(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function event({ tipo, fecha, datos, op = 'crear', ref, id, now }) {
  const out = {
    id: id || uuid4(),
    ts: timestamp(now),
    fecha,
    tipo,
    op,
    canal: EVENT_CHANNEL,
    datos: { ...datos },
  };
  if (ref) out.ref = ref;
  return out;
}

export function sessionEvent(session, { op = 'crear', ref, now } = {}) {
  return event({
    id: op === 'crear' ? session.id : undefined,
    tipo: 'sesion',
    fecha: session.date,
    op,
    ref,
    now,
    datos: {
      session_id: session.id,
      day_id: session.dayId,
      started_at_utc: session.startedAt,
      ended_at_utc: session.endedAt,
      status: session.status,
      routineVersion: session.routineVersion,
      ...(session.blockId ? { block_id: session.blockId } : {}),
    },
  });
}

export function setEvent(row, { op = 'crear', ref, now } = {}) {
  const data = {
    set_id: row.id,
    session_id: row.sessionId,
    exercise_id: row.canonicalExerciseId || row.exerciseId,
    set_index: row.setIndex,
    set_kind: row.isWarmup ? 'warmup' : 'working',
    reps: row.reps,
    rir: row.rir,
    routineVersion: row.routineVersion,
  };
  if (row.kind === 'tiempo') {
    data.duration_value = row.duration ?? row.reps;
    data.duration_unit = row.durationUnit || 's';
  } else {
    data.weight_value = row.weight;
    data.weight_unit = row.unit;
  }
  if (row.note) data.notes = row.note;
  return event({
    id: op === 'crear' ? row.id : undefined,
    tipo: 'serie', fecha: row.date, datos: data, op, ref, now,
  });
}

export function measurementEvent(row, { op = 'crear', ref, now } = {}) {
  return event({
    id: op === 'crear' ? row.id : undefined,
    tipo: 'medida',
    fecha: row.date,
    op,
    ref,
    now,
    datos: {
      measurement_id: row.id,
      measurement_type: row.type,
      value: row.value,
      unit: row.unit,
      ...(row.note ? { note: row.note } : {}),
    },
  });
}

// Sueño y pasos no son `medida`: el contrato los proyecta en `recovery_daily`
// como `recuperacion` (sleep_hours, steps), igual que el adaptador de Apple Health.
// El promedio semanal es el respaldo cuando no se anotaron los días: viaja con
// su semana explícita y sin `steps`, para no hacerse pasar por un día medido.
function recoveryDatos(row) {
  if (row.type === 'steps') return { steps: Math.round(row.value) };
  if (row.type === 'steps_week') {
    return { steps_week_avg: Math.round(row.value), week_start: row.date, week_end: addDays(row.date, 6) };
  }
  return { sleep_hours: row.value };
}

export function recoveryEvent(row, { op = 'crear', ref, now } = {}) {
  return event({
    id: op === 'crear' ? row.id : undefined,
    tipo: 'recuperacion',
    fecha: row.date,
    op,
    ref,
    now,
    datos: recoveryDatos(row),
  });
}

export function annulEvent(source, now = new Date()) {
  return event({
    tipo: source.tipo,
    fecha: source.fecha,
    datos: {},
    op: 'anular',
    ref: source.ref,
    now,
  });
}

export function toNdjson(events) {
  return events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : '');
}
