'use strict';

const fs = require('node:fs');
const path = require('node:path');

const norm = (p) => path.resolve(p).toLowerCase();

/** Os dois caminhos apontam para o mesmo arquivo? (Windows: sem diferenciar maiúsculas) */
function isSamePath(a, b) {
  if (!a || !b) return false;
  return norm(a) === norm(b);
}

/**
 * Caminho de saída que nunca sobrescreve nada: "nome.ext", depois "nome (2).ext", "nome (3).ext"…
 * Pula também os caminhos em `avoid` (ex.: arquivos de origem ainda não processados do lote) e
 * os já reservados por este lote (`reserved`, um Set opcional que recebe o escolhido).
 * @param {string} dir
 * @param {string} name nome do arquivo com extensão
 * @param {{avoid?: string[], reserved?: Set<string>}} [opts]
 * @returns {string}
 */
function uniqueOutputPath(dir, name, opts = {}) {
  const avoid = (opts.avoid || []).map(norm);
  const reserved = opts.reserved || null;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 2;
  const taken = (p) => fs.existsSync(p) || avoid.includes(norm(p)) || (reserved && reserved.has(norm(p)));
  while (taken(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
    if (n > 9999) throw new Error('Não foi possível escolher um nome de arquivo livre.');
  }
  if (reserved) reserved.add(norm(candidate));
  return candidate;
}

module.exports = { uniqueOutputPath, isSamePath };
