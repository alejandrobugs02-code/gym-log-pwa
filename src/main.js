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
  prescriptionLine, sparkline, esc, summarizeSets,
} from './format.js';

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
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

function buzz(ms = 12) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* opcional */ } }
}

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

  const backup = store.backupStatus();
  const warn = backup.overdue ? `
    <div class="card tappable warnbar" data-action="go-backup">
      <div class="row">
        <span>⚠️</span>
        <div class="ex-title">
          <div class="ex-name">${backup.pending} sesiones sin respaldar</div>
          <div class="ex-presc">${backup.never ? 'Nunca has exportado' : `Último respaldo hace ${backup.days} días`} · toca para exportar</div>
        </div>
      </div>
    </div>` : '';

  return `
    <h1>Hoy</h1>
    <p class="sub">${recent.length ? `Última sesión ${relDay(recent[0].date)} · ${esc(recent[0].dayLabel)}` : 'Sin sesiones todavía. Empieza cuando quieras.'}</p>
    ${warn}

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

function setList(sets) {
  const best = sets.length ? sets.reduce((a, b) => ((b.e1rm || 0) > (a.e1rm || 0) ? b : a)) : null;
  return `<div class="setlist">${sets.map((s) => `
    <div class="setrow">
      <span class="idx">${s.setIndex}</span>
      <span class="val">${esc(fmtSet(s))}</span>
      ${best && s.id === best.id && sets.length > 1 ? '<span class="pr">top</span>' : ''}
      <button data-action="edit-set" data-id="${s.id}" type="button" aria-label="Editar serie">✏️</button>
      <button data-action="del-set" data-id="${s.id}" type="button" aria-label="Borrar serie">✕</button>
    </div>`).join('')}</div>`;
}

// --- pestaña HISTORIAL ------------------------------------------------------

function renderHistorial() {
  if (ui.openSession) return renderSessionDetail(ui.openSession);

  const trained = [...new Set(store.state.sets.map((s) => s.exerciseId))];
  if (!store.state.sessions.length) {
    return '<h1>Historial</h1><div class="empty"><span class="big">📈</span>Cuando registres tu primera sesión, aquí verás la progresión por ejercicio.</div>';
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
    <h2>Progresión por ejercicio</h2>
    <select id="exPicker" data-action="pick-history-ex">${options}</select>
    ${exerciseProgressCard(exId)}
    <h2>Sesiones</h2>
    ${sessions.map(sessionCard).join('')}
  `;
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

function renderChart(sp) {
  if (!sp) return '';
  const pts = sp.points.map((p) => `<circle class="pt" cx="${p.x}" cy="${p.y}" r="3"></circle>`).join('');
  return `
    <svg class="chart" viewBox="0 0 ${sp.width} ${sp.height}" preserveAspectRatio="none" role="img" aria-label="Progresión estimada">
      <line class="grid" x1="18" y1="${sp.height - 18}" x2="${sp.width - 18}" y2="${sp.height - 18}"></line>
      <path class="area" d="${sp.area}"></path>
      <path class="line" d="${sp.line}"></path>
      ${pts}
      <text class="lbl" x="20" y="14">${fmtNum(sp.max)} kg</text>
      <text class="lbl" x="20" y="${sp.height - 4}">${fmtNum(sp.min)} kg</text>
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

function renderCuerpo() {
  const peso = store.measurementsOfType('peso');
  const cintura = store.measurementsOfType('cintura');
  const today = M.localDate();
  const pesoHoy = peso.find((m) => m.date === today);
  const cinturaHoy = cintura.find((m) => m.date === today);

  return `
    <h1>Cuerpo</h1>
    <p class="sub">Una medida por día. Si te vuelves a pesar hoy, se corrige la de hoy.</p>

    <div class="card">
      <div class="field-pair">
        <div>
          <label>Peso corporal (kg)</label>
          <input id="m-peso" inputmode="decimal" enterkeyhint="done" value="${pesoHoy ? pesoHoy.value : ''}" placeholder="${peso.length ? fmtNum(peso[peso.length - 1].value) : '—'}">
        </div>
        <div>
          <label>Cintura (cm)</label>
          <input id="m-cintura" inputmode="decimal" enterkeyhint="done" value="${cinturaHoy ? cinturaHoy.value : ''}" placeholder="${cintura.length ? fmtNum(cintura[cintura.length - 1].value) : '—'}">
        </div>
      </div>
      <button class="btn-primary" data-action="save-measures" type="button">✓ Guardar medidas de hoy</button>
    </div>

    ${measureCard('Peso corporal', peso, 'kg')}
    ${measureCard('Cintura', cintura, 'cm')}
  `;
}

function measureCard(title, rows, unit) {
  if (!rows.length) return `<h2>${title}</h2><div class="card muted">Sin registros todavía.</div>`;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const delta = M.round(last.value - first.value, 2);
  const chart = rows.length > 1 ? renderChart(sparkline(rows.map((r) => r.value))) : '';
  const recent = [...rows].reverse().slice(0, 6).map((r) => `
    <div class="row small" style="padding:6px 0;border-top:1px solid var(--line)">
      <span class="muted">${fmtDateShort(r.date)}</span>
      <span class="right nums">${fmtNum(r.value)} ${unit}</span>
      <button data-action="del-measure" data-id="${r.id}" type="button" aria-label="Borrar" style="min-height:30px;min-width:30px;padding:0 8px;background:transparent">✕</button>
    </div>`).join('');

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

// --- pestaña AJUSTES --------------------------------------------------------

function renderAjustes() {
  const s = store.state;
  const b = store.backupStatus();
  return `
    <h1>Ajustes</h1>
    <p class="sub">Gym ${APP_VERSION} · rutina ${esc(CATALOG.routineVersion)}</p>

    <div class="stats">
      <div class="stat"><div class="n">${s.sessions.length}</div><div class="l">sesiones</div></div>
      <div class="stat"><div class="n">${s.sets.length}</div><div class="l">series</div></div>
      <div class="stat"><div class="n">${s.measurements.length}</div><div class="l">medidas</div></div>
    </div>

    <h2>Respaldo</h2>
    <div class="card ${b.overdue ? 'warnbar' : ''}">
      <div class="ex-name">${b.never ? 'Nunca has exportado' : `Último respaldo: ${relDay(b.lastExportAt.slice(0, 10))}`}</div>
      <div class="ex-presc">${b.pending === 0 ? 'Todo respaldado.' : `${b.pending} ${b.pending === 1 ? 'sesión' : 'sesiones'} sin respaldar.`}</div>
      <div style="height:10px"></div>
      <p class="small muted">Los datos viven solo en este dispositivo. Exporta cada semana y guarda el archivo en Drive o en el vault: es también lo que leen los agentes para analizar tu entrenamiento.</p>
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
      <button data-action="rescue" type="button" style="width:100%">🛟 Buscar y recuperar series antiguas</button>
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

// --- render + eventos -------------------------------------------------------

const VIEWS = { hoy: renderHoy, historial: renderHistorial, cuerpo: renderCuerpo, ajustes: renderAjustes };

let scrolledFor = null;

function render() {
  if (!store.state.ready) { view.innerHTML = '<div class="empty">Cargando…</div>'; return; }
  view.innerHTML = VIEWS[ui.tab]();
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

      await store.saveSet({
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
      toast(d.setId ? 'Serie actualizada' : `Serie ${after.length} guardada`);

      if (!d.setId && p?.restSec) startRest(p.restSec);

      // Ejercicio completo → salta al siguiente pendiente y ahorra pulsaciones.
      if (!d.setId && p && after.length >= p.sets) {
        const next = (session.planSnapshot || []).find((q) => (
          store.setsOfExerciseInSession(session.id, q.exerciseId).length < q.sets
        ));
        ui.openExercise = next ? next.exerciseId : null;
        if (!next) toast('Todos los ejercicios completos 💪');
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
      if (peso !== '') { await store.saveMeasurement({ type: 'peso', value: peso, unit: 'kg' }); n += 1; }
      if (cintura !== '') { await store.saveMeasurement({ type: 'cintura', value: cintura, unit: 'cm' }); n += 1; }
      toast(n ? 'Medidas guardadas' : 'Nada que guardar');
      render();
      break;
    }

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
  restEl.classList.remove('hidden');
  tickRest();
  clearInterval(restTimer);
  restTimer = setInterval(tickRest, 250);
}

function tickRest() {
  if (!ui.restEndsAt) return;
  const left = (ui.restEndsAt - Date.now()) / 1000;
  if (left <= 0) {
    restLabel.textContent = '0:00';
    buzz([60, 40, 60]);
    stopRest();
    return;
  }
  restLabel.textContent = fmtClock(left);
}

function stopRest() {
  clearInterval(restTimer);
  restTimer = null;
  ui.restEndsAt = null;
  restEl.classList.add('hidden');
}

document.getElementById('restSkip').addEventListener('click', stopRest);

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
  .then(() => render())
  .catch((err) => {
    view.innerHTML = `<div class="empty"><span class="big">⚠️</span>No se pudo abrir la base de datos local.<br><span class="small">${esc(err.message)}</span></div>`;
  });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sin offline, la app igual funciona */ });
  });
}
