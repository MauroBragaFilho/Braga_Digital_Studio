'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  LUT_EXT, MAX_SEGMENTS, MAX_PATH_BUDGET, PATH_RESERVE, PHONE_MAX_PATH
} = require('./lutConstants');
const { checkFileBaseName, checkFolderName, sanitizeFolderSegment } = require('./lutNames');

/**
 * Regra única da árvore de LUTs: a lista da tela, a sincronização com o celular e a importação de pastas
 * varrem do mesmo jeito (mesmo limite de níveis, mesmas exclusões, nunca seguindo atalhos nem junções).
 *
 * Níveis: o limite conta os segmentos do caminho DENTRO da coleção, contando o arquivo. Com MAX_SEGMENTS = 4,
 * "Grupo/Sub/Sub2/LUT.cube" ainda entra; "A/B/C/D/LUT.cube" não.
 */

const IS_WIN = process.platform === 'win32';
const SKIPPED_NAMES = new Set(['$recycle.bin', 'system volume information']);
const MAX_REPORTED = 50;
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

const keyOf = (p) => (IS_WIN ? p.toLowerCase() : p);
const sleepTick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Núcleo da varredura, escrito como gerador: cada acesso ao disco é "pedido" com yield e quem dirige (assíncrono ou
 * síncrono) o executa. Assim a mesma regra serve à lista síncrona e à varredura em segundo plano.
 */
function* walkCore(root, opts) {
  const {
    maxSegments, exts, includeHidden, signal, deadlineMs, maxEntries, onProgress
  } = opts;
  const result = {
    root: null, rootError: null, files: [], dirs: [], problems: [], links: [], ignoredLinks: 0, ignoredExt: {},
    tooDeep: [], tooDeepCount: 0, truncated: false, timedOut: false, canceled: false, entries: 0
  };
  let realRoot;
  try {
    realRoot = yield { op: 'realpath', p: root };
  } catch (err) {
    result.rootError = err;
    return result;
  }
  result.root = realRoot;

  const started = Date.now();
  const visited = new Set([keyOf(realRoot)]);
  // `abs` segue o caminho como foi dado (é o que a tela e os testes veem); `real` é o caminho resolvido, só para a guarda de links.
  const stack = [{ abs: path.resolve(root), real: realRoot, rel: '', depth: 0 }];
  const report = (list, item) => { if (list.length < MAX_REPORTED) list.push(item); };
  let lastProgress = 0;

  outer: while (stack.length) {
    if (signal && signal.aborted) { result.canceled = true; break; }
    if (deadlineMs && Date.now() - started > deadlineMs) { result.truncated = true; result.timedOut = true; break; }
    const dir = stack.pop();
    let entries;
    try {
      entries = yield { op: 'readdir', p: dir.abs };
    } catch (err) {
      report(result.problems, { relPath: dir.rel, code: err && err.code ? err.code : 'EREAD', kind: 'dir' });
      continue;
    }
    result.dirs.push({ relPath: dir.rel, abs: dir.abs, depth: dir.depth });

    for (const entry of entries) {
      result.entries++;
      if (result.entries > maxEntries) { result.truncated = true; break outer; }
      const name = entry.name;
      if (!includeHidden && (name.startsWith('.') || SKIPPED_NAMES.has(name.toLowerCase()))) continue;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const abs = path.join(dir.abs, name);

      if (entry.isSymbolicLink()) {
        result.ignoredLinks++;
        let isDir = false;
        try { isDir = (yield { op: 'stat', p: abs }).isDirectory(); } catch { /* link quebrado */ }
        report(result.links, { relPath: rel, isDir });
        continue;
      }
      if (entry.isDirectory()) {
        if (dir.depth + 2 > maxSegments) { // os arquivos desta pasta passariam do limite de níveis
          result.tooDeepCount++;
          report(result.tooDeep, rel);
          continue;
        }
        // Junção do Windows (e qualquer link que o sistema não tenha marcado): o caminho real precisa ser o esperado.
        let real;
        try {
          real = yield { op: 'realpath', p: abs };
        } catch (err) {
          report(result.problems, { relPath: rel, code: err && err.code ? err.code : 'EREAD', kind: 'dir' });
          continue;
        }
        if (keyOf(real) !== keyOf(path.join(dir.real, name))) {
          result.ignoredLinks++;
          report(result.links, { relPath: rel, isDir: true });
          continue;
        }
        if (visited.has(keyOf(real))) continue;
        visited.add(keyOf(real));
        stack.push({ abs, real, rel, depth: dir.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(name).toLowerCase();
      if (exts && !exts.includes(ext)) {
        const label = ext || '(sem extensão)';
        result.ignoredExt[label] = (result.ignoredExt[label] || 0) + 1;
        continue;
      }
      let stats;
      try {
        stats = yield { op: 'stat', p: abs };
      } catch (err) {
        report(result.problems, { relPath: rel, code: err && err.code ? err.code : 'EREAD', kind: 'file' });
        continue;
      }
      if (!stats.isFile()) continue;
      result.files.push({ relPath: rel, abs, name, folder: dir.rel, depth: dir.depth, size: stats.size, mtimeMs: stats.mtimeMs });
    }

    if (onProgress && Date.now() - lastProgress >= 100) {
      lastProgress = Date.now();
      onProgress({ entries: result.entries, files: result.files.length });
    }
    yield { op: 'yield' }; // cede o laço entre pastas
  }

  result.files.sort((a, b) => compareRel(a.relPath, b.relPath));
  return result;
}

/** Ordem natural por segmento ("Look 2" antes de "Look 10"; as pastas vêm antes dos arquivos irmãos pelo nome). */
function compareRel(a, b) {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const c = collator.compare(sa[i], sb[i]);
    if (c !== 0) return c;
  }
  return sa.length - sb.length;
}

function normalizeOptions(options = {}) {
  const exts = options.exts === null ? null : (options.exts || [LUT_EXT]).map((e) => e.toLowerCase());
  return {
    maxSegments: options.maxSegments || MAX_SEGMENTS,
    exts,
    includeHidden: !!options.includeHidden,
    signal: options.signal || null,
    deadlineMs: options.deadlineMs || 0,
    maxEntries: options.maxEntries || Infinity,
    onProgress: options.onProgress || null
  };
}

const asyncIo = {
  readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
  realpath: (p) => fs.promises.realpath(p),
  stat: (p) => fs.promises.stat(p)
};
const syncIo = {
  readdir: (p) => fs.readdirSync(p, { withFileTypes: true }),
  realpath: (p) => fs.realpathSync.native(p),
  stat: (p) => fs.statSync(p)
};

/**
 * Varre uma pasta em segundo plano, sem bloquear o processo: cede o laço entre pastas e aceita cancelamento.
 * Não segue links simbólicos nem junções; ignora nomes que começam com ponto (arquivos de controle, ".part"),
 * "$Recycle.Bin" e "System Volume Information" (a menos que `includeHidden`).
 * @param {string} root
 * @param {{ maxSegments?: number, exts?: string[]|null, includeHidden?: boolean, signal?: AbortSignal, deadlineMs?: number,
 *   maxEntries?: number, onProgress?: (p: { entries: number, files: number }) => void }} [options]
 *   exts: extensões (minúsculas, com ponto) que contam como LUT; null devolve todos os arquivos.
 * @returns {Promise<{ root: string|null, rootError: Error|null, files: Array<{ relPath: string, abs: string, name: string, folder: string, depth: number, size: number, mtimeMs: number }>, dirs: Array<{ relPath: string, abs: string, depth: number }>, problems: Array<{ relPath: string, code: string, kind: 'dir'|'file' }>, links: Array<{ relPath: string, isDir: boolean }>, ignoredLinks: number, ignoredExt: Object<string, number>, tooDeep: string[], tooDeepCount: number, truncated: boolean, timedOut: boolean, canceled: boolean, entries: number }>}
 */
async function walkTree(root, options) {
  const gen = walkCore(root, normalizeOptions(options));
  let step = gen.next();
  while (!step.done) {
    const req = step.value;
    let value;
    let failure = null;
    try {
      value = req.op === 'yield' ? await sleepTick() : await asyncIo[req.op](req.p);
    } catch (err) {
      failure = err;
    }
    step = failure ? gen.throw(failure) : gen.next(value);
  }
  return step.value;
}

/** Mesma regra de walkTree, de forma síncrona (a lista da coleção). */
function walkTreeSync(root, options) {
  const gen = walkCore(root, normalizeOptions(options));
  let step = gen.next();
  while (!step.done) {
    const req = step.value;
    let value;
    let failure = null;
    try {
      value = req.op === 'yield' ? undefined : syncIo[req.op](req.p);
    } catch (err) {
      failure = err;
    }
    step = failure ? gen.throw(failure) : gen.next(value);
  }
  return step.value;
}

/** Orçamento de caminho real (Windows) menos a folga para ".part" e " (2)". */
function maxRelPathLength(lutsDir) {
  return MAX_PATH_BUDGET - path.resolve(lutsDir).length - 1 - PATH_RESERVE;
}

/**
 * Onde um arquivo de LUT da origem vai parar na coleção (função pura, não toca o disco).
 *  - sem `keepFolders`, só o grupo raiz (se houver) é usado;
 *  - `rootGroup` é UM segmento (validado como nome de pasta);
 *  - subpastas da origem são limpas (caracteres proibidos, nomes reservados) e, acima do limite de níveis, o excedente é
 *    dobrado no último nível permitido com " - " ("a/b/c/d/x.cube" vira "a/b/c - d/x.cube");
 *  - o caminho final precisa caber no limite do Windows e do celular.
 * @param {{ name: string, folder?: string }} item - `folder` relativo à origem, com "/"
 * @param {{ rootGroup?: string|null, keepFolders?: boolean, lutsDir: string }} options
 * @returns {{ ok: true, folders: string[], fileName: string, relPath: string, folded: boolean } | { ok: false, reason: string }}
 */
function planDestination(item, { rootGroup = null, keepFolders = true, lutsDir }) {
  const fileName = String(item.name || '');
  const baseProblem = checkFileBaseName(fileName.replace(/\.cube$/i, ''));
  if (baseProblem) return { ok: false, reason: `Nome de arquivo não aceito: ${baseProblem}` };

  let folders = [];
  if (rootGroup) {
    const problem = checkFolderName(rootGroup);
    if (problem) return { ok: false, reason: problem };
    folders.push(rootGroup);
  }
  if (keepFolders && item.folder) {
    folders.push(...String(item.folder).split('/').filter(Boolean).map((s) => sanitizeFolderSegment(s)));
  }

  const maxFolders = MAX_SEGMENTS - 1;
  let folded = false;
  if (folders.length > maxFolders) {
    const head = folders.slice(0, maxFolders - 1);
    const tail = sanitizeFolderSegment(folders.slice(maxFolders - 1).join(' - '), 150);
    folders = [...head, tail];
    folded = true;
  }

  const relPath = [...folders, fileName].join('/');
  if (relPath.length > maxRelPathLength(lutsDir)) {
    return { ok: false, reason: 'O caminho ficaria longo demais para o Windows. Use uma pasta mais curta ou desligue "Manter as subpastas".' };
  }
  if (relPath.length > PHONE_MAX_PATH) {
    return { ok: false, reason: 'O caminho ficaria longo demais para o celular. Use uma pasta mais curta ou desligue "Manter as subpastas".' };
  }
  return { ok: true, folders, fileName, relPath, folded };
}

module.exports = { walkTree, walkTreeSync, planDestination, compareRel, maxRelPathLength, MAX_REPORTED };
