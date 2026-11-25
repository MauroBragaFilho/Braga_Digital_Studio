'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const CubeParser = require('./CubeParser');
const {
  LUT_EXT, MAX_FILE_BYTES, PHONE_MAX_BYTES, SCAN_MAX_SEGMENTS, SCAN_MAX_ENTRIES, SCAN_DEADLINE_MS, MAX_SCAN_ITEMS, MAX_DROPPED_PATHS
} = require('./lutConstants');
const { sha256, copyFileExclusive } = require('./lutFileOps');
const { checkFolderName } = require('./lutNames');
const { walkTree, planDestination } = require('./lutTree');
const { LutUserError, userMessage } = require('./lutErrors');
const logger = require('../../services/logService');

/**
 * Importação de LUTs em dois tempos, toda no processo principal e sem bloquear o aplicativo:
 *  1. `scan`: procura os .cube (arquivos soltos ou pastas inteiras, com as subpastas), lê cada um UMA vez, valida e
 *     calcula o conteúdo (SHA-256) e devolve um resumo (novas, já existentes, repetidas, inválidas) sem copiar nada;
 *  2. `commit`: copia só o que o usuário marcou, por arquivo temporário conferido, sem nunca sobrescrever.
 * Os caminhos de origem ficam guardados aqui (sessão em memória); a tela só conhece números de item.
 */

const UNC_OR_DEVICE_PATH = /^[\\/]{2}/;
const BIG_FILE_BYTES = 16 * 1024 * 1024;
const READ_CONCURRENCY = 4;
const MAX_FAILURES_REPORTED = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 3;

const MSG_BUSY = 'Há outra operação em andamento.';
const MSG_UNC = 'Pastas de rede não podem ser arrastadas para cá. Use "Importar > Pasta…" para escolhê-las.';
const MSG_IS_COLLECTION = 'Esta já é a pasta das LUTs.';
const MSG_CONTAINS_COLLECTION = 'A pasta escolhida contém a pasta das LUTs. Escolha uma pasta mais específica.';
const MSG_EXPIRED = 'A lista de LUTs encontrada expirou. Procure as LUTs de novo.';
const MSG_STARTED = 'Esta importação já foi iniciada.';

/** Chama `cb` no máximo a cada `interval` ms (a menos que `force`); um ouvinte com erro nunca derruba a operação. */
function makeEmitter(cb, interval = 100) {
  let last = 0;
  return (payload, force = false) => {
    if (!cb) return;
    const now = Date.now();
    if (!force && now - last < interval) return;
    last = now;
    try { cb(payload); } catch { /* ouvinte fechado */ }
  };
}

/**
 * Fila para o trabalho de CPU (validar e calcular o conteúdo): um arquivo por vez, cada um em uma volta própria do laço,
 * para que os arquivos lidos em paralelo não monopolizem o processo principal.
 */
function makeCpuLane() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => new Promise((resolve, reject) => {
      setImmediate(() => { try { resolve(fn()); } catch (err) { reject(err); } });
    }));
    tail = run.catch(() => {});
    return run;
  };
}

/** `child` é a própria `parent` ou está dentro dela (caminhos já resolvidos; o Windows não diferencia maiúsculas). */
function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class LutImporter {
  /**
   * @param {import('./LutManager')} lutManager
   * @param {{ sessionTtlMs?: number, maxSessions?: number }} [options]
   */
  constructor(lutManager, { sessionTtlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this.manager = lutManager;
    this.sessionTtlMs = sessionTtlMs;
    this.maxSessions = maxSessions;
    this._sessions = new Map();   // scanId -> { createdAt, items, sourceName }
    this._consumed = new Set();   // scanIds já usados em importScanned (recusa o segundo commit)
    this._running = new Map();    // id -> { kind: 'scan'|'import', controller }
  }

  _pruneSessions() {
    const now = Date.now();
    for (const [id, session] of this._sessions) if (now - session.createdAt > this.sessionTtlMs) this._sessions.delete(id);
    while (this._sessions.size > this.maxSessions) this._sessions.delete(this._sessions.keys().next().value);
  }

  /**
   * Interpreta os caminhos de origem: pastas, arquivos .cube soltos e o que será ignorado. Arrastar-e-soltar é a única
   * entrada de caminho vinda da tela: precisa ser absoluto e nunca de rede (UNC). Caminhos escolhidos no diálogo do
   * sistema (`source: 'dialog'`) são confiáveis.
   */
  async _resolveSources(paths, source) {
    if (paths.length > MAX_DROPPED_PATHS) throw new LutUserError(`Muitos itens de uma vez (máximo de ${MAX_DROPPED_PATHS}).`);
    const out = { dirs: [], files: [], ignored: 0, ignored3dl: 0 };
    for (const p of paths) {
      if (typeof p !== 'string' || p === '' || p.includes('\0')) { out.ignored++; continue; }
      if (source === 'drop' && UNC_OR_DEVICE_PATH.test(p)) throw new LutUserError(MSG_UNC);
      if (!path.isAbsolute(p)) { out.ignored++; continue; }
      let real;
      let stats;
      try {
        real = await fs.promises.realpath(p);
        stats = await fs.promises.stat(real);
      } catch {
        out.ignored++;
        continue;
      }
      if (stats.isDirectory()) {
        const name = path.basename(real) || path.parse(real).root.replace(/[\\/:]+/g, '') || 'LUTs';
        out.dirs.push({ real, name });
      } else if (stats.isFile() && path.extname(real).toLowerCase() === LUT_EXT) {
        out.files.push({ abs: real, name: path.basename(p), folder: '', size: stats.size, mtimeMs: stats.mtimeMs });
      } else if (path.extname(real).toLowerCase() === '.3dl') {
        out.ignored3dl++; // conta à parte: o resumo avisa que só .cube é aceito
      } else {
        out.ignored++;
      }
    }
    return out;
  }

  /**
   * Procura as LUTs e devolve o resumo (nada é copiado).
   * @param {{ paths: string[], source?: 'dialog'|'drop', onProgress?: (p: object) => void }} args
   * @returns {Promise<{ canceled: true } | { scanId: string, sourceName: string|null, hasFolders: boolean, summary: object, items: Array<object> }>}
   *   items: { key, name, folder, relPath, size, status: 'new'|'exists'|'repeated'|'invalid', reason, existsAs, warning }
   */
  async scan({ paths, source = 'dialog', onProgress = null }) {
    if (!Array.isArray(paths) || paths.length === 0) throw new LutUserError('Escolha ao menos um arquivo ou pasta.');
    if ([...this._running.values()].some((r) => r.kind === 'scan')) throw new LutUserError(MSG_BUSY);

    const scanId = crypto.randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    this._running.set(scanId, { kind: 'scan', controller });
    const emit = makeEmitter(onProgress);
    emit({ scanId, phase: 'start' }, true);
    try {
      const sources = await this._resolveSources(paths, source);

      let collectionReal;
      try { collectionReal = await fs.promises.realpath(this.manager.lutsDir); } catch { collectionReal = path.resolve(this.manager.lutsDir); }
      for (const dir of sources.dirs) {
        if (isSameOrInside(dir.real, collectionReal)) throw new LutUserError(MSG_IS_COLLECTION);
        if (isSameOrInside(collectionReal, dir.real)) throw new LutUserError(MSG_CONTAINS_COLLECTION);
      }

      // 1. Arquivos .cube de cada pasta (as subpastas contam; links nunca são seguidos)
      const single = sources.dirs.length === 1 && sources.files.length === 0;
      const sourceName = single ? sources.dirs[0].name : null;
      const candidates = [];
      const seen = new Set();
      const add = (c) => {
        const key = process.platform === 'win32' ? c.abs.toLowerCase() : c.abs;
        if (seen.has(key)) return false;
        seen.add(key);
        candidates.push(c);
        return true;
      };
      const tally = { ignored3dl: sources.ignored3dl, ignoredOther: sources.ignored, ignoredLinks: 0, truncated: false, timedOut: false, tooDeep: 0 };
      for (const dir of sources.dirs) {
        const walk = await walkTree(dir.real, {
          maxSegments: SCAN_MAX_SEGMENTS, exts: [LUT_EXT], signal, deadlineMs: SCAN_DEADLINE_MS, maxEntries: SCAN_MAX_ENTRIES,
          onProgress: ({ files }) => emit({ scanId, phase: 'walk', found: candidates.length + files })
        });
        if (walk.canceled) return { canceled: true };
        for (const file of walk.files) {
          add({ abs: file.abs, name: file.name, folder: single ? file.folder : [dir.name, file.folder].filter(Boolean).join('/'), size: file.size, mtimeMs: file.mtimeMs });
        }
        const others = Object.entries(walk.ignoredExt);
        tally.ignored3dl += walk.ignoredExt['.3dl'] || 0;
        tally.ignoredOther += others.reduce((sum, [ext, n]) => sum + (ext === '.3dl' ? 0 : n), 0);
        tally.ignoredLinks += walk.ignoredLinks;
        tally.tooDeep += walk.tooDeepCount;
        tally.truncated = tally.truncated || walk.truncated;
        tally.timedOut = tally.timedOut || walk.timedOut;
      }
      for (const file of sources.files) add(file);
      emit({ scanId, phase: 'walk', found: candidates.length }, true);

      // 2. Conteúdo que a coleção já tem (índice construído uma vez)
      emit({ scanId, phase: 'collection', found: candidates.length }, true);
      const collection = await this.manager.hashIndex({ signal });
      if (signal.aborted) return { canceled: true };

      // 3. Cada arquivo é lido uma única vez: validação e hash saem do mesmo conteúdo
      const info = new Array(candidates.length);
      const cpu = makeCpuLane();
      const readOne = async (index) => {
        const c = candidates[index];
        if (c.size > MAX_FILE_BYTES) { info[index] = { ok: false, reason: CubeParser.validate(c.abs).reason }; return; }
        let data;
        try {
          data = await fs.promises.readFile(c.abs);
        } catch {
          info[index] = { ok: false, reason: 'Não foi possível ler este arquivo.' };
          return;
        }
        info[index] = await cpu(() => {
          const check = CubeParser.validate(data);
          return check.ok ? { ok: true, hash: sha256(data) } : { ok: false, reason: check.reason };
        });
      };
      let next = 0;
      while (next < candidates.length) {
        if (signal.aborted) return { canceled: true };
        const batch = [];
        if (candidates[next].size > BIG_FILE_BYTES) {
          batch.push(next++); // arquivo grande é lido sozinho
        } else {
          while (next < candidates.length && batch.length < READ_CONCURRENCY && candidates[next].size <= BIG_FILE_BYTES) batch.push(next++);
        }
        await Promise.all(batch.map(readOne));
        emit({ scanId, phase: 'read', processed: next, total: candidates.length, found: candidates.length }, next >= candidates.length);
      }

      // 4. Classificação, na ordem da lista (a primeira cópia de um conteúdo é a "nova"; as seguintes são "repetidas")
      const summary = {
        found: candidates.length, new: 0, exists: 0, repeated: 0, invalid: 0,
        ignored3dl: tally.ignored3dl, ignoredOther: tally.ignoredOther, ignoredLinks: tally.ignoredLinks,
        truncated: tally.truncated, timedOut: tally.timedOut, tooDeepSkipped: tally.tooDeep,
        maxFolderDepth: 0, bigForPhone: 0, omitted: Math.max(0, candidates.length - MAX_SCAN_ITEMS)
      };
      const firstOfHash = new Map();
      const items = [];
      candidates.forEach((c, index) => {
        const item = {
          key: index, abs: c.abs, name: c.name, folder: c.folder, size: c.size, hash: null,
          status: 'invalid', reason: null, existsAs: null, warning: null
        };
        const result = info[index];
        if (!result.ok) {
          item.reason = result.reason;
          summary.invalid++;
        } else if (collection.has(result.hash)) {
          item.status = 'exists';
          item.existsAs = collection.get(result.hash)[0];
          summary.exists++;
        } else if (firstOfHash.has(result.hash)) {
          item.status = 'repeated';
          item.existsAs = firstOfHash.get(result.hash);
          summary.repeated++;
        } else {
          item.status = 'new';
          item.hash = result.hash;
          firstOfHash.set(result.hash, [c.folder, c.name].filter(Boolean).join('/'));
          summary.new++;
          if (c.folder) summary.maxFolderDepth = Math.max(summary.maxFolderDepth, c.folder.split('/').length);
          if (c.size > PHONE_MAX_BYTES) { item.warning = 'O celular não recebe esta LUT (acima de 32 MB); ela fica só no computador.'; summary.bigForPhone++; }
        }
        if (items.length < MAX_SCAN_ITEMS) items.push(item);
      });

      this._pruneSessions();
      this._sessions.set(scanId, { createdAt: Date.now(), items, sourceName });
      this._pruneSessions();
      return {
        scanId,
        sourceName,
        hasFolders: !!sourceName || items.some((i) => i.folder),
        summary,
        items: items.map((i) => ({
          key: i.key, name: i.name, folder: i.folder, relPath: [i.folder, i.name].filter(Boolean).join('/'), size: i.size,
          status: i.status, reason: i.reason, existsAs: i.existsAs, warning: i.warning
        }))
      };
    } finally {
      this._running.delete(scanId);
    }
  }

  /**
   * Cancela a varredura (a de `scanId`, ou todas se não vier id) e descarta o resumo guardado.
   * @param {string} [scanId]
   * @returns {true}
   */
  cancelScan(scanId) {
    for (const [id, run] of this._running) {
      if (run.kind === 'scan' && (!scanId || id === scanId)) run.controller.abort();
    }
    if (scanId) this._sessions.delete(scanId);
    return true;
  }

  /** Cancela a importação em andamento (a de `scanId`, ou todas se não vier id): termina o arquivo atual e para. */
  cancelImport(scanId) {
    for (const [id, run] of this._running) {
      if (run.kind === 'import' && (!scanId || id === scanId)) run.controller.abort();
    }
    return true;
  }

  /**
   * Copia para a coleção as LUTs marcadas de um resumo. A sessão é consumida na hora: um segundo pedido para o mesmo
   * resumo é recusado. Toda a escrita roda sob a trava única da coleção e o índice de conteúdo é refeito lá dentro
   * (o do resumo pode estar velho), então duas importações nunca duplicam uma LUT.
   * Cada arquivo: lido uma vez, conferido contra o hash do resumo, gravado em arquivo temporário, conferido de novo e
   * só então publicado, sem sobrescrever. Falha em um arquivo não derruba o lote. Cancelar termina o arquivo atual,
   * mantém o que já foi copiado.
   * @param {string} scanId
   * @param {number[]} keys - itens marcados (só os "new" são importados)
   * @param {{ keepFolders?: boolean, rootGroup?: string|null }} [options]
   * @param {{ onProgress?: (p: object) => void }} [hooks]
   * @returns {Promise<{ imported: number, renamed: number, skippedChanged: number, failed: number, exists: number, canceled: boolean, groupsCreated: number, total: number, firstImported: {relPath: string, path: string}|null, failures: Array<{name: string, reason: string}> }>}
   */
  async commit(scanId, keys, { keepFolders = true, rootGroup = null } = {}, { onProgress = null } = {}) {
    if (rootGroup) {
      const problem = checkFolderName(rootGroup);
      if (problem) throw new LutUserError(problem);
    }
    if (!Array.isArray(keys) || !keys.every((k) => Number.isInteger(k) && k >= 0)) throw new LutUserError('Seleção inválida.');
    const session = this._sessions.get(scanId);
    if (!session || Date.now() - session.createdAt > this.sessionTtlMs) {
      this._sessions.delete(scanId);
      throw new LutUserError(this._consumed.has(scanId) ? MSG_STARTED : MSG_EXPIRED);
    }
    this._sessions.delete(scanId); // consumida agora: um segundo clique não importa de novo
    this._consumed.add(scanId);
    if (this._consumed.size > 50) this._consumed.delete(this._consumed.keys().next().value);

    const wanted = new Set(keys);
    const chosen = session.items.filter((item) => wanted.has(item.key) && item.status === 'new');
    const emit = makeEmitter(onProgress);
    const controller = new AbortController();
    const result = {
      imported: 0, renamed: 0, skippedChanged: 0, failed: 0, exists: 0, canceled: false, groupsCreated: 0,
      total: chosen.length, firstImported: null, failures: []
    };
    const fail = (name, reason) => { if (result.failures.length < MAX_FAILURES_REPORTED) result.failures.push({ name, reason }); };

    try {
      await this.manager.withLock(async () => {
        this._running.set(scanId, { kind: 'import', controller });
        const index = await this.manager.hashIndex({ signal: controller.signal });
        for (let n = 0; n < chosen.length; n++) {
          if (controller.signal.aborted) { result.canceled = true; break; }
          const item = chosen[n];
          emit({ scanId, phase: 'import', done: n, total: chosen.length, current: item.name });
          try {
            const stats = await fs.promises.stat(item.abs);
            if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new LutUserError('O arquivo mudou durante a importação.');
            const data = await fs.promises.readFile(item.abs);
            if (sha256(data) !== item.hash || !CubeParser.validate(data).ok) {
              result.skippedChanged++;
              fail(item.name, 'O arquivo mudou durante a importação; nada foi copiado.');
              continue;
            }
            if (index.has(item.hash)) { result.exists++; continue; }

            const plan = planDestination(item, { rootGroup, keepFolders, lutsDir: this.manager.lutsDir });
            if (!plan.ok) { result.failed++; fail(item.name, plan.reason); continue; }
            const { dir, created } = this.manager.ensureFolders(plan.folders);
            result.groupsCreated += created;
            const copy = copyFileExclusive(data, dir, plan.fileName);
            const relPath = [...plan.folders, copy.name].join('/');
            index.set(item.hash, [relPath]);
            this.manager.noteHash(copy.path, item.hash);
            result.imported++;
            if (copy.name !== plan.fileName) result.renamed++;
            if (!result.firstImported) result.firstImported = { relPath, path: copy.path };
          } catch (err) {
            result.failed++;
            logger.warn('LutImporter:commit:arquivo_falhou', { name: item.name, error: err && err.message });
            fail(item.name, userMessage(err, 'Não foi possível copiar este arquivo.'));
          }
        }
      });
    } catch (err) {
      if (err instanceof LutUserError && err.message === MSG_BUSY) {
        // Outra operação está rodando: devolve o resumo para a pessoa tentar de novo em seguida.
        this._sessions.set(scanId, session);
        this._consumed.delete(scanId);
      }
      throw err;
    } finally {
      this._running.delete(scanId);
    }
    emit({ scanId, phase: 'import', done: result.imported + result.failed + result.exists + result.skippedChanged, total: chosen.length }, true);
    return result;
  }
}

module.exports = LutImporter;
module.exports.MSG_BUSY = MSG_BUSY;
