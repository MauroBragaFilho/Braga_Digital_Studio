/**
 * slider-sync.js
 * ---------------------------------------------------------------------------
 * Helper GLOBAL do componente de range slider do BDS.
 *
 * Sincroniza --slider-value (0%..100%) de todos os input[type=range] do app,
 * substituindo o fill nativo (accent-color) por um gradiente customizado
 * definido em style.css ("RANGE SLIDERS - COMPONENTE GLOBAL").
 *
 * Cobertura:
 *   • Interação direta do usuário (drag/teclado): evento input em capture.
 *   • Alterações programáticas (slider.value = X): watchdog periódico de 1s (pausado com a janela oculta).
 *   • Sliders criados dinamicamente (ex.: linhas .montage-pct-slider): polling.
 *
 * Nenhum arquivo de tela precisa de alteração — o helper se auto-inicializa
 * via app.js e detecta automaticamente qualquer input[type=range] no DOM.
 * ---------------------------------------------------------------------------
 */

const SLIDER_SELECTOR = 'input[type="range"]';
const POLL_INTERVAL_MS = 1000; // watchdog só para mudanças programáticas (a interação do usuário é imediata via eventos)

function computePct(el) {
  const min = parseFloat(el.min);
  const max = parseFloat(el.max);
  const val = parseFloat(el.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  let pct = ((val - min) / (max - min)) * 100;
  if (!Number.isFinite(pct)) pct = 0;
  return Math.max(0, Math.min(100, pct));
}

function syncSlider(el) {
  const pct = computePct(el);
  el.style.setProperty('--slider-value', `${pct}%`);
  el.dataset.sliderSynced = String(el.value);
}

function syncAllSliders() {
  document.querySelectorAll(SLIDER_SELECTOR).forEach((el) => {
    if (el.dataset.sliderSynced !== String(el.value)) syncSlider(el);
  });
}

let _initialized = false;

export function initSliderSync() {
  if (_initialized) return;
  _initialized = true;

  // Resposta imediata durante interação do usuário (drag / teclado).
  // Capture phase garante atualização antes dos listeners das telas.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches(SLIDER_SELECTOR)) syncSlider(t);
  }, true);

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches(SLIDER_SELECTOR)) syncSlider(t);
  }, true);

  // Sincroniza todos os sliders já existentes no DOM.
  syncAllSliders();

  // Watchdog leve: cobre mudanças programáticas (slider.value = X) e
  // sliders criados dinamicamente (ex.: .montage-pct-slider do metadata.js).
  setInterval(() => { if (!document.hidden) syncAllSliders(); }, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAllSliders(); });
}
