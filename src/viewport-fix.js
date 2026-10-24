// Esquiva el fallo de iOS 26 en apps de la pantalla de inicio: al cerrar el teclado
// (peso o reps), WebKit no devuelve el viewport a su tamaño y las barras fijas (pestañas,
// descanso, avisos) quedan flotando a media pantalla. Apple lo tiene reportado (FB20249802)
// y sin arreglo. Tres defensas, todas inocuas donde el fallo no existe:
//  1. CSS en app.css: en modo standalone, html mide al menos la pantalla grande (100lvh).
//  2. Si el viewport visual quedó desplazado respecto del de diseño, las barras fijas
//     bajan esa diferencia (--vv-shift).
//  3. Si el viewport quedó encogido tras cerrar el teclado, se fuerza a WebKit a medirlo de
//     nuevo ocultando y mostrando el body en el mismo frame (sin pintar entre medio).

// Instalada en la pantalla de inicio (viewport-fit=cover), la app debe medir toda la
// pantalla; si arranca ya encogida, innerHeight no sirve de referencia y se usa screen.height.
const standalone = window.navigator.standalone === true
  || window.matchMedia?.('(display-mode: standalone)').matches;
let maxHeight = standalone ? Math.max(window.innerHeight, window.screen.height) : window.innerHeight;

function updateShift() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Hueco entre el borde inferior del viewport visual y el de diseño. Solo se corrige hacia
  // abajo: con el teclado abierto el hueco es negativo y las barras se quedan donde están.
  const gap = Math.round(vv.offsetTop + vv.height - window.innerHeight);
  document.documentElement.style.setProperty('--vv-shift', `${gap > 1 ? gap : 0}px`);
}

function remeasure() {
  const y = window.scrollY;
  const body = document.body;
  body.style.display = 'none';
  void body.offsetHeight; // reflow síncrono, sin pintar
  body.style.display = '';
  window.scrollTo(window.scrollX, y);
}

// Altura con la que ya se intentó medir de nuevo sin éxito: no se repite en cada render.
let triedAt = null;

/** Barato si no hay fallo: solo actúa cuando el viewport quedó corto o desplazado. */
export function healViewport() {
  updateShift();
  const short = maxHeight - window.innerHeight > 4;
  if (short && !keyboardOpen() && triedAt !== window.innerHeight) {
    triedAt = window.innerHeight;
    remeasure();
    if (maxHeight - window.innerHeight <= 4) triedAt = null;
  }
  if (!short) triedAt = null;
  updateShift();
}

function keyboardOpen() {
  const el = document.activeElement;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'file');
}

export function installViewportFix() {
  window.addEventListener('resize', () => {
    if (!keyboardOpen()) maxHeight = Math.max(maxHeight, window.innerHeight);
    updateShift();
  });
  window.visualViewport?.addEventListener('resize', updateShift);
  window.visualViewport?.addEventListener('scroll', updateShift);
  // El teclado se cierra al salir del campo; iOS termina de animarlo unos 100-300 ms después.
  document.addEventListener('focusout', (ev) => {
    if (!ev.target || !['INPUT', 'TEXTAREA'].includes(ev.target.tagName)) return;
    setTimeout(healViewport, 150);
    setTimeout(healViewport, 450);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { triedAt = null; setTimeout(healViewport, 100); }
  });
  setTimeout(healViewport, 300);
}
