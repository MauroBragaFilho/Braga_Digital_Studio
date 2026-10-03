'use strict';

const path = require('node:path');

/** Cede o event loop (deixa a UI/IPC e outros timers rodarem entre lotes de trabalho). */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Executa `fn` sobre os itens com no máximo `limit` tarefas simultâneas, cedendo ao event loop
 * a cada `yieldEvery` itens concluídos. Preserva a ordem do resultado.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} [yieldEvery=50]
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn, yieldEvery = 50) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
      if (++done % yieldEvery === 0) await yieldToEventLoop();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Classifica as mídias em "ausentes a marcar" e "presentes a restaurar".
 *
 * Em vez de um fs.access por arquivo (lento em disco frio), agrupa por pasta e faz UM readdir
 * por pasta. Um arquivo encontrado na listagem existe; o que NÃO foi encontrado é confirmado
 * com fs.access (cobre diferenças de maiúsculas/normalização e pastas ilegíveis), então o
 * resultado é o mesmo da verificação individual.
 *
 * @param {Array<{id:number, filepath:string, missing:number|null}>} rows
 * @param {Object} io - { readdir(dir) => Promise<string[]>, access(file) => Promise<void> }
 * @param {Object} [opts] - { concurrency=12, caseInsensitive=(win32) }
 * @returns {Promise<{toMark:number[], toRestore:number[]}>}
 */
async function classifyRows(rows, io, opts = {}) {
  const concurrency = opts.concurrency || 12;
  const caseInsensitive = opts.caseInsensitive ?? (process.platform === 'win32');
  const norm = (n) => (caseInsensitive ? n.toLowerCase() : n);

  const byDir = new Map();
  for (const row of rows) {
    if (!row.filepath) continue;
    const dir = path.dirname(row.filepath);
    let list = byDir.get(dir);
    if (!list) { list = []; byDir.set(dir, list); }
    list.push(row);
  }

  const toMark = [];
  const toRestore = [];
  const exists = (file) => io.access(file).then(() => true, () => false);

  await mapLimit([...byDir.entries()], concurrency, async ([dir, dirRows]) => {
    let names = null;
    try { names = new Set((await io.readdir(dir)).map(norm)); } catch (_) { names = null; }

    for (const row of dirRows) {
      let ok = !!names && names.has(norm(path.basename(row.filepath)));
      if (!ok) ok = await exists(row.filepath);
      if (!ok && row.missing !== 1) toMark.push(row.id);
      else if (ok && row.missing === 1) toRestore.push(row.id);
    }
  }, 25);

  return { toMark, toRestore };
}

module.exports = { yieldToEventLoop, mapLimit, classifyRows };
