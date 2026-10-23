// Aviso de fin de descanso. Safari en iPhone no implementa navigator.vibrate,
// así que vibrar no sirve; el aviso llega por tres vías:
//  1. pitido corto si la app está a la vista,
//  2. notificación push desde gym-sync (el iPhone la reenvía al Apple Watch),
//  3. pantalla encendida durante la sesión (Screen Wake Lock).
// Todo es opcional: si una vía falla, el descanso sigue funcionando en pantalla.

// --- pitido -----------------------------------------------------------------

let audioCtx = null;

/** iOS solo deja sonar audio creado dentro de un toque: se llama al guardar la serie. */
export function unlockAudio() {
  try {
    // 'transient' baja la música un instante en vez de cortarla.
    if (navigator.audioSession) navigator.audioSession.type = 'transient';
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sin audio */ }
}

/** Dos tonos cortos. */
export function beep() {
  if (!audioCtx || document.visibilityState !== 'visible') return;
  try {
    const t0 = audioCtx.currentTime;
    [0, 0.22].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.18);
    });
  } catch { /* sin audio */ }
}

// --- pantalla encendida -----------------------------------------------------

let wakeLock = null;
let wantAwake = false;
let requesting = false;

/** Idempotente: se llama en cada render con «¿hay sesión abierta?». */
export async function keepScreenOn(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && !requesting && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      requesting = true;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null;
  } finally {
    requesting = false;
  }
}

// El sistema suelta el bloqueo al salir de la app; se recupera al volver.
document.addEventListener('visibilitychange', () => {
  if (wantAwake && document.visibilityState === 'visible') keepScreenOn(true);
});

// --- push al reloj ----------------------------------------------------------

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

async function api(store, path, { method = 'POST', body } = {}) {
  const config = await store.getSyncConfig();
  const endpoint = (config.endpoint || '').trim().replace(/\/+$/, '');
  const token = (config.token || '').trim();
  if (!endpoint || !token) throw new Error('Configura primero la sincronización');
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: true,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Pide permiso (tiene que ser dentro de un toque) y registra el iPhone en gym-sync. */
export async function enablePush(store) {
  if (!pushSupported()) {
    return { ok: false, error: 'Este navegador no admite avisos. En iPhone, abre Gym desde el ícono de la pantalla de inicio.' };
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: 'Permiso de notificaciones denegado' };
    const { publicKey } = await api(store, '/api/push/key', { method: 'GET' });
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await api(store, '/api/push/subscription', { body: { subscription: sub.toJSON() } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Agenda (o reagenda) el aviso. Sin permiso o sin red, no hace nada: queda el pitido. */
export function scheduleRestPush(store, endsAt) {
  if (pushPermission() !== 'granted') return;
  api(store, '/api/push/rest', { body: { endsAt } }).catch(() => {});
}

export function cancelRestPush(store) {
  if (pushPermission() !== 'granted') return;
  api(store, '/api/push/rest/cancel', { body: {} }).catch(() => {});
}
