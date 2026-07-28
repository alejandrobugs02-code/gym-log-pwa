// Formateo para pantalla. Puro y probado: lo que se lee entre serie y serie
// tiene que ser inequívoco.

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Números sin ceros de relleno: 30 no "30.00", 32.5 sí. */
export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return String(Math.round(v * 100) / 100);
}

export function fmtWeight(weight, unit) {
  return `${fmtNum(weight)} ${unit || 'kg'}`;
}

/** "30 kg × 10 · RIR 1" — el resumen que se lee de un vistazo. */
export function fmtSet(set) {
  if (!set) return '—';
  if (set.kind === 'tiempo') {
    return `${fmtNum(set.duration ?? set.reps)} ${set.durationUnit || 'min'}`;
  }
  const base = set.kind === 'peso_corporal' && !set.weight
    ? `${set.reps} reps`
    : `${fmtWeight(set.weight, set.unit)} × ${set.reps}`;
  return set.rir === null || set.rir === undefined ? base : `${base} · RIR ${set.rir}`;
}

/**
 * Colapsa series consecutivas idénticas: tres series iguales se leen
 * "3× 32 kg × 8 · RIR 1" en vez de repetir la misma línea tres veces.
 */
export function summarizeSets(sets) {
  if (!sets || !sets.length) return '—';
  const runs = [];
  for (const s of sets) {
    const label = fmtSet(s);
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.n += 1;
    else runs.push({ label, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.n}× ${r.label}` : r.label)).join('  ·  ');
}

export function fmtDateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return `${d} ${MESES[m - 1]}`;
}

/** Distancia en días respecto a hoy, en lenguaje natural. */
export function relDay(iso, today) {
  if (!iso) return '';
  const t = today || new Date();
  const base = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y) return String(iso);
  const then = new Date(y, m - 1, d);
  const days = Math.round((base - then) / 86400000);
  if (days === 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 0) return fmtDateShort(iso);
  if (days < 7) return `hace ${days} días`;
  if (days < 14) return 'hace 1 semana';
  if (days < 60) return `hace ${Math.floor(days / 7)} semanas`;
  return fmtDateShort(iso);
}

/** Segundos → m:ss */
export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtElapsed(startIso, now) {
  if (!startIso) return '0:00';
  const ms = (now || Date.now()) - new Date(startIso).getTime();
  return fmtClock(ms / 1000);
}

export function prescriptionLine(item) {
  if (!item) return '';
  if (item.kind === 'tiempo') {
    const u = item.durationUnit || 'min';
    return `${item.sets}× ${item.repMin}${u}`;
  }
  const reps = item.repMin === item.repMax ? `${item.repMin}` : `${item.repMin}-${item.repMax}`;
  const rir = item.rir === null || item.rir === undefined ? '' : ` · RIR ${item.rir}`;
  return `${item.sets}×${reps}${rir}`;
}

/**
 * Construye un sparkline SVG. Devuelve las rutas ya calculadas para no meter
 * lógica de geometría en la plantilla.
 */
export function sparkline(values, width = 320, height = 120, pad = 18) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || Math.max(1, max * 0.1);
  const lo = min - span * 0.15;
  const hi = max + span * 0.15;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const x = (i) => (nums.length === 1 ? width / 2 : pad + (i / (nums.length - 1)) * innerW);
  const y = (v) => pad + innerH - ((v - lo) / (hi - lo)) * innerH;

  const points = nums.map((v, i) => ({ x: +x(i).toFixed(2), y: +y(v).toFixed(2), v }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const area = `${line} L${points[points.length - 1].x} ${height - pad} L${points[0].x} ${height - pad} Z`;
  return { points, line, area, min, max, width, height };
}

/** Escapa texto que se inserta en HTML (nombres de ejercicio, notas). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
