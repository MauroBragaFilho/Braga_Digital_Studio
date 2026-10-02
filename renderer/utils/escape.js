// Utilitário único de escape HTML (evita XSS ao interpolar dados de arquivos/usuário em innerHTML)
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };

export function escapeHtml(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>'"]/g, (m) => MAP[m]);
}

export function escapeAttr(value) {
  return escapeHtml(value);
}
