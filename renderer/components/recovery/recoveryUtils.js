/**
 * recoveryUtils.js — Helpers de DOM e formatação compartilhados pelos componentes de Recuperação.
 * Todo texto entra por textContent: nada vindo de dados é interpretado como HTML.
 */

/**
 * Cria um elemento. props: class, text, dataset, aria/atributos, on* (eventos), disabled etc.
 * @param {string} tag
 * @param {Object} [props]
 * @param {Array<Node|string|null|false>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'disabled' || key === 'checked' || key === 'hidden') el[key] = !!value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Ícone Material Symbols. */
export function icon(name, extraClass = '') {
  return h('span', { class: `material-symbols-rounded${extraClass ? ' ' + extraClass : ''}`, 'aria-hidden': 'true', text: name });
}

/** "02/10/2026 — 01:10" */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} — ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "02/10/2026 01:10" (versão compacta para listas) */
export function formatDateTimeShort(iso) {
  return formatDateTime(iso).replace(' — ', ' ');
}

export function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Remove todos os filhos de um elemento. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}
