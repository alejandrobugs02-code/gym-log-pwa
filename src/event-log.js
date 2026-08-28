// Contrato pequeño del log compartido. La PWA conserva una outbox offline;
// el adaptador Python la incorpora al log canónico sin servidor ni daemon.

export const EVENT_CHANNEL = 'pwa';

function uuid4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
