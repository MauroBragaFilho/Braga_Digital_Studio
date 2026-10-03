'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Grava `content` em um nome livre, sem nunca sobrescrever: x.srt, x (2).srt, x (3).srt…
 * Para nomes como "aula.analise.md" o sufixo entra no fim do nome base ("aula.analise (2).md").
 * @returns {string} o caminho gravado
 */
function writeUnique(target, content) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? target : path.join(dir, `${base} (${n})${ext}`);
    try {
      fs.writeFileSync(candidate, content, { encoding: 'utf8', flag: 'wx' });
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Não foi possível escolher um nome livre para o arquivo.');
}

module.exports = { writeUnique };
