// Shell de la aplicación: enrutado por pestañas, render y eventos.
//
// El flujo que manda es el del gimnasio: abrir → ver el ejercicio → ver lo que
// hiciste la vez pasada → ajustar peso/reps → guardar → siguiente serie.
// Todo lo demás (historial, cuerpo, ajustes) vive fuera de ese camino.

import { createStore, APP_VERSION } from './store.js';
import { CATALOG, DAY_BY_ID, EXERCISE_BY_ID } from './catalog.js';
import * as M from './model.js';
import {
  fmtNum, fmtSet, fmtWeight, fmtDateShort, relDay, fmtClock, fmtElapsed,
  prescriptionLine, sparkline, esc, summarizeSets, fmtHours, fmtHoursCompact, hoursFromParts,
  fmtSteps, stepsFromInput,
} from './format.js';
import {
  flushOutbox, getSyncState, onSyncChange, testSyncConnection, syncBadgeText, SYNC_STATUS, initSyncFromStore,
} from './sync.js';
import {
  beep, cancelRestPush, enablePush, keepScreenOn, pushPermission, scheduleRestPush, unlockAudio,
} from './rest-alert.js';

const store = createStore();
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const restEl = document.getElementById('rest');
const restLabel = document.getElementById('restLabel');

const ui = {
  tab: 'hoy',
  openExercise: null,
  draft: null,          // { setId?, exerciseId, weight, reps, rir, unit }
  pickDay: null,        // día elegido en la pantalla de inicio
  historyExercise: null,
  openSession: null,
  restEndsAt: null,
  restTotal: 0,
};

// --- utilidades de UI -------------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 1900) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function buzz(ms = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* opcional */ } }
}

function updateSyncBadge(syncState = getSyncState()) {
  const badgeEl = document.getElementById('syncBadge');
  if (badgeEl) {
    badgeEl.textContent = syncBadgeText(syncState.status);
    badgeEl.dataset.status = syncState.status;
    const titles = {
      [SYNC_STATUS.SYNCED]: 'Sincronizado con la nube',
      [SYNC_STATUS.SYNCING]: 'Sincronizando eventos con la nube...',
      [SYNC_STATUS.PENDING]: `${store.state.eventOutbox?.length || 0} eventos pendientes de sincronizar`,
      [SYNC_STATUS.ERROR]: `Error de sincronización: ${syncState.lastError || 'Desconocido'}`,
    };
    badgeEl.title = titles[syncState.status] || 'Sincronización';
  }

  const modalBadge = document.getElementById('syncModalBadge');
  const modalStatus = document.getElementById('syncModalStatusText');
  const modalDetail = document.getElementById('syncModalDetail');
  if (modalBadge) {
    modalBadge.textContent = syncBadgeText(syncState.status);
    modalBadge.dataset.status = syncState.status;
  }
  if (modalStatus) {
    const labels = {
      [SYNC_STATUS.SYNCED]: 'Sincronizado',
      [SYNC_STATUS.SYNCING]: 'Sincronizando...',
      [SYNC_STATUS.PENDING]: 'Pendiente de envío',
      [SYNC_STATUS.ERROR]: 'Error de sincronización',
    };
    modalStatus.textContent = labels[syncState.status] || 'Sincronización';
  }
  if (modalDetail) {
    if (syncState.status === SYNC_STATUS.ERROR && syncState.lastError) {
      modalDetail.textContent = syncState.lastError;
    } else {
      const n = store.state.eventOutbox?.length || 0;
      modalDetail.textContent = `${n} evento${n === 1 ? '' : 's'} en cola local`;
    }
  }
}

onSyncChange((state) => {
  updateSyncBadge(state);
  if (ui.tab === 'ajustes') render();
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    flushOutbox(store).catch(() => {});
  }
});

window.addEventListener('online', () => {
  flushOutbox(store).catch(() => {});
});

window.addEventListener('pagehide', () => {
  flushOutbox(store, { keepalive: true }).catch(() => {});
});

/** Series del ejercicio en la última sesión ANTERIOR a la actual. */
function previousSets(exerciseId, currentSessionId) {
  const past = store.state.sets.filter((s) => s.sessionId !== currentSessionId);
  return M.lastSessionSets(past, exerciseId);
}

function planItem(session, exerciseId) {
  return (session.planSnapshot || []).find((p) => p.exerciseId === exerciseId) || null;
}

// --- pestaña HOY ------------------------------------------------------------

function renderHoy() {
  const session = store.activeSession();
  return session ? renderSession(session) : renderIdle();
}

function renderIdle() {
  const dayId = ui.pickDay || store.suggestedDayId();
  const day = DAY_BY_ID[dayId];
  const recent = [...store.state.sessions]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 4);

  const chips = CATALOG.days.map((d) => `
    <button class="chip ${d.id === dayId ? 'active' : ''}" data-action="pick-day" data-day="${d.id}" type="button">
      ${esc(d.label)}
    </button>`).join('');

  const plan = day.plan.map((p) => {
    const ex = EXERCISE_BY_ID[p.exerciseId];
    const last = M.lastSet(store.state.sets, p.exerciseId);
    return `<div class="row small" style="padding:5px 0">
      <span>${esc(ex ? ex.name : p.exerciseId)}</span>
      <span class="right muted nums">${last ? esc(fmtSet(last)) : `${prescriptionLine(p)}`}</span>
    </div>`;
  }).join('');

  return `
    <h1>Hoy</h1>
    <p class="sub">${recent.length ? `Última sesión ${relDay(recent[0].date)} · ${esc(recent[0].dayLabel)}` : 'Sin sesiones todavía. Empieza cuando quieras.'}</p>

    <div class="card">
      <div class="ex-name">${esc(day.label)} · ${esc(day.name)}</div>
      <div class="ex-presc">${day.plan.length} ejercicios · rutina ${esc(CATALOG.routineVersion)}</div>
      <div style="height:12px"></div>
      <button class="btn-primary btn-big" data-action="start-session" data-day="${dayId}" type="button">
        ▶ Empezar ${esc(day.label)}
      </button>
    </div>

    <h2>Otro día</h2>
    <div class="chips">${chips}</div>

    <h2>Qué toca</h2>
    <div class="card">${plan}</div>

    ${recent.length ? `<h2>Sesiones recientes</h2>${recent.map(sessionCard).join('')}` : ''}
  `;
}

function sessionCard(s) {
  const sets = store.setsOfSession(s.id);
  const vol = M.sessionVolumeKg(sets);
  return `
    <div class="card tappable" data-action="view-session" data-id="${s.id}">
      <div class="row">
        <div class="ex-title">
          <div class="ex-name">${esc(s.dayLabel)} · ${esc(s.dayName)}</div>
          <div class="ex-presc">${relDay(s.date)} · ${sets.length} series${vol ? ` · ${fmtNum(vol)} kg` : ''}</div>
        </div>
        ${s.status === 'open' ? '<span class="badge flat">abierta</span>' : ''}
      </div>
    </div>`;
}

function renderSession(session) {
  const done = store.setsOfSession(session.id);
  const vol = M.sessionVolumeKg(done);

  const bar = `
    <div class="session-bar">
      <div class="grow">
        <div class="t">${esc(session.dayLabel)} · ${esc(session.dayName)}</div>
        <div class="m" id="elapsed">${fmtElapsed(session.startedAt)} · ${done.length} series${vol ? ` · ${fmtNum(vol)} kg` : ''}</div>
      </div>
      <button data-action="finish-session" type="button">Terminar</button>
    </div>`;

  const cards = (session.planSnapshot || []).map((p) => exerciseCard(session, p)).join('');

  return bar + cards + `
    <div class="sep"></div>
    <button class="btn-ghost" data-action="finish-session" type="button" style="width:100%">Terminar sesión</button>
    ${done.length === 0 ? '<button class="btn-danger" data-action="discard-session" type="button" style="width:100%;margin-top:8px">Descartar sesión vacía</button>' : ''}
  `;
}

function exerciseCard(session, p) {
  const ex = EXERCISE_BY_ID[p.exerciseId] || { id: p.exerciseId, name: p.exerciseId, unit: 'kg', stepKg: 2.5, stepLb: 5 };
  const mine = store.setsOfExerciseInSession(session.id, p.exerciseId);
  const isOpen = ui.openExercise === p.exerciseId;
  const complete = mine.length >= p.sets;

  const dots = Array.from({ length: p.sets }, (_, i) => `<span class="dot ${i < mine.length ? 'on' : ''}"></span>`).join('');
  const prev = previousSets(p.exerciseId, session.id);
  const lastLine = prev.length
    ? `<div class="ex-last"><span class="tag">Última vez · ${relDay(prev[0].date)}</span>${esc(summarizeSets(prev))}</div>`
    : '<div class="ex-last muted"><span class="tag">Última vez</span>Sin registro previo</div>';

  return `
    <section class="card ${complete ? 'done' : ''} ${isOpen ? 'open' : ''}" data-card="${p.exerciseId}">
      <div class="ex-head tappable" data-action="open-ex" data-ex="${p.exerciseId}">
        <div class="ex-title">
          <div class="ex-name">${esc(ex.name)}</div>
          <div class="ex-presc">${prescriptionLine(p)}${p.restSec ? ` · ${p.restSec}s` : ''}</div>
        </div>
        <div class="dots">${dots}</div>
      </div>
      ${isOpen ? lastLine + logger(session, p, ex, mine) : (mine.length ? setList(mine) : lastLine)}
    </section>`;
}

function logger(session, p, ex, mine) {
  // El borrador vive en `ui` para que guardar, los steppers y los chips lean
  // siempre el mismo estado que se está mostrando.
  if (!ui.draft || ui.draft.exerciseId !== p.exerciseId) {
    ui.draft = buildDraft(session, p, ex, mine);
  }
  const d = ui.draft;
  const nextIndex = d.setId ? d.setIndex : mine.length + 1;
  const isTime = p.kind === 'tiempo';
  const isBw = p.kind === 'peso_corporal';
  const step = d.unit === 'lb' ? (ex.stepLb || 5) : (ex.stepKg || 2.5);

  const weightField = isTime ? '' : `
    <div>
      <label>Peso (${d.unit})${isBw ? ' · lastre opcional' : ''}</label>
      <div class="stepper">
        <button data-action="step" data-field="weight" data-delta="${-step}" type="button" aria-label="Bajar peso">−</button>
        <input id="f-weight" inputmode="decimal" enterkeyhint="done" value="${d.weight ?? ''}" placeholder="—">
        <button data-action="step" data-field="weight" data-delta="${step}" type="button" aria-label="Subir peso">+</button>
      </div>
    </div>`;

  const repsField = `
    <div>
      <label>${isTime ? `Duración (${p.durationUnit || 'min'})` : 'Reps'}</label>
      <div class="stepper">
        <button data-action="step" data-field="reps" data-delta="-1" type="button" aria-label="Bajar reps">−</button>
        <input id="f-reps" inputmode="numeric" enterkeyhint="done" value="${d.reps ?? ''}" placeholder="—">
        <button data-action="step" data-field="reps" data-delta="1" type="button" aria-label="Subir reps">+</button>
      </div>
    </div>`;

  const rirChips = isTime ? '' : `
    <label style="margin-top:12px">RIR (reps en reserva) · objetivo ${p.rir ?? '—'}</label>
    <div class="chips">
      ${[0, 1, 2, 3, 4].map((r) => `<button class="chip ${d.rir === r ? 'active' : ''}" data-action="set-rir" data-rir="${r}" type="button">${r}</button>`).join('')}
      <button class="chip ${d.rir === null ? 'active' : ''}" data-action="set-rir" data-rir="" type="button">—</button>
    </div>`;

  const unitToggle = isTime ? '' : `
    <button class="chip" data-action="toggle-unit" type="button">Cambiar a ${d.unit === 'kg' ? 'lb' : 'kg'}</button>`;

  const sameAsLast = !d.setId && previousSets(p.exerciseId, session.id).length
    ? '<button class="chip" data-action="same-as-last" type="button">= que la vez pasada</button>' : '';

  return `
    <div class="logger">
      <div class="field-pair">${weightField}${repsField}</div>
      ${rirChips}
      <div class="chips" style="margin-top:12px">${unitToggle}${sameAsLast}</div>
      <div style="height:12px"></div>
      <button class="btn-primary btn-big" data-action="save-set" data-ex="${p.exerciseId}" type="button">
        ${d.setId ? '✓ Actualizar serie' : `✓ Guardar serie ${nextIndex}`}
      </button>
      ${d.setId ? '<button class="btn-ghost" data-action="cancel-edit" type="button" style="width:100%;margin-top:8px">Cancelar edición</button>' : ''}
      ${mine.length ? setList(mine) : ''}
    </div>`;
}

/** Valores iniciales del formulario: repetir lo de esta sesión o sugerir progresión. */
function buildDraft(session, p, ex, mine) {
  if (mine.length) {
    const last = mine[mine.length - 1];
    return {
      exerciseId: p.exerciseId, setId: null, setIndex: mine.length + 1,
      weight: last.weight, reps: last.reps, rir: last.rir, unit: last.unit,
    };
  }
  const prev = previousSets(p.exerciseId, session.id);
  const sug = M.suggestNext(p, prev, ex);
  return {
    exerciseId: p.exerciseId, setId: null, setIndex: 1,
    weight: sug.weight, reps: sug.reps ?? p.repMin, rir: p.rir ?? null,
    unit: sug.unit || ex.unit || 'kg',
  };
}

/** Series del mismo ejercicio guardadas antes que `set` (de esta sesión o anteriores). */
function setsBefore(set) {
  return store.state.sets.filter((s) => s.exerciseId === set.exerciseId
    && s.id !== set.id && String(s.createdAt) < String(set.createdAt));
}

function recordText(r) {
  if (r.type === 'peso') return `peso ${fmtNum(r.value)} kg (antes ${fmtNum(r.before)})`;
  if (r.type === '1rm') return `1RM est. ${fmtNum(r.value)} kg (antes ${fmtNum(r.before)})`;
  return `${r.value} reps con ese peso (antes ${r.before})`;
}

function setList(sets) {
  const best = sets.length ? sets.reduce((a, b) => ((b.e1rm || 0) > (a.e1rm || 0) ? b : a)) : null;
  return `<div class="setlist">${sets.map((s) => {
    const isRecord = M.personalRecords(setsBefore(s), s).length > 0;
    const mark = isRecord
      ? '<span class="pr record">récord</span>'
      : (best && s.id === best.id && sets.length > 1 ? '<span class="pr">top</span>' : '');
    return `
    <div class="setrow">
      <span class="idx">${s.setIndex}</span>
      <span class="val">${esc(fmtSet(s))}</span>
      ${mark}
      <button data-action="edit-set" data-id="${s.id}" type="button" aria-label="Editar serie">Editar</button>
      <button data-action="del-set" data-id="${s.id}" type="button" aria-label="Borrar serie">✕</button>
    </div>`;
  }).join('')}</div>`;
}

// --- pestaña HISTORIAL ------------------------------------------------------

function renderHistorial() {
  if (ui.openSession) return renderSessionDetail(ui.openSession);

  const trained = [...new Set(store.state.sets.map((s) => s.exerciseId))];
  if (!store.state.sessions.length) {
    return '<h1>Historial</h1><div class="empty">Cuando registres tu primera sesión, aquí verás la progresión por ejercicio.</div>';
  }

  const exId = ui.historyExercise && trained.includes(ui.historyExercise) ? ui.historyExercise : trained[0];
  const options = trained
    .map((id) => `<option value="${id}" ${id === exId ? 'selected' : ''}>${esc(EXERCISE_BY_ID[id]?.name || id)}</option>`)
    .join('');

  const sessions = [...store.state.sessions]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return `
    <h1>Historial</h1>
    <p class="sub">${sessions.length} sesiones · ${store.state.sets.length} series registradas</p>
    ${muscleVolumeCard()}
    <h2>Progresión por ejercicio</h2>
    <select id="exPicker" data-action="pick-history-ex">${options}</select>
    ${exerciseProgressCard(exId)}
    <h2>Sesiones</h2>
    ${sessions.map(sessionCard).join('')}
  `;
}

const MUSCLE_LABEL = {
  pecho: 'Pecho', espalda: 'Espalda', hombro: 'Hombro', brazo: 'Brazo', pierna: 'Pierna', core: 'Core', otro: 'Otro',
};

// Series hechas por grupo esta semana (lunes a domingo) frente a las que la
// rutina prescribe en sus 6 días. La meta sale del plan, no de una tabla aparte.
function muscleVolumeCard() {
  const today = M.localDate();
  const start = M.weekStart(today);
  const planned = M.plannedSetsByMuscle(CATALOG.days, EXERCISE_BY_ID);
  const done = M.setsByMuscle(store.state.sets, EXERCISE_BY_ID, start, M.addDays(start, 6));
  const lastWeek = M.setsByMuscle(store.state.sets, EXERCISE_BY_ID, M.addDays(start, -7), M.addDays(start, -1));
  const muscles = [...new Set([...Object.keys(planned), ...Object.keys(done)])]
    .sort((a, b) => (planned[b] || 0) - (planned[a] || 0));
  const daysGone = Math.round((new Date(`${today}T12:00`) - new Date(`${start}T12:00`)) / 86400000) + 1;

  const rows = muscles.map((m) => {
    const goal = planned[m] || 0;
    const n = done[m] || 0;
    const pct = goal ? Math.min(100, Math.round((n / goal) * 100)) : 100;
    const tone = !goal ? 'none' : n >= goal ? 'up' : n >= goal * (daysGone / 7) ? 'flat' : 'down';
    return `
      <div class="muscle-row">
        <div class="row small">
          <span>${esc(MUSCLE_LABEL[m] || m)}</span>
          <span class="right nums"><span class="badge ${tone}">${n}/${goal || '—'}</span></span>
        </div>
        <div class="bar"><div class="bar-fill ${tone}" style="width:${pct}%"></div></div>
        <div class="muted small">semana pasada: ${lastWeek[m] || 0}</div>
      </div>`;
  }).join('');

  return `
    <h2>Series por músculo · esta semana</h2>
    <div class="card">
      ${rows}
      <p class="muted small" style="margin-top:10px">Meta: lo que prescribe la rutina ${esc(CATALOG.routineVersion)} en la semana. Ámbar = vas al ritmo de los días que van (${daysGone} de 7); rojo = atrasado.</p>
    </div>`;
}

function exerciseProgressCard(exerciseId) {
  const hist = M.exerciseHistory(store.state.sets, exerciseId);
  if (!hist.length) return '<div class="card muted">Sin series registradas.</div>';

  const t = M.trend(store.state.sets, exerciseId);
  const best = M.bestSet(store.state.sets, exerciseId);
  const last = M.lastSet(store.state.sets, exerciseId);
  const badge = {
    progresando: '<span class="badge up">progresando</span>',
    estancado: '<span class="badge flat">estancado</span>',
    retrocediendo: '<span class="badge down">retrocediendo</span>',
    'pocos-datos': '<span class="badge none">pocos datos</span>',
    'sin-datos': '<span class="badge none">sin datos</span>',
  }[t.status] || '<span class="badge none">sin datos</span>';

  const values = hist.map((h) => h.topE1rm).filter((v) => v > 0);
  const chart = values.length > 1 ? renderChart(sparkline(values)) : '<p class="muted small">Necesitas 2+ sesiones para ver la curva.</p>';

  const rows = [...hist].reverse().slice(0, 8).map((h) => `
    <div class="row small" style="padding:6px 0;border-top:1px solid var(--line)">
      <span class="muted">${fmtDateShort(h.date)}</span>
      <span class="right nums">${esc(summarizeSets(h.sets))}</span>
    </div>`).join('');

  return `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <span class="ex-name">${esc(EXERCISE_BY_ID[exerciseId]?.name || exerciseId)}</span>
        <span class="right">${badge}</span>
      </div>
      <div class="stats">
        <div class="stat"><div class="n">${last ? fmtNum(last.weight) : '—'}</div><div class="l">último ${last ? last.unit : ''}</div></div>
        <div class="stat"><div class="n">${best ? fmtNum(best.e1rm) : '—'}</div><div class="l">1RM est. kg</div></div>
        <div class="stat"><div class="n">${hist.length}</div><div class="l">sesiones</div></div>
      </div>
      <div style="height:12px"></div>
      ${chart}
      <p class="muted small" style="margin-top:6px">1RM estimado (Epley) por sesión${t.deltaKg ? ` · ${t.deltaKg > 0 ? '+' : ''}${fmtNum(t.deltaKg)} kg vs. periodo anterior` : ''}</p>
      ${rows}
    </div>`;
}

function renderChart(sp, unit = 'kg') {
  if (!sp) return '';
  const pts = sp.points.map((p) => `<circle class="pt" cx="${p.x}" cy="${p.y}" r="3"></circle>`).join('');
  return `
    <svg class="chart" viewBox="0 0 ${sp.width} ${sp.height}" preserveAspectRatio="none" role="img" aria-label="Progresión estimada">
      <line class="grid" x1="18" y1="${sp.height - 18}" x2="${sp.width - 18}" y2="${sp.height - 18}"></line>
      <path class="area" d="${sp.area}"></path>
      <path class="line" d="${sp.line}"></path>
      ${pts}
      <text class="lbl" x="20" y="14">${fmtNum(sp.max)} ${unit}</text>
      <text class="lbl" x="20" y="${sp.height - 4}">${fmtNum(sp.min)} ${unit}</text>
    </svg>`;
}

function renderSessionDetail(id) {
  const s = store.state.sessions.find((x) => x.id === id);
  if (!s) { ui.openSession = null; return renderHistorial(); }
  const sets = store.setsOfSession(id);
  const byEx = new Map();
  for (const set of sets) {
    if (!byEx.has(set.exerciseId)) byEx.set(set.exerciseId, []);
    byEx.get(set.exerciseId).push(set);
  }
  const blocks = [...byEx.entries()].map(([exId, list]) => `
    <div class="card">
      <div class="ex-name">${esc(EXERCISE_BY_ID[exId]?.name || list[0].exerciseName || exId)}</div>
      ${setList(list)}
    </div>`).join('');

  return `
    <button class="btn-ghost" data-action="close-session-detail" type="button" style="margin-bottom:12px">‹ Historial</button>
    <h1>${esc(s.dayLabel)} · ${esc(s.dayName)}</h1>
    <p class="sub">${fmtDateShort(s.date)} · ${relDay(s.date)} · ${sets.length} series · ${fmtNum(M.sessionVolumeKg(sets))} kg de volumen</p>
    ${blocks || '<div class="empty">Sesión sin series.</div>'}
    ${s.status !== 'open' ? `<button class="btn-ghost" data-action="reopen-session" data-id="${s.id}" type="button" style="width:100%">Reabrir para agregar series</button>` : ''}
  `;
}

// --- pestaña CUERPO ---------------------------------------------------------

// Objetivo de sueño del sistema físico (Brain/65_Gym/mapa-fisico.md, recovery.sleep_hours).
const SLEEP_GOAL = { min: 7, targetMin: 7.5, targetMax: 8 };
// Pasos diarios de mapa-fisico (recovery.steps.week_3_onward).
const STEPS_GOAL = 8000;

function renderCuerpo() {
  const peso = store.measurementsOfType('weight');
  const cintura = store.measurementsOfType('waist');
  const sueno = store.measurementsOfType('sleep');
  const today = M.localDate();
  const pesoHoy = peso.find((m) => m.date === today);
  const cinturaHoy = cintura.find((m) => m.date === today);
  const suenoHoy = sueno.find((m) => m.date === today);
  const suenoH = suenoHoy ? Math.floor(suenoHoy.value) : '';
  const suenoMin = suenoHoy ? Math.round((suenoHoy.value - Math.floor(suenoHoy.value)) * 60) : '';
  const pasos = store.measurementsOfType('steps');
  const pasosHoy = pasos.find((m) => m.date === today);

  return `
    <h1>Cuerpo</h1>
    <p class="sub">Un registro por día. Si lo vuelves a guardar hoy, se corrige el de hoy.</p>

    <div class="card">
      <div class="field-pair">
        <div>
          <label for="m-peso">Peso corporal (kg)</label>
          <input id="m-peso" inputmode="decimal" enterkeyhint="done" value="${pesoHoy ? pesoHoy.value : ''}" placeholder="${peso.length ? fmtNum(peso[peso.length - 1].value) : '—'}">
        </div>
        <div>
          <label for="m-cintura">Cintura (cm)</label>
          <input id="m-cintura" inputmode="decimal" enterkeyhint="done" value="${cinturaHoy ? cinturaHoy.value : ''}" placeholder="${cintura.length ? fmtNum(cintura[cintura.length - 1].value) : '—'}">
        </div>
      </div>
      <label for="m-sueno-h">Sueño de anoche · Apple Watch</label>
      <div class="field-pair">
        <div class="unit-input">
          <input id="m-sueno-h" inputmode="numeric" enterkeyhint="next" value="${suenoH}" placeholder="7" aria-label="Horas dormidas">
          <span>h</span>
        </div>
        <div class="unit-input">
          <input id="m-sueno-min" inputmode="numeric" enterkeyhint="done" value="${suenoMin}" placeholder="30" aria-label="Minutos dormidos">
          <span>min</span>
        </div>
      </div>
      <label for="m-pasos">Pasos · Apple Watch</label>
      <div class="field-pair">
        <div class="unit-input">
          <input id="m-pasos" inputmode="numeric" enterkeyhint="done" value="${pasosHoy ? pasosHoy.value : ''}" placeholder="${pasos.length ? fmtSteps(pasos[pasos.length - 1].value) : '8.000'}" aria-label="Pasos del día">
          <span>pasos</span>
        </div>
        <select id="m-pasos-dia" aria-label="Día de los pasos">
          <option value="${today}">de hoy</option>
          <option value="${M.addDays(today, -1)}">de ayer</option>
        </select>
      </div>
      <button class="btn-primary" data-action="save-measures" type="button">Guardar registro de hoy</button>
    </div>

    ${sleepCard(sueno)}
    ${stepsCard(pasos, store.measurementsOfType('steps_week'))}
    ${measureCard('Peso corporal', peso, 'kg')}
    ${measureCard('Cintura', cintura, 'cm')}
  `;
}

function measureCard(title, rows, unit) {
  if (!rows.length) return `<h2>${title}</h2><div class="card muted">Sin registros todavía.</div>`;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = M.round(last.value - first.value, 2);
  const chart = rows.length > 1 ? renderChart(sparkline(rows.map((r) => r.value)), unit) : '';
  const recent = [...rows].reverse().slice(0, 6).map((r) => measureRow(r, `${fmtNum(r.value)} ${unit}`)).join('');

  return `
    <h2>${title}</h2>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="n">${fmtNum(last.value)}</div><div class="l">actual ${unit}</div></div>
        <div class="stat"><div class="n">${delta > 0 ? '+' : ''}${fmtNum(delta)}</div><div class="l">cambio total</div></div>
        <div class="stat"><div class="n">${rows.length}</div><div class="l">registros</div></div>
      </div>
      <div style="height:12px"></div>
      ${chart}
      ${recent}
    </div>`;
}

function measureRow(r, text) {
  return `
    <div class="row small" style="padding:6px 0;border-top:1px solid var(--line)">
      <span class="muted">${fmtDateShort(r.date)}</span>
      <span class="right nums">${text}</span>
      <button data-action="del-measure" data-id="${r.id}" type="button" aria-label="Borrar" style="min-height:30px;min-width:30px;padding:0 8px;background:transparent">✕</button>
    </div>`;
}

function sleepCard(rows) {
  if (!rows.length) {
    return `<h2>Sueño</h2><div class="card muted">Sin registros todavía. Meta: ${fmtNum(SLEEP_GOAL.targetMin)}-${SLEEP_GOAL.targetMax} h, nunca menos de ${SLEEP_GOAL.min} h.</div>`;
  }
  const last = rows[rows.length - 1];
  // Promedio de los últimos 7 días calendario, no de los últimos 7 registros.
  const since = M.localDate(new Date(Date.now() - 6 * 86400000));
  const week = rows.filter((r) => r.date >= since);
  const avg = week.length ? week.reduce((acc, r) => acc + r.value, 0) / week.length : null;
  const nightsOk = week.filter((r) => r.value >= SLEEP_GOAL.min).length;
  const tone = (v) => (v >= SLEEP_GOAL.targetMin ? 'up' : v >= SLEEP_GOAL.min ? 'flat' : 'down');
  const chart = rows.length > 1
    ? renderChart(sparkline(rows.slice(-30).map((r) => r.value)), 'h')
    : '';
  const recent = [...rows].reverse().slice(0, 7).map((r) => measureRow(
    r, `<span class="badge ${tone(r.value)}">${fmtHours(r.value)}</span>`,
  )).join('');

  return `
    <h2>Sueño</h2>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="n">${fmtHoursCompact(last.value)}</div><div class="l">última noche</div></div>
        <div class="stat"><div class="n">${avg === null ? '—' : fmtHoursCompact(avg)}</div><div class="l">promedio 7 días</div></div>
        <div class="stat"><div class="n">${nightsOk}/${week.length}</div><div class="l">noches ≥ ${SLEEP_GOAL.min} h</div></div>
      </div>
      <p class="muted small" style="margin-top:10px">Meta ${fmtNum(SLEEP_GOAL.targetMin)}-${SLEEP_GOAL.targetMax} h · mínimo ${SLEEP_GOAL.min} h${week.length < 5 ? ` · el promedio pide 5 noches de la semana (llevas ${week.length})` : ''}.</p>
      ${chart}
      ${recent}
    </div>`;
}

// Promedio de pasos por semana (lunes a domingo). Si se anotó el promedio
// semanal que da la app Salud, ese manda: es la semana completa, mientras que
// los días sueltos pueden ser solo los que te acordaste de apuntar.
function stepsWeek(start, daily, weekly) {
  const end = M.addDays(start, 6);
  const declared = weekly.find((w) => w.date === start);
  const days = daily.filter((r) => r.date >= start && r.date <= end);
  if (declared) return { start, avg: declared.value, declared, days: days.length };
  if (!days.length) return { start, avg: null, days: 0 };
  return { start, avg: days.reduce((acc, r) => acc + r.value, 0) / days.length, days: days.length };
}

function stepsCard(daily, weekly) {
  const today = M.localDate();
  const thisWeek = M.weekStart(today);
  const weeks = [0, 1, 2, 3].map((i) => stepsWeek(M.addDays(thisWeek, -7 * i), daily, weekly));
  const last = daily[daily.length - 1];
  const since = M.addDays(today, -6);
  const week = daily.filter((r) => r.date >= since);
  const daysOk = week.filter((r) => r.value >= STEPS_GOAL).length;
  const tone = (v) => (v >= STEPS_GOAL ? 'up' : v >= STEPS_GOAL - 1500 ? 'flat' : 'down');
  const chart = daily.length > 1 ? renderChart(sparkline(daily.slice(-30).map((r) => r.value)), 'pasos') : '';
  const recent = [...daily].reverse().slice(0, 7).map((r) => measureRow(
    r, `<span class="badge ${tone(r.value)}">${fmtSteps(r.value)}</span>`,
  )).join('');
  const weekLabel = (w, i) => (i === 0 ? 'Esta semana' : i === 1 ? 'Semana pasada' : `Semana del ${fmtDateShort(w.start)}`);
  const weekRows = weeks.filter((w) => w.avg !== null).map((w) => {
    const i = weeks.indexOf(w);
    const source = w.declared ? 'promedio anotado' : `${w.days} ${w.days === 1 ? 'día' : 'días'}`;
    const del = w.declared
      ? `<button data-action="del-measure" data-id="${w.declared.id}" type="button" aria-label="Borrar promedio" style="min-height:30px;min-width:30px;padding:0 8px;background:transparent">✕</button>`
      : '<span style="min-width:30px"></span>';
    return `
      <div class="row small" style="padding:6px 0;border-top:1px solid var(--line)">
        <span class="muted">${weekLabel(w, i)} · ${source}</span>
        <span class="right nums"><span class="badge ${tone(w.avg)}">${fmtSteps(w.avg)}/día</span></span>
        ${del}
      </div>`;
  }).join('');

  const fallback = `
    <details style="margin-top:12px">
      <summary class="small">¿Se te pasó anotar? Pon el promedio semanal</summary>
      <p class="muted small" style="margin:8px 0">En el iPhone: Salud → Pasos → S (semana) muestra el promedio diario. Si anotas el promedio, manda sobre los días sueltos de esa semana.</p>
      <div class="field-pair">
        <select id="m-pasos-semana" aria-label="Semana del promedio">
          ${weeks.slice(0, 3).map((w, i) => `<option value="${w.start}">${weekLabel(w, i)}</option>`).join('')}
        </select>
        <div class="unit-input">
          <input id="m-pasos-prom" inputmode="numeric" enterkeyhint="done" placeholder="7.500" aria-label="Promedio diario de la semana">
          <span>/día</span>
        </div>
      </div>
      <button data-action="save-steps-week" type="button" style="width:100%">Guardar promedio semanal</button>
    </details>`;

  if (!daily.length && !weekly.length) {
    return `<h2>Pasos</h2><div class="card"><p class="muted">Sin registros todavía. Meta: ${fmtSteps(STEPS_GOAL)} pasos al día.</p>${fallback}</div>`;
  }
  return `
    <h2>Pasos</h2>
    <div class="card">
      <div class="stats">
        <div class="stat"><div class="n">${last ? fmtSteps(last.value) : '—'}</div><div class="l">último día</div></div>
        <div class="stat"><div class="n">${weeks[0].avg === null ? '—' : fmtSteps(weeks[0].avg)}</div><div class="l">promedio semana</div></div>
        <div class="stat"><div class="n">${daysOk}/${week.length}</div><div class="l">días ≥ ${fmtSteps(STEPS_GOAL)}</div></div>
      </div>
      <p class="muted small" style="margin-top:10px">Meta ${fmtSteps(STEPS_GOAL)} pasos al día · ajusta ±1.500 antes de tocar calorías.</p>
      ${chart}
      ${recent}
      ${weekRows ? `<h3 class="small muted" style="margin:14px 0 4px">Promedio por semana</h3>${weekRows}` : ''}
      ${fallback}
    </div>`;
}

// --- pestaña AJUSTES --------------------------------------------------------

function renderAjustes() {
  const s = store.state;
  const b = store.backupStatus();
  const syncState = getSyncState();
  const outboxCount = s.eventOutbox?.length || 0;

  const syncStateText = {
    [SYNC_STATUS.SYNCED]: 'Todo sincronizado',
    [SYNC_STATUS.SYNCING]: 'Sincronizando con la nube...',
    [SYNC_STATUS.PENDING]: `${outboxCount} evento${outboxCount === 1 ? '' : 's'} pendiente${outboxCount === 1 ? '' : 's'}`,
    [SYNC_STATUS.ERROR]: 'Error en la sincronización',
  }[syncState.status] || 'Sincronización lista';

  const syncDetail = syncState.status === SYNC_STATUS.ERROR && syncState.lastError
    ? syncState.lastError
    : (s.syncEndpoint ? `Conectado a ${esc(s.syncEndpoint.replace(/^https?:\/\//, ''))}` : 'Sin configurar aún');

  return `
    <h1>Ajustes</h1>
    <p class="sub">Gym ${APP_VERSION} · rutina ${esc(CATALOG.routineVersion)}</p>

    <div class="stats">
      <div class="stat"><div class="n">${s.sessions.length}</div><div class="l">sesiones</div></div>
      <div class="stat"><div class="n">${s.sets.length}</div><div class="l">series</div></div>
      <div class="stat"><div class="n">${s.measurements.length}</div><div class="l">medidas</div></div>
    </div>

    <h2>Sincronización en segundo plano</h2>
    <div class="card">
      <div class="row">
        <span style="font-size:1.6rem">${syncBadgeText(syncState.status)}</span>
        <div class="ex-title">
          <div class="ex-name">${syncStateText}</div>
          <div class="ex-presc">${syncDetail}</div>
        </div>
      </div>
      <div style="height:12px"></div>
      <div class="row" style="gap:8px">
        <button class="btn-primary" data-action="open-sync-modal" type="button" style="flex:1">Configurar</button>
        <button data-action="manual-sync" type="button" style="flex:1">Sincronizar</button>
      </div>
    </div>

    <h2>Aviso de descanso en el reloj</h2>
    <div class="card">
      ${restAlertCard()}
    </div>

    <h2>Respaldo de emergencia (Manual)</h2>
    <div class="card">
      <div class="ex-name">${b.never ? 'Sin exportaciones manuales recientes' : `Último respaldo manual: ${relDay(b.lastExportAt.slice(0, 10))}`}</div>
      <div class="ex-presc">Exporta una copia JSON de emergencia o importa un respaldo previo en este dispositivo.</div>
      <div style="height:10px"></div>
      <button class="btn-primary" data-action="export" type="button">⬇ Exportar copia (JSON)</button>
      <div style="height:8px"></div>
      <button data-action="import" type="button" style="width:100%">⬆ Importar copia</button>
      <input type="file" id="importFile" accept="application/json,.json" class="hidden">
      <p class="small muted" style="margin-top:8px">Importar fusiona por id: nunca duplica ni borra lo que ya tienes.</p>
    </div>

    <h2>App anterior</h2>
    <div class="card">
      <p class="small muted">Si entrenaste con Gym Log v2 y quedaron series sin sincronizar en este dispositivo, se pueden recuperar. Es solo lectura: no toca los datos antiguos.</p>
      <div style="height:10px"></div>
      <button data-action="rescue" type="button" style="width:100%">Buscar y recuperar series antiguas</button>
    </div>

    <h2>Rutina</h2>
    <div class="card">
      <p class="small muted">La rutina <b>${esc(CATALOG.releaseId)}</b> se compila desde la única nota <code>estado: activa</code> en <code>Brain/65_Gym/rutinas/</code>. Para cambiarla: cierra el bloque, actualiza la biblioteca y vuelve a correr <code>npm run catalog</code>. Las sesiones ya registradas guardan su propia copia del plan, así que cambiar la rutina no altera el historial.</p>
      ${CATALOG.days.map((d) => `<div class="row small" style="padding:5px 0"><span>${esc(d.label)} · ${esc(d.name)}</span><span class="right muted">${d.plan.length} ej.</span></div>`).join('')}
    </div>

    <h2>Zona peligrosa</h2>
    <div class="card">
      <button class="btn-danger" data-action="wipe" type="button" style="width:100%">Borrar todos los datos de este dispositivo</button>
      <p class="small muted" style="margin-top:8px">Exporta antes. Esto no se puede deshacer.</p>
    </div>
  `;
}

function restAlertCard() {
  const perm = pushPermission();
  if (perm === 'unsupported') {
    return '<p class="small muted">Este navegador no admite avisos. En el iPhone, abre Gym desde su ícono en la pantalla de inicio.</p>';
  }
  if (perm === 'granted') {
    return `
      <div class="ex-name">Activado</div>
      <div class="ex-presc">Al terminar cada descanso llega una notificación; con el iPhone bloqueado, el Apple Watch te toca la muñeca.</div>
      <div style="height:10px"></div>
      <button data-action="test-push" type="button" style="width:100%">Probar: aviso en 10 s</button>`;
  }
  return `
    <div class="ex-name">${perm === 'denied' ? 'Notificaciones bloqueadas' : 'Desactivado'}</div>
    <div class="ex-presc">${perm === 'denied'
      ? 'Actívalas en Configuración → Notificaciones → Gym y vuelve aquí.'
      : 'El iPhone no deja vibrar a una web: el aviso llega como notificación desde gym-sync y el Apple Watch la reenvía.'}</div>
    <div style="height:10px"></div>
    <button class="btn-primary" data-action="enable-push" type="button" style="width:100%">Activar aviso</button>`;
}

// --- render + eventos -------------------------------------------------------

const VIEWS = { hoy: renderHoy, historial: renderHistorial, cuerpo: renderCuerpo, ajustes: renderAjustes };

let scrolledFor = null;

function render() {
  if (!store.state.ready) { view.innerHTML = '<div class="empty">Cargando…</div>'; return; }
  view.innerHTML = VIEWS[ui.tab]();
  keepScreenOn(Boolean(store.activeSession()));
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('active', b.dataset.tab === ui.tab);
  }

  // Al abrir (o auto-avanzar a) un ejercicio, tráelo a la vista. Sin esto el
  // avance automático deja al usuario mirando la tarjeta anterior.
  if (ui.tab === 'hoy' && ui.openExercise !== scrolledFor) {
    scrolledFor = ui.openExercise;
    const card = ui.openExercise && document.querySelector(`[data-card="${CSS.escape(ui.openExercise)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (ui.tab !== 'hoy') scrolledFor = null;
}

function readDraftFromInputs() {
  if (!ui.draft) return;
  const w = document.getElementById('f-weight');
  const r = document.getElementById('f-reps');
  if (w) ui.draft.weight = w.value === '' ? null : w.value;
  if (r) ui.draft.reps = r.value === '' ? null : r.value;
}

document.addEventListener('click', async (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) {
    ui.tab = tab.dataset.tab;
    ui.openSession = null;
    render();
    return;
  }

  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;

  switch (action) {
    case 'pick-day':
      ui.pickDay = el.dataset.day;
      render();
      break;

    case 'start-session': {
      const session = await store.startSession(el.dataset.day);
      ui.pickDay = null;
      // Abre directo el primer ejercicio: una pulsación menos para empezar.
      ui.openExercise = session.planSnapshot[0]?.exerciseId || null;
      ui.draft = null;
      render();
      break;
    }

    case 'open-ex': {
      const id = el.dataset.ex;
      ui.openExercise = ui.openExercise === id ? null : id;
      ui.draft = null;
      render();
      break;
    }

    case 'step': {
      readDraftFromInputs();
      const field = el.dataset.field;
      const delta = Number(el.dataset.delta);
      const cur = Number(String(ui.draft[field] ?? 0).replace(',', '.')) || 0;
      ui.draft[field] = Math.max(0, M.round(cur + delta, 2));
      buzz(8);
      render();
      break;
    }

    case 'set-rir':
      readDraftFromInputs();
      ui.draft.rir = el.dataset.rir === '' ? null : Number(el.dataset.rir);
      render();
      break;

    case 'toggle-unit': {
      readDraftFromInputs();
      const from = ui.draft.unit;
      const to = from === 'kg' ? 'lb' : 'kg';
      // Convierte el valor visible para no perder la carga ya escrita.
      const w = Number(String(ui.draft.weight ?? 0).replace(',', '.')) || 0;
      ui.draft.weight = w ? M.fromKg(M.toKg(w, from), to) : ui.draft.weight;
      ui.draft.unit = to;
      render();
      break;
    }

    case 'same-as-last': {
      const session = store.activeSession();
      const prev = previousSets(ui.draft.exerciseId, session.id);
      const src = prev[Math.min(ui.draft.setIndex - 1, prev.length - 1)] || prev[prev.length - 1];
      if (src) {
        ui.draft = { ...ui.draft, weight: src.weight, reps: src.reps, rir: src.rir, unit: src.unit };
        render();
      }
      break;
    }

    case 'save-set': {
      readDraftFromInputs();
      const session = store.activeSession();
      const exId = el.dataset.ex;
      const p = planItem(session, exId);
      const mine = store.setsOfExerciseInSession(session.id, exId);
      const d = ui.draft;
      unlockAudio();

      const saved = await store.saveSet({
        id: d.setId || undefined,
        sessionId: session.id,
        exerciseId: exId,
        setIndex: d.setId ? d.setIndex : mine.length + 1,
        kind: p?.kind || 'peso',
        durationUnit: p?.durationUnit || null,
        weight: d.weight,
        unit: d.unit,
        reps: d.reps,
        rir: d.rir,
      });

      buzz(18);
      const after = store.setsOfExerciseInSession(session.id, exId);
      const records = d.setId ? [] : M.personalRecords(setsBefore(saved), saved);
      if (records.length) {
        buzz([40, 60, 40]);
        toast(`Récord: ${records.map(recordText).join(' · ')}`, 3500);
      } else {
        toast(d.setId ? 'Serie actualizada' : `Serie ${after.length} guardada`);
      }

      if (!d.setId && p?.restSec) startRest(p.restSec);

      // Ejercicio completo → salta al siguiente pendiente y ahorra pulsaciones.
      if (!d.setId && p && after.length >= p.sets) {
        const next = (session.planSnapshot || []).find((q) => (
          store.setsOfExerciseInSession(session.id, q.exerciseId).length < q.sets
        ));
        ui.openExercise = next ? next.exerciseId : null;
        if (!next) toast('Todos los ejercicios completos');
      }
      ui.draft = null;
      render();
      break;
    }

    case 'edit-set': {
      const s = store.state.sets.find((x) => x.id === el.dataset.id);
      if (s) {
        ui.openExercise = s.exerciseId;
        ui.draft = {
          exerciseId: s.exerciseId, setId: s.id, setIndex: s.setIndex,
          weight: s.weight, reps: s.reps, rir: s.rir, unit: s.unit,
        };
        render();
      }
      break;
    }

    case 'cancel-edit':
      ui.draft = null;
      render();
      break;

    case 'del-set':
      await store.deleteSet(el.dataset.id);
      ui.draft = null;
      toast('Serie borrada');
      render();
      break;

    case 'finish-session': {
      const session = store.activeSession();
      const n = store.setsOfSession(session.id).length;
      if (n === 0) {
        await store.discardSession(session.id);
        toast('Sesión vacía descartada');
      } else {
        await store.finishSession();
        toast(`Sesión guardada · ${n} series`);
      }
      ui.openExercise = null;
      ui.draft = null;
      stopRest();
      render();
      break;
    }

    case 'discard-session':
      await store.discardSession(store.activeSession().id);
      ui.openExercise = null;
      toast('Sesión descartada');
      render();
      break;

    case 'view-session':
      ui.openSession = el.dataset.id;
      ui.tab = 'historial';
      render();
      break;

    case 'close-session-detail':
      ui.openSession = null;
      render();
      break;

    case 'reopen-session':
      await store.reopenSession(el.dataset.id);
      ui.openSession = null;
      ui.tab = 'hoy';
      toast('Sesión reabierta');
      render();
      break;

    case 'save-measures': {
      const peso = document.getElementById('m-peso').value.trim();
      const cintura = document.getElementById('m-cintura').value.trim();
      let n = 0;
      if (peso !== '') { await store.saveMeasurement({ type: 'weight', value: peso, unit: 'kg' }); n += 1; }
      if (cintura !== '') { await store.saveMeasurement({ type: 'waist', value: cintura, unit: 'cm' }); n += 1; }
      const sueno = hoursFromParts(
        document.getElementById('m-sueno-h').value,
        document.getElementById('m-sueno-min').value,
      );
      if (sueno !== null) { await store.saveMeasurement({ type: 'sleep', value: sueno, unit: 'h' }); n += 1; }
      const pasos = stepsFromInput(document.getElementById('m-pasos').value);
      if (pasos !== null) {
        await store.saveMeasurement({ type: 'steps', value: pasos, date: document.getElementById('m-pasos-dia').value });
        n += 1;
      }
      toast(n ? 'Registro guardado' : 'Nada que guardar');
      render();
      break;
    }

    case 'save-steps-week': {
      const prom = stepsFromInput(document.getElementById('m-pasos-prom').value);
      if (prom === null) { toast('Escribe el promedio diario de la semana'); break; }
      await store.saveMeasurement({ type: 'steps_week', value: prom, date: document.getElementById('m-pasos-semana').value });
      toast('Promedio semanal guardado');
      render();
      break;
    }

    case 'enable-push': {
      const res = await enablePush(store);
      toast(res.ok ? 'Aviso activado' : `Error: ${res.error}`, res.ok ? 1900 : 4000);
      render();
      break;
    }

    case 'test-push':
      scheduleRestPush(store, Date.now() + 10000);
      toast('Bloquea el iPhone: en 10 s debe llegar el aviso', 3500);
      break;

    case 'del-measure':
      await store.deleteMeasurement(el.dataset.id);
      render();
      break;

    case 'export': await exportBackup(); render(); break;

    case 'go-backup':
      ui.tab = 'ajustes';
      render();
      document.querySelector('[data-action="export"]')?.scrollIntoView({ block: 'center' });
      break;

    case 'rescue': {
      const { readLegacy } = await import('./rescue.js');
      const legacy = await readLegacy();
      if (!legacy) { toast('No se encontraron datos de la app anterior'); break; }
      const r = await store.importData(legacy);
      toast(r.sets ? `Recuperadas ${r.sets} series` : 'Ya estaban recuperadas');
      render();
      break;
    }

    case 'import': document.getElementById('importFile').click(); break;

    case 'wipe':
      if (confirm('¿Borrar TODAS las sesiones, series y medidas de este dispositivo? Exporta antes: no se puede deshacer.')) {
        await store.wipe();
        toast('Datos borrados');
        render();
      }
      break;

    case 'open-sync-modal': {
      const cfg = await store.getSyncConfig();
      const ep = document.getElementById('syncEndpointInput');
      const tk = document.getElementById('syncTokenInput');
      if (ep) ep.value = cfg.endpoint || '';
      if (tk) tk.value = cfg.token || '';
      document.getElementById('syncModal')?.classList.remove('hidden');
      updateSyncBadge();
      break;
    }

    case 'close-sync-modal':
      document.getElementById('syncModal')?.classList.add('hidden');
      break;

    case 'save-sync-config': {
      const endpoint = document.getElementById('syncEndpointInput')?.value.trim() || '';
      const token = document.getElementById('syncTokenInput')?.value.trim() || '';
      await store.setSyncConfig({ endpoint, token });
      toast('Ajustes de sincronización guardados');
      document.getElementById('syncModal')?.classList.add('hidden');
      const res = await flushOutbox(store, { force: true });
      if (res.ok && res.sent > 0) toast(`✓ ${res.sent} eventos sincronizados`);
      break;
    }

    case 'test-sync': {
      const endpoint = document.getElementById('syncEndpointInput')?.value.trim() || '';
      const token = document.getElementById('syncTokenInput')?.value.trim() || '';
      if (!endpoint || !token) {
        toast('Ingresa endpoint y token para probar');
        break;
      }
      toast('Probando conexión...');
      const res = await testSyncConnection(endpoint, token);
      if (res.ok) {
        toast('✓ Conexión exitosa con el servidor');
      } else {
        toast(`Error: ${res.error}`);
      }
      break;
    }

    case 'manual-sync': {
      toast('Sincronizando...');
      const res = await flushOutbox(store, { force: true });
      if (res.ok) {
        toast(res.sent > 0 ? `✓ Sincronizados ${res.sent} eventos` : '✓ Todo al día (0 pendientes)');
      } else {
        toast(`Error: ${res.error || res.reason}`);
      }
      break;
    }

    default: break;
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'exPicker') {
    ui.historyExercise = ev.target.value;
    render();
  }
  if (ev.target.id === 'importFile' && ev.target.files.length) {
    try {
      const text = await ev.target.files[0].text();
      const report = await store.importData(JSON.parse(text));
      toast(`Importado: ${report.sets} series, ${report.sessions} sesiones`);
      render();
    } catch (err) {
      toast('No se pudo importar: archivo inválido');
    }
    ev.target.value = '';
  }
});

// Enter en un campo numérico guarda la serie: registrar sin soltar el teléfono.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  if (ev.target.id === 'f-weight' || ev.target.id === 'f-reps') {
    ev.preventDefault();
    ev.target.blur();
    document.querySelector('[data-action="save-set"]')?.click();
  }
});

async function exportBackup() {
  const data = store.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gym-${M.localDate()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  await store.markExported();
  toast(`Exportadas ${data.counts.sets} series`);
}

// --- temporizador de descanso ----------------------------------------------

let restTimer = null;
function startRest(seconds) {
  ui.restEndsAt = Date.now() + seconds * 1000;
  scheduleRestPush(store, ui.restEndsAt);
  restEl.classList.remove('hidden');
  tickRest();
  clearInterval(restTimer);
  restTimer = setInterval(tickRest, 250);
}

/** ±15 s sobre el descanso en curso; el aviso del reloj se reagenda. */
function adjustRest(deltaSec) {
  if (!ui.restEndsAt) return;
  ui.restEndsAt = Math.max(Date.now() + 5000, ui.restEndsAt + deltaSec * 1000);
  scheduleRestPush(store, ui.restEndsAt);
  tickRest();
}

function tickRest() {
  if (!ui.restEndsAt) return;
  const left = (ui.restEndsAt - Date.now()) / 1000;
  if (left <= 0) {
    restLabel.textContent = '0:00';
    // Con la app a la vista: pitido (y vibración donde exista). Con el iPhone
    // bloqueado, el aviso lo da el push que ya agendó gym-sync.
    beep();
    buzz([60, 40, 60]);
    stopRest({ fromTimer: true });
    return;
  }
  restLabel.textContent = fmtClock(left);
}

function stopRest({ fromTimer = false } = {}) {
  if (!fromTimer && ui.restEndsAt) cancelRestPush(store);
  clearInterval(restTimer);
  restTimer = null;
  ui.restEndsAt = null;
  restEl.classList.add('hidden');
}

document.getElementById('restSkip').addEventListener('click', () => stopRest());
document.getElementById('restMinus').addEventListener('click', () => adjustRest(-15));
document.getElementById('restPlus').addEventListener('click', () => adjustRest(15));

// Cronómetro de la sesión: actualiza solo ese nodo, sin re-render completo
// (un re-render mientras escribes borraría lo que estás tecleando).
setInterval(() => {
  const s = store.activeSession();
  const node = document.getElementById('elapsed');
  if (!s || !node) return;
  const done = store.setsOfSession(s.id);
  const vol = M.sessionVolumeKg(done);
  node.textContent = `${fmtElapsed(s.startedAt)} · ${done.length} series${vol ? ` · ${fmtNum(vol)} kg` : ''}`;
}, 1000);

// --- arranque ---------------------------------------------------------------

store.subscribe(() => {});
store.init()
  .then(() => {
    initSyncFromStore(store);
    render();
    updateSyncBadge();
    flushOutbox(store).catch(() => {});
  })
  .catch((err) => {
    view.innerHTML = `<div class="empty">No se pudo abrir la base de datos local.<br><span class="small">${esc(err.message)}</span></div>`;
  });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sin offline, la app igual funciona */ });
  });
}
