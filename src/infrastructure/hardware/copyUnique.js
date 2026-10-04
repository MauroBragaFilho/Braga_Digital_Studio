'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

/**
 * Copia `source` para `destDir/name` sem nunca sobrescrever e sem deixar arquivo parcial no destino.
 *  - mesmo nome e mesmo tamanho já no destino: considera importado e pula (`skipped: true`);
 *  - mesmo nome com tamanho diferente: grava em "nome (2).ext", "nome (3).ext"…;
 *  - copia para "<nome>.part", confere o tamanho e só então renomeia; em qualquer erro apaga o .part e rejeita.
 * @param {string} source
 * @param {string} destDir
 * @param {string} name
 * @param {(copied:number,total:number)=>void} [onProgress]
 * @returns {Promise<{dest:string, skipped:boolean, size:number}>}
 */
async function copyFileUnique(source, destDir, name, onProgress) {
  const stat = fs.statSync(source);
  const total = stat.size;
  const ext = path.extname(name);
  const base = path.basename(name, ext);

  const first = path.join(destDir, name);
  try {
    if (fs.statSync(first).size === total) {
      if (onProgress) onProgress(total, total);
      return { dest: first, skipped: true, size: total };
    }
  } catch (_) { /* não existe: segue */ }

  const part = path.join(destDir, `${base}.${process.pid}-${Date.now()}.part`);
  let copied = 0;
  const reader = fs.createReadStream(source);
  reader.on('data', (chunk) => {
    copied += chunk.length;
    if (onProgress) onProgress(copied, total);
  });
  try {
    await pipeline(reader, fs.createWriteStream(part, { flags: 'wx' }));
    const written = fs.statSync(part).size;
    if (written !== total) throw new Error(`Cópia incompleta de ${name} (${written} de ${total} bytes).`);
    for (let n = 1; n < 10000; n++) {
      const candidate = n === 1 ? first : path.join(destDir, `${base} (${n})${ext}`);
      if (fs.existsSync(candidate)) continue;
      fs.renameSync(part, candidate);
      return { dest: candidate, skipped: false, size: total };
    }
    throw new Error('Não foi possível escolher um nome livre para o arquivo.');
  } catch (err) {
    try { fs.unlinkSync(part); } catch (_) { /* já removido */ }
    throw err;
  }
}

module.exports = { copyFileUnique };
