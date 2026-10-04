// Aviso rápido (toast) global: confirma uma ação sem interromper o usuário e, quando a ação é
// realmente reversível, oferece "Desfazer". Exposto também como window.bdsToast(texto, opções).
import { maskEngineNames } from './engineNames.js';

const MAX_TOASTS = 3;

function getContainer() {
  let box = document.getElementById('bdsToasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'bdsToasts';
    box.className = 'bds-toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  return box;
}

/**
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error', actionLabel?: string, onAction?: Function, duration?: number}} [opts]
 * @returns {{close: Function}}
 */
export function showToast(message, { type = 'info', actionLabel = '', onAction = null, duration = 6000 } = {}) {
  const box = getContainer();
  while (box.children.length >= MAX_TOASTS) box.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `bds-toast bds-toast-${type}`;
  const text = document.createElement('span');
  text.className = 'bds-toast-text';
  text.textContent = String(maskEngineNames(message) ?? '');
  el.appendChild(text);

  let timer = null;
  const close = () => { clearTimeout(timer); el.remove(); };

  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bds-toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => { close(); try { onAction(); } catch (err) { console.error('[TOAST] ação falhou:', err); } });
    el.appendChild(btn);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'bds-toast-close';
  x.title = 'Dispensar';
  x.setAttribute('aria-label', 'Dispensar aviso');
  x.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">close</span>';
  x.addEventListener('click', close);
  el.appendChild(x);

  box.appendChild(el);
  if (duration > 0) timer = setTimeout(close, duration);
  return { close };
}

if (typeof window !== 'undefined') window.bdsToast = showToast;
