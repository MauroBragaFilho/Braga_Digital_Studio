'use strict';
/**
 * Caminhos de saída das exportações de projeto (.bdspro, XML do Premiere): sanitização única do nome
 * e junção com path.join no processo principal (RK-039), sem '\\' fixo nem nome de projeto cru.
 */
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Remove caracteres inválidos no Windows, pontos/espaços nas pontas e nomes reservados; limita o tamanho. */
function sanitizeFileName(name, fallback = 'Projeto') {
  let s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120).replace(/[\s.]+$/g, '');
  if (!s) return fallback;
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/**
 * `spec` pode ser um caminho completo (string, comportamento antigo) ou `{ folder, name, suffix }`.
 * Neste caso monta folder/<nome sanitizado><suffix><ext> com path.join.
 */
function buildOutputPath(spec, ext, fallbackName = 'Projeto') {
  if (typeof spec === 'string') return spec;
  if (!spec || typeof spec !== 'object' || typeof spec.folder !== 'string' || !spec.folder) {
    throw new Error('Destino da exportação inválido.');
  }
  const base = sanitizeFileName(spec.name, fallbackName) + (spec.suffix ? String(spec.suffix).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') : '');
  return path.join(spec.folder, base + ext);
}

module.exports = { sanitizeFileName, buildOutputPath };
