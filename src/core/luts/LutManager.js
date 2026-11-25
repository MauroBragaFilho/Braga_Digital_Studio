'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PathGuard } = require('../../infrastructure/filesystem/PathGuard');
const CubeParser = require('./CubeParser');
const {
  LUT_EXT, MAX_FILE_BYTES, MAX_SEGMENTS, MAX_PATH_BUDGET, PATH_RESERVE, PHONE_MAX_PATH, COLLECTION_MAX_ENTRIES
} = require('./lutConstants');
const { hashFile, sha256, copyFileExclusive, indexByHash, sweepPartials } = require('./lutFileOps');
const { checkFileBaseName, checkFolderName, isSafeSegment, sanitizeFolderSegment } = require('./lutNames');
const { walkTree, walkTreeSync } = require('./lutTree');
const { LutUserError } = require('./lutErrors');
const logger = require('../../services/logService');

/** Arquivo (não-.cube) que registra quais LUTs embutidas já foram instaladas, para não recriar as que o usuário excluiu. */
const BUNDLED_MARKER = '.bundled-installed.json';
/** Cache persistente do conteúdo (hash) de cada LUT, por caminho relativo + tamanho + data. Começa com ponto: nunca é listado. */
const HASH_CACHE_FILE = '.hash-cache.json';
const HASH_CACHE_VERSION = 1;
const HASH_CACHE_PERSIST_MS = 750;
const HEX64 = /^[0-9a-f]{64}$/;
const IS_WIN = process.platform === 'win32';

const MSG_NOT_INSIDE = 'Esta LUT não está na pasta de LUTs.';
const MSG_NOT_FOUND = 'A LUT não foi encontrada na pasta.';
const MSG_FOLDER_NOT_INSIDE = 'Esta pasta não está na pasta de LUTs.';
const MSG_FOLDER_GONE = 'Esta pasta não existe mais.';
const MSG_BUSY = 'Há outra operação em andamento.';
const MSG_COLLECTION_UNAVAILABLE = 'Não foi possível acessar a pasta de LUTs. Confira se há espaço no disco e tente de novo.';
const MSG_TOO_DEEP = `Pasta funda demais (o limite é ${MAX_SEGMENTS - 1} níveis de pastas): as LUTs dela não são listadas nem sincronizadas.`;

/**
 * LutManager — Gerenciamento de arquivos e operações com LUTs (.cube).
 */
class LutManager {
  /**
   * @param {string} lutsDir - Diretório onde as LUTs são armazenadas
   */
  constructor(lutsDir) {
    this.lutsDir = lutsDir;
    this._hashes = null;      // Map caminhoRelativo -> { key: 'tamanho:mtime', hash } (carregado do disco sob demanda)
    this._headers = null;     // Map caminhoRelativo -> { key: 'tamanho:mtime', kind, lutSize, title } (cabeçalho curto; mesmo arquivo de cache)
    this._hashesDirty = false;
    this._persistTimer = null;
    this._hashFill = null;    // Promise do preenchimento em segundo plano (uma por vez)
    this._inflightHashes = new Map(); // caminho -> Promise do hash em andamento (duas chamadas não leem o mesmo arquivo juntas)
    this._busy = false;       // trava única de escrita (withLock)
    this._busyDone = null;
  }

  /**
   * Trava única de escrita na coleção: importar, renomear ou excluir pastas nunca se sobrepõem. Quem chega com a
   * trava ocupada recebe "Há outra operação em andamento." (ou, com `wait`, espera a sua vez).
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ wait?: boolean }} [options]
   * @returns {Promise<T>}
   */
  async withLock(fn, { wait = false } = {}) {
    while (this._busy) {
      if (!wait) throw new LutUserError(MSG_BUSY);
      await this._busyDone;
    }
    this._busy = true;
    let release;
    this._busyDone = new Promise((resolve) => { release = resolve; });
    try {
      return await fn();
    } finally {
      this._busy = false;
      release();
    }
  }

  /** Apaga os temporários ".part" esquecidos por uma cópia interrompida (mais velhos que uma hora). */
  sweepPartials() {
    return sweepPartials(this.lutsDir).catch((err) => {
      logger.warn('LutManager:sweepPartials:falhou', { error: err.message });
      return 0;
    });
  }

  /** Nomes dos .cube (arquivos comuns, sem ponto no início) da pasta de origem e, se não houver nenhum, o motivo. */
  _readBundledNames(bundledLutsDir) {
    if (typeof bundledLutsDir !== 'string' || !bundledLutsDir) return { names: [], reason: 'caminho da pasta não informado' };
    try {
      const names = fs.readdirSync(bundledLutsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith(LUT_EXT))
        .map((e) => e.name)
        .sort();
      return { names, reason: names.length ? null : 'pasta sem arquivos .cube' };
    } catch (err) {
      return { names: [], reason: err.code === 'ENOENT' ? 'pasta não existe' : `pasta ilegível (${err.code || err.message})` };
    }
  }

  /**
   * Copia LUTs embutidas no pacote para o diretório gravável de LUTs do usuário.
   * - cada LUT embutida é instalada uma única vez: se o usuário a excluir, ela não volta (marcador
   *   `.bundled-installed.json`, lista de nomes);
   * - nunca sobrescreve: arquivo de mesmo nome já na coleção é mantido; conteúdo idêntico (SHA-256) já presente em
   *   qualquer subpasta também não é recriado na raiz;
   * - a cópia vai por arquivo temporário, conferida por tamanho e hash (ver lutFileOps.copyFileExclusive);
   * - falha em um arquivo não impede os demais; o que falhou não entra no marcador e é tentado de novo na próxima vez;
   * - origem ausente ou vazia é registrada no log (uma vez por execução) e devolvida em `missingSource`.
   * @param {string} bundledLutsDir - Diretório de origem das LUTs embutidas
   * @returns {{ installed: number, skipped: number, alreadyThere: number, failed: number, missingSource: boolean }}
   *   installed: copiadas agora; skipped: já instaladas antes (marcador); alreadyThere: já existiam (mesmo nome ou
   *   mesmo conteúdo); failed: não foi possível copiar.
   */
  ensureBundledLuts(bundledLutsDir) {
    const result = { installed: 0, skipped: 0, alreadyThere: 0, failed: 0, missingSource: false };
    const { names, reason } = this._readBundledNames(bundledLutsDir);
    if (!names.length) {
      result.missingSource = true;
      if (!this._warnedMissingBundled) {
        this._warnedMissingBundled = true;
        logger.warn('LutManager:ensureBundledLuts:origem_ausente', { dir: bundledLutsDir, motivo: reason });
      }
      return result;
    }

    let done = new Set();
    const markerPath = path.join(this.lutsDir, BUNDLED_MARKER);
    try {
      fs.mkdirSync(this.lutsDir, { recursive: true });
      let previous = [];
      try { previous = JSON.parse(fs.readFileSync(markerPath, 'utf-8')); } catch { /* primeira execução */ }
      if (Array.isArray(previous)) done = new Set(previous.filter((n) => typeof n === 'string'));

      const pending = names.filter((n) => !done.has(n));
      result.skipped = names.length - pending.length;
      if (!pending.length) return result;

      // Índice por conteúdo só dos tamanhos que interessam (poupa ler a coleção inteira).
      const sizes = new Set();
      const sourceSize = new Map();
      for (const name of pending) {
        try { const size = fs.statSync(path.join(bundledLutsDir, name)).size; sourceSize.set(name, size); sizes.add(size); } catch { /* falha tratada no laço */ }
      }
      const known = indexByHash(this.lutsDir, sizes);

      try {
        for (const name of pending) {
          try {
            const source = path.join(bundledLutsDir, name);
            if (fs.existsSync(path.join(this.lutsDir, name))) { result.alreadyThere++; done.add(name); continue; }
            const hash = hashFile(source);
            if (known.has(hash)) { result.alreadyThere++; done.add(name); continue; }
            const copy = copyFileExclusive(source, this.lutsDir, name, { exact: true });
            if (copy.status === 'copied') result.installed++; else result.alreadyThere++;
            known.set(hash, name);
            done.add(name);
          } catch (err) {
            result.failed++;
            logger.warn('LutManager:ensureBundledLuts:arquivo_falhou', { name, error: err.message });
          }
        }
      } finally {
        // Marcador só com o que foi concluído (mesmo se algo interromper o laço): a LUT que falhou é tentada de novo.
        try {
          const temp = `${markerPath}.tmp`;
          fs.writeFileSync(temp, JSON.stringify([...done]), 'utf-8');
          fs.renameSync(temp, markerPath);
        } catch (err) {
          logger.warn('LutManager:ensureBundledLuts:marcador_nao_gravado', { error: err.message });
        }
      }
    } catch (err) {
      logger.error('LutManager:ensureBundledLuts:error', { error: err.message });
    }
    return result;
  }

  /**
   * "Restaurar LUTs padrão" (ação explícita do usuário nas Configurações): copia de volta as LUTs embutidas que
   * faltam na coleção. Nunca apaga nem sobrescreve nada: pula a LUT cujo nome já existe (mesmo que o arquivo tenha sido
   * editado) e a LUT cujo conteúdo (SHA-256) já existe em qualquer ponto da coleção, inclusive em subpasta. Ignora o
   * marcador de "já instaladas" (é justamente para quem excluiu uma) e o atualiza no fim. Roda dentro da trava de escrita.
   * @param {string} bundledLutsDir - Diretório de origem das LUTs embutidas
   * @returns {Promise<{ restored: number, alreadyThere: number, failed: number, missingSource: boolean }>}
   */
  restoreBundled(bundledLutsDir) {
    return this.withLock(async () => {
      const result = { restored: 0, alreadyThere: 0, failed: 0, missingSource: false };
      const { names, reason } = this._readBundledNames(bundledLutsDir);
      if (!names.length) {
        result.missingSource = true;
        logger.warn('LutManager:restoreBundled:origem_ausente', { dir: bundledLutsDir, motivo: reason });
        return result;
      }
      fs.mkdirSync(this.lutsDir, { recursive: true });
      const markerPath = path.join(this.lutsDir, BUNDLED_MARKER);
      let done = new Set();
      try {
        const previous = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
        if (Array.isArray(previous)) done = new Set(previous.filter((n) => typeof n === 'string'));
      } catch { /* sem marcador */ }

      const index = await this.hashIndex();
      try {
        for (const name of names) {
          try {
            const source = path.join(bundledLutsDir, name);
            const info = fs.lstatSync(source);
            if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('origem inválida');
            const data = fs.readFileSync(source);
            const hash = sha256(data);
            if (fs.existsSync(path.join(this.lutsDir, name)) || index.has(hash)) { result.alreadyThere++; done.add(name); continue; }
            const copy = copyFileExclusive(data, this.lutsDir, name, { exact: true });
            if (copy.status === 'copied') {
              result.restored++;
              this.noteHash(copy.path, hash);
              index.set(hash, [name]);
            } else {
              result.alreadyThere++;
            }
            done.add(name);
          } catch (err) {
            result.failed++;
            logger.warn('LutManager:restoreBundled:arquivo_falhou', { name, error: err.message });
          }
        }
      } finally {
        try {
          const temp = `${markerPath}.tmp`;
          fs.writeFileSync(temp, JSON.stringify([...done]), 'utf-8');
          fs.renameSync(temp, markerPath);
        } catch (err) {
          logger.warn('LutManager:restoreBundled:marcador_nao_gravado', { error: err.message });
        }
      }
      return result;
    });
  }

  /**
   * Resumo da coleção para as Configurações: pasta, quantas LUTs, em quantas pastas (as que têm LUTs, qualquer nível),
   * o que a lista não conseguiu ler e se há LUTs embutidas para restaurar.
   * @param {string} [bundledLutsDir]
   * @returns {{ folder: string, count: number, groups: number, problems: Array<{ name: string, reason: string }>, problemCount: number, bundledAvailable: boolean }}
   */
  getInfo(bundledLutsDir) {
    const { items, problems } = this.listDetailed();
    const folders = new Set();
    for (const item of items) if (item.folder) folders.add(item.folder);
    return {
      folder: this.lutsDir,
      count: items.length,
      groups: folders.size,
      problems: problems.slice(0, 20).map((p) => ({ name: p.name, reason: p.reason })),
      problemCount: problems.length,
      bundledAvailable: this._readBundledNames(bundledLutsDir).names.length > 0
    };
  }

  // ─── Identificação por conteúdo (hash) ─────────────────────────────────────────────────────────
  // O hash (SHA-256 do conteúdo) nunca é calculado de forma síncrona na listagem: a lista devolve o que já está no
  // cache (caminho relativo + tamanho + data, gravado em `.hash-cache.json`) e o resto é preenchido em segundo
  // plano, um arquivo por vez. Nada na interface depende dele; o `id` curto é só um rótulo.

  /** Caminho relativo à coleção, com "/" como separador. */
  _relPath(abs) {
    return path.relative(this.lutsDir, abs).split(path.sep).join('/');
  }

  _loadHashes() {
    if (this._hashes) return this._hashes;
    const map = new Map();
    const headers = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.lutsDir, HASH_CACHE_FILE), 'utf-8'));
      if (data && data.version === HASH_CACHE_VERSION && data.entries && typeof data.entries === 'object') {
        for (const [rel, e] of Object.entries(data.entries)) {
          if (e && typeof e.key === 'string' && typeof e.hash === 'string' && HEX64.test(e.hash)) map.set(rel, { key: e.key, hash: e.hash });
        }
      }
      if (data && data.version === HASH_CACHE_VERSION && data.headers && typeof data.headers === 'object') {
        for (const [rel, e] of Object.entries(data.headers)) {
          if (!e || typeof e.key !== 'string') continue;
          const kind = e.kind === '1D' || e.kind === '3D' ? e.kind : null;
          const lutSize = Number.isInteger(e.lutSize) && e.lutSize > 0 ? e.lutSize : null;
          const title = typeof e.title === 'string' ? e.title.slice(0, 200) : null;
          headers.set(rel, { key: e.key, kind, lutSize, title });
        }
      }
    } catch { /* sem cache ou ilegível: os hashes e os cabeçalhos são recalculados */ }
    this._hashes = map;
    this._headers = headers;
    return map;
  }

  /**
   * Tipo (1D/3D), tamanho e título de uma LUT da lista, lidos só do começo do arquivo e guardados no cache (caminho
   * relativo + tamanho + data), junto do cache de hash. Nunca interpreta a tabela inteira.
   * @param {{ abs: string, relPath: string, size: number, mtimeMs: number }} file
   */
  _headerOf(file) {
    this._loadHashes();
    const key = `${file.size}:${file.mtimeMs}`;
    const hit = this._headers.get(file.relPath);
    if (hit && hit.key === key) return hit;
    const head = CubeParser.readHeaderQuick(file.abs);
    const entry = { key, kind: head ? head.kind : null, lutSize: head ? head.lutSize : null, title: head ? head.title : null };
    this._headers.set(file.relPath, entry);
    this._schedulePersist();
    return entry;
  }

  /** Hash já conhecido para o arquivo (mesmo tamanho e data), ou null. */
  _cachedHash(abs, stats) {
    const hit = this._loadHashes().get(this._relPath(abs));
    return hit && hit.key === `${stats.size}:${stats.mtimeMs}` ? hit.hash : null;
  }

  _schedulePersist() {
    this._hashesDirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.flushHashCache(); }, HASH_CACHE_PERSIST_MS);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  /** Grava o cache de hash no disco (arquivo temporário + renomear). Falha de gravação não afeta a coleção. */
  flushHashCache() {
    if (!this._hashesDirty || !this._hashes) return;
    this._hashesDirty = false;
    try {
      if (!fs.existsSync(this.lutsDir)) return;
      const target = path.join(this.lutsDir, HASH_CACHE_FILE);
      const temp = `${target}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({
        version: HASH_CACHE_VERSION,
        entries: Object.fromEntries(this._hashes),
        headers: Object.fromEntries(this._headers || [])
      }), 'utf-8');
      fs.renameSync(temp, target);
    } catch (err) {
      logger.warn('LutManager:hashCache:nao_gravado', { error: err.message });
    }
  }

  /**
   * SHA-256 (hex) do conteúdo de uma LUT, lido em fluxo (sem bloquear o processo) e guardado no cache.
   * Arquivo acima do limite de tamanho, ilegível ou alterado durante a leitura: devolve null (e não guarda).
   * @param {string} filePath
   * @returns {Promise<string|null>}
   */
  hashOfAsync(filePath) {
    const running = this._inflightHashes.get(filePath);
    if (running) return running;
    const promise = this._hashOfAsyncNow(filePath).finally(() => this._inflightHashes.delete(filePath));
    this._inflightHashes.set(filePath, promise);
    return promise;
  }

  async _hashOfAsyncNow(filePath) {
    let before;
    try { before = await fs.promises.stat(filePath); } catch { return null; }
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return null;
    const cached = this._cachedHash(filePath, before);
    if (cached) return cached;

    const hash = await new Promise((resolve) => {
      const digest = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => digest.update(chunk));
      stream.on('error', () => resolve(null));
      stream.on('end', () => resolve(digest.digest('hex')));
    });
    if (!hash) return null;
    let after;
    try { after = await fs.promises.stat(filePath); } catch { return null; }
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null; // mudou durante a leitura
    this._loadHashes().set(this._relPath(filePath), { key: `${before.size}:${before.mtimeMs}`, hash });
    this._schedulePersist();
    return hash;
  }

  /** Calcula, em segundo plano e um arquivo por vez, o hash das LUTs que ainda não estão no cache. */
  _fillHashes(items) {
    if (this._hashFill) return;
    const pending = items.filter((item) => !item.hash);
    if (!pending.length) return;
    this._hashFill = (async () => {
      try {
        for (const item of pending) await this.hashOfAsync(item.path);
      } catch (err) {
        logger.warn('LutManager:hashFill:falhou', { error: err.message });
      } finally {
        this._hashFill = null;
      }
    })();
  }

  /** Remove do cache os arquivos que não existem mais na coleção. */
  _pruneHashes(items) {
    const cache = this._loadHashes();
    const present = new Set(items.map((item) => item.relPath));
    for (const rel of [...cache.keys()]) {
      if (!present.has(rel)) { cache.delete(rel); this._schedulePersist(); }
    }
    for (const rel of [...this._headers.keys()]) {
      if (!present.has(rel)) { this._headers.delete(rel); this._schedulePersist(); }
    }
  }

  // ─── Listagem ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Lista as LUTs da coleção, incluindo as subpastas (até MAX_SEGMENTS níveis contando o arquivo). Tolerante: um
   * arquivo ou pasta problemático nunca esconde os demais; o que não pôde ser lido vai para `problems`. Só entram
   * arquivos comuns terminados em ".cube" (atalhos, links, pasta chamada "x.cube" e arquivo que sumiu durante a
   * leitura ficam de fora); nomes que começam com ponto (arquivos de controle) são ignorados.
   * @returns {{ items: Array<{ id: string|null, hash: string|null, kind: '1D'|'3D'|null, lutSize: number|null, title: string|null, name: string, displayName: string, path: string, relPath: string, folder: string, depth: number, size: number, mtime: Date, modifiedAt: number }>, problems: Array<{ name: string, reason: string }> }}
   *   folder: caminho da subpasta dentro da coleção, com "/" ('' na raiz); depth: quantos níveis de pasta (0 na raiz);
   *   kind, lutSize e title: lidos só do começo do arquivo (cabeçalho curto, em cache), nunca da tabela inteira.
   */
  listDetailed() {
    const problems = [];
    const walk = walkTreeSync(this.lutsDir, { maxSegments: MAX_SEGMENTS, exts: [LUT_EXT], maxEntries: COLLECTION_MAX_ENTRIES });
    if (walk.rootError) {
      if (walk.rootError.code !== 'ENOENT') {
        logger.error('LutManager:list:failed', { error: walk.rootError.message });
        problems.push({ name: '', reason: 'Não foi possível ler a pasta de LUTs.' });
      }
      return { items: [], problems };
    }
    const items = [];
    for (const file of walk.files) {
      const hash = this._cachedHash(file.abs, file);
      const head = this._headerOf(file);
      items.push({
        id: hash ? hash.slice(0, 16) : null,
        hash,
        kind: head.kind,       // '3D', '1D' ou null (cabeçalho sem tamanho legível nos primeiros 8 KB)
        lutSize: head.lutSize,
        title: head.title,
        name: file.name,
        displayName: file.name.slice(0, -LUT_EXT.length),
        path: file.abs,
        relPath: file.relPath,
        folder: file.folder,
        depth: file.depth,
        size: file.size,
        mtime: new Date(file.mtimeMs),
        modifiedAt: file.mtimeMs // a tela de LUTs ordena e exibe a data por este campo
      });
    }
    for (const p of walk.problems) {
      if (p.relPath === '' && p.kind === 'dir') {
        logger.error('LutManager:list:failed', { code: p.code });
        problems.push({ name: '', reason: 'Não foi possível ler a pasta de LUTs.' });
        continue;
      }
      logger.warn('LutManager:list:entrada_ilegivel', { relPath: p.relPath, code: p.code });
      problems.push({ name: p.relPath, reason: p.kind === 'dir' ? 'Não foi possível ler esta pasta.' : 'Não foi possível ler este arquivo.' });
    }
    for (const link of walk.links) {
      if (link.isDir) problems.push({ name: link.relPath, reason: 'Atalho (link) para uma pasta não é listado. Mova a pasta para dentro da pasta de LUTs.' });
      else if (link.relPath.toLowerCase().endsWith(LUT_EXT)) problems.push({ name: link.relPath, reason: 'Atalho (link) não é listado. Copie o arquivo para a pasta de LUTs.' });
    }
    for (const rel of walk.tooDeep) problems.push({ name: rel, reason: MSG_TOO_DEEP });
    if (walk.truncated) {
      problems.push({ name: '', reason: `A pasta de LUTs tem mais de ${COLLECTION_MAX_ENTRIES.toLocaleString('pt-BR')} arquivos; parte da lista não é mostrada.` });
    }
    if (!problems.length) this._pruneHashes(items);
    this._fillHashes(items);
    return { items, problems };
  }

  /** Só a lista de LUTs (veja listDetailed). */
  list() {
    return this.listDetailed().items;
  }

  // ─── Segurança de caminho ──────────────────────────────────────────────────────────────────────

  /** Recusa (com mensagem amigável) qualquer caminho fora da pasta de LUTs. Aceita caminhos que ainda não existem. */
  _assertInsideDir(target) {
    try {
      PathGuard.assertWithin(this.lutsDir, target);
    } catch {
      throw new LutUserError(MSG_NOT_INSIDE);
    }
  }

  /**
   * Confere que `target` é um arquivo .cube comum ESTRITAMENTE dentro da pasta de LUTs (nunca a própria pasta, nunca
   * uma pasta, nunca um atalho). O cálculo usa os caminhos reais (junções e links resolvidos).
   * @param {string} target
   * @returns {string} o caminho absoluto resolvido
   * @throws {Error} em português: fora da pasta ("Esta LUT não está na pasta de LUTs.") ou inexistente
   */
  assertFileInside(target) {
    if (typeof target !== 'string' || target === '' || !path.isAbsolute(target)) throw new LutUserError(MSG_NOT_INSIDE);
    this._assertInsideDir(target);
    let realBase;
    let realTarget;
    let stats;
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new LutUserError(MSG_NOT_INSIDE);
      realBase = fs.realpathSync.native(this.lutsDir);
      realTarget = fs.realpathSync.native(target);
      stats = fs.statSync(realTarget);
    } catch (err) {
      throw err instanceof LutUserError ? err : new LutUserError(MSG_NOT_FOUND);
    }
    const rel = path.relative(realBase, realTarget); // no Windows a comparação não diferencia maiúsculas
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new LutUserError(MSG_NOT_INSIDE);
    if (!stats.isFile() || path.extname(realTarget).toLowerCase() !== LUT_EXT) throw new LutUserError(MSG_NOT_INSIDE);
    return path.resolve(target);
  }

  /**
   * Caminho absoluto de uma pasta (ou LUT) da coleção a partir do caminho relativo que a tela conhece ("A/B"). Só
   * valida o texto (nada de "..", ".", vazio, "\", ":" e demais proibidos, nomes reservados) e que cai dentro da
   * coleção; não confere se existe.
   * @param {string} relPath - com "/" como separador
   * @returns {string}
   */
  resolveRel(relPath) {
    if (typeof relPath !== 'string' || relPath === '' || relPath.length > 1024) throw new LutUserError(MSG_FOLDER_GONE);
    const segments = relPath.split('/');
    if (segments.length > MAX_SEGMENTS || !segments.every(isSafeSegment)) throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    const abs = path.join(this.lutsDir, ...segments);
    try {
      PathGuard.assertWithin(this.lutsDir, abs);
    } catch {
      throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    }
    return abs;
  }

  /**
   * Confere que `relPath` é uma pasta comum, existente, ESTRITAMENTE dentro da coleção (nunca a raiz, nunca um atalho
   * ou junção, mesmo calculando pelos caminhos reais).
   * @param {string} relPath
   * @returns {string} caminho absoluto da pasta
   */
  assertFolderInside(relPath) {
    const abs = this.resolveRel(relPath);
    let stats;
    let realBase;
    let realTarget;
    try {
      stats = fs.lstatSync(abs);
      realBase = fs.realpathSync.native(this.lutsDir);
      realTarget = fs.realpathSync.native(abs);
    } catch {
      throw new LutUserError(MSG_FOLDER_GONE);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    const rel = path.relative(realBase, realTarget);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    // O caminho real precisa ser exatamente o pedido: uma junção no meio do caminho levaria para outro lugar.
    if (rel.toLowerCase() !== relPath.split('/').join(path.sep).toLowerCase()) throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    return abs;
  }

  /**
   * Cria (se faltar) a cadeia de subpastas dentro da coleção. Recusa qualquer nível que já exista como atalho/junção
   * ou como arquivo, e confere pelo caminho real que o destino continua dentro da coleção.
   * @param {string[]} folders - nomes de pasta, um por nível
   * @returns {{ dir: string, created: number }} pasta de destino e quantas pastas foram criadas
   */
  ensureFolders(folders) {
    fs.mkdirSync(this.lutsDir, { recursive: true });
    let current = this.lutsDir;
    let created = 0;
    for (const segment of folders) {
      if (!isSafeSegment(segment)) throw new LutUserError('Nome de pasta inválido.');
      const next = path.join(current, segment);
      try {
        PathGuard.assertWithin(this.lutsDir, next);
      } catch {
        throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
      }
      let stats = null;
      try { stats = fs.lstatSync(next); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (stats) {
        if (stats.isSymbolicLink() || !stats.isDirectory()) throw new LutUserError(`"${segment}" já existe e não é uma pasta comum.`);
      } else {
        fs.mkdirSync(next);
        created++;
      }
      current = next;
    }
    const realBase = fs.realpathSync.native(this.lutsDir);
    const realDir = fs.realpathSync.native(current);
    const rel = path.relative(realBase, realDir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
    return { dir: current, created };
  }

  // ─── Conteúdo (hash) da coleção ────────────────────────────────────────────────────────────────

  /**
   * Índice SHA-256 → caminhos relativos de toda a coleção, construído uma vez por operação (lê só o que não está no
   * cache de hash, um arquivo por vez, sem bloquear o processo). Nunca use um laço de buscas: monte o índice.
   * @param {{ signal?: AbortSignal, onProgress?: (p: { done: number, total: number }) => void }} [options]
   * @returns {Promise<Map<string, string[]>>}
   */
  async hashIndex({ signal = null, onProgress = null } = {}) {
    const { items } = this.listDetailed();
    const index = new Map();
    let done = 0;
    for (const item of items) {
      if (signal && signal.aborted) break;
      const hash = item.hash || await this.hashOfAsync(item.path);
      if (hash) {
        if (!index.has(hash)) index.set(hash, []);
        index.get(hash).push(item.relPath);
      }
      done++;
      if (onProgress && done % 25 === 0) onProgress({ done, total: items.length });
    }
    return index;
  }

  /** Guarda no cache o hash de um arquivo recém-gravado (já conferido), para não lê-lo de novo. */
  noteHash(abs, hash) {
    try {
      const stats = fs.statSync(abs);
      this._loadHashes().set(this._relPath(abs), { key: `${stats.size}:${stats.mtimeMs}`, hash });
      this._schedulePersist();
    } catch { /* o hash será calculado na próxima listagem */ }
  }

  // ─── Importação (arquivos soltos) ──────────────────────────────────────────────────────────────

  /**
   * Importa arquivos .cube soltos para a RAIZ da coleção, sem sobrescrever nada (importar pastas e subpastas é com
   * o LutImporter; este é o caminho simples do canal luts:import).
   * - cada arquivo é lido uma única vez: a validação (a mesma da leitura da prévia), o hash e a cópia usam o mesmo
   *   conteúdo, e a gravação vai por arquivo temporário conferido (ver lutFileOps.copyFileExclusive);
   * - conteúdo idêntico a uma LUT já existente (em qualquer subpasta) é ignorado;
   * - nome repetido com conteúdo diferente ganha sufixo " (2)";
   * - falha em um arquivo não derruba o lote: ele entra em `invalid` com o motivo.
   * @param {string[]} filePaths - Lista de caminhos dos arquivos .cube
   * @returns {{ imported: Array<{name:string,path:string}>, renamed: Array<{from:string,to:string}>, duplicates: string[], invalid: Array<{name:string,reason:string}> } | false}
   */
  importFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return false;
    try {
      fs.mkdirSync(this.lutsDir, { recursive: true });
    } catch (err) {
      logger.warn('LutManager:importFiles:pasta_falhou', { error: err.message });
      throw new LutUserError(MSG_COLLECTION_UNAVAILABLE);
    }

    const result = { imported: [], renamed: [], duplicates: [], invalid: [] };
    const candidates = [];
    for (const filePath of filePaths) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) continue;
      const fileName = path.basename(filePath);
      let stats = null;
      try { stats = fs.statSync(filePath); } catch { /* a validação abaixo explica */ }
      if (!stats || !stats.isFile() || path.extname(filePath).toLowerCase() !== LUT_EXT || stats.size === 0 || stats.size > MAX_FILE_BYTES) {
        result.invalid.push({ name: fileName, reason: CubeParser.validate(filePath).reason }); // recusa antes de ler o conteúdo
        continue;
      }
      candidates.push({ filePath, fileName, size: stats.size });
    }

    // Índice por conteúdo só dos tamanhos que interessam (poupa ler a coleção inteira)
    const known = indexByHash(this.lutsDir, new Set(candidates.map((c) => c.size)));
    for (const { filePath, fileName } of candidates) {
      try {
        const data = fs.readFileSync(filePath);
        const check = CubeParser.validate(data);
        if (!check.ok) { result.invalid.push({ name: fileName, reason: check.reason }); continue; }
        const hash = sha256(data);
        if (known.has(hash)) { result.duplicates.push(fileName); continue; }

        const copy = copyFileExclusive(data, this.lutsDir, fileName);
        known.set(hash, copy.name);
        this.noteHash(copy.path, hash);
        result.imported.push({ name: copy.name, path: copy.path });
        if (copy.name !== fileName) result.renamed.push({ from: fileName, to: copy.name });
      } catch (err) {
        logger.warn('LutManager:importFiles:arquivo_falhou', { name: fileName, error: err.message });
        result.invalid.push({ name: fileName, reason: 'Não foi possível copiar este arquivo.' });
      }
    }
    return result;
  }

  /**
   * Grava na RAIZ da coleção LUTs que já estão na memória (as de um pacote .bdspro importado), sem sobrescrever nada.
   * Roda dentro da trava de escrita (espera a vez) e refaz o índice de conteúdo da coleção ali dentro: quem já existe,
   * em qualquer subpasta, não é recriado. Cada conteúdo é conferido de novo aqui (validação do leitor e SHA-256 do
   * próprio buffer); o NOME que veio de fora nunca é caminho: é limpo, validado pelas regras de nome da coleção e,
   * se não servir, vira "LUT <início do hash>". Falha em um item não impede os demais.
   * @param {Array<{ buffer: Buffer, name?: string }>} items
   * @returns {Promise<Array<{ status: 'added'|'exists'|'failed', hash: string|null, relPath: string|null, reason: string|null }>>}
   *   uma resposta por item, na mesma ordem
   */
  addBuffers(items) {
    return this.withLock(async () => {
      fs.mkdirSync(this.lutsDir, { recursive: true });
      const index = await this.hashIndex();
      const results = [];
      for (const item of Array.isArray(items) ? items : []) {
        try {
          const buffer = item && item.buffer;
          if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_FILE_BYTES) {
            results.push({ status: 'failed', hash: null, relPath: null, reason: 'Arquivo de LUT inválido.' });
            continue;
          }
          const check = CubeParser.validate(buffer);
          const hash = sha256(buffer);
          if (!check.ok) { results.push({ status: 'failed', hash, relPath: null, reason: check.reason }); continue; }
          if (index.has(hash)) { results.push({ status: 'exists', hash, relPath: index.get(hash)[0], reason: null }); continue; }

          const wanted = item.name ? this.validateName(sanitizeFolderSegment(item.name, 80)) : { ok: false };
          const fileName = wanted.ok ? wanted.name : `LUT ${hash.slice(0, 8)}${LUT_EXT}`;
          const copy = copyFileExclusive(buffer, this.lutsDir, fileName);
          this.noteHash(copy.path, hash);
          index.set(hash, [copy.name]);
          results.push({ status: 'added', hash, relPath: copy.name, reason: null });
        } catch (err) {
          logger.warn('LutManager:addBuffers:arquivo_falhou', { error: err && err.message });
          results.push({ status: 'failed', hash: null, relPath: null, reason: 'Não foi possível gravar esta LUT.' });
        }
      }
      return results;
    }, { wait: true });
  }

  // ─── Renomear e excluir ────────────────────────────────────────────────────────────────────────

  /**
   * Confere o novo nome de uma LUT sem corrigir nada em silêncio: caracteres proibidos, nomes reservados do Windows,
   * espaço/ponto nas pontas e estouro do limite de caminho são recusados com o motivo.
   * @param {string} newName - nome desejado, com ou sem ".cube"
   * @param {string} [dir] - pasta onde o arquivo ficará (padrão: a raiz da coleção)
   * @returns {{ ok: boolean, name: string|null, reason: string|null }} `name` já traz a extensão
   */
  validateName(newName, dir = this.lutsDir) {
    const base = String(newName ?? '').replace(/\.cube$/i, '');
    const reason = checkFileBaseName(base);
    if (reason) return { ok: false, name: null, reason };
    const name = `${base}${LUT_EXT}`;
    if (path.resolve(dir).length + 1 + name.length + PATH_RESERVE > MAX_PATH_BUDGET) {
      return { ok: false, name: null, reason: 'O nome deixaria o caminho do arquivo longo demais para o Windows. Use um nome mais curto.' };
    }
    const rel = this._relPath(path.join(dir, name));
    if (rel.length > PHONE_MAX_PATH) {
      return { ok: false, name: null, reason: 'O nome deixaria o caminho da LUT longo demais para o celular. Use um nome mais curto.' };
    }
    return { ok: true, name, reason: null };
  }

  /**
   * Renomeia uma LUT.
   * @param {string} oldPath - Caminho atual do arquivo
   * @param {string} newName - Novo nome desejado
   * @returns {boolean} false se a LUT já não existe
   */
  rename(oldPath, newName) {
    this._assertInsideDir(oldPath);
    if (!fs.existsSync(oldPath)) return false;
    this.assertFileInside(oldPath);

    const check = this.validateName(newName, path.dirname(oldPath));
    if (!check.ok) throw new LutUserError(check.reason);

    const newPath = path.join(path.dirname(oldPath), check.name);
    this._assertInsideDir(newPath);
    if (newPath === oldPath) return true;

    // Só muda a caixa das letras (Windows considera o mesmo arquivo): permitido.
    if (fs.existsSync(newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      throw new LutUserError('Já existe um arquivo com esse nome.');
    }

    try {
      fs.renameSync(oldPath, newPath);
    } catch (err) {
      // EBUSY/EPERM/ENOSPC trazem o caminho completo em inglês: o detalhe fica só no log
      logger.warn('LutManager:rename:falhou', { error: err && err.message });
      throw new LutUserError('Não foi possível renomear a LUT. Feche os programas que a estejam usando e tente de novo.');
    }
    // O conteúdo é o mesmo: o hash já calculado passa para o nome novo.
    const cache = this._loadHashes();
    const old = cache.get(this._relPath(oldPath));
    cache.delete(this._relPath(oldPath));
    if (old) cache.set(this._relPath(newPath), old);
    this._schedulePersist();
    return true;
  }

  /**
   * Envia uma LUT para a Lixeira (recuperável). Nunca exclui de forma definitiva: sem Lixeira, recusa.
   * @param {string} filePath - Caminho do arquivo a remover
   * @param {(p: string) => Promise<void>} trash - Ex.: shell.trashItem
   * @returns {Promise<boolean>} false se a LUT já não existe
   */
  async delete(filePath, trash) {
    this._assertInsideDir(filePath);
    if (!fs.existsSync(filePath)) return false;
    this.assertFileInside(filePath);
    if (typeof trash !== 'function') throw new LutUserError('A Lixeira não está disponível; a LUT não foi excluída.');
    try {
      await trash(filePath);
    } catch (err) {
      logger.warn('LutManager:delete:lixeira_falhou', { error: err && err.message });
      throw new LutUserError('Não foi possível mover a LUT para a Lixeira.');
    }
    this._loadHashes().delete(this._relPath(filePath));
    this._schedulePersist();
    return true;
  }

  /**
   * Envia várias LUTs para a Lixeira (recuperável), uma a uma, numa única operação. Cada caminho é conferido como em
   * `delete`: o que está fora da coleção, não é .cube comum ou não pôde ir para a Lixeira entra em `failed` (com o
   * motivo) sem impedir as demais; o que já não existe é só contado em `missing`. Caminho repetido conta uma vez.
   * Nunca exclui de forma definitiva: sem Lixeira, recusa o lote inteiro.
   * @param {string[]} paths - caminhos absolutos dos .cube
   * @param {(p: string) => Promise<void>} trash - Ex.: shell.trashItem
   * @returns {Promise<{ trashed: number, missing: number, failed: Array<{ path: string, reason: string }> }>}
   */
  async deleteMany(paths, trash) {
    if (!Array.isArray(paths) || paths.length === 0) throw new LutUserError('Nenhuma LUT foi escolhida para excluir.');
    if (typeof trash !== 'function') throw new LutUserError('A Lixeira não está disponível; as LUTs não foram excluídas.');
    return this.withLock(async () => {
      const result = { trashed: 0, missing: 0, failed: [] };
      const seen = new Set();
      for (const target of paths) {
        if (typeof target !== 'string' || target === '') {
          result.failed.push({ path: String(target), reason: MSG_NOT_INSIDE });
          continue;
        }
        const key = IS_WIN ? path.resolve(target).toLowerCase() : path.resolve(target);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          this._assertInsideDir(target);
          if (!fs.existsSync(target)) { result.missing++; continue; }
          this.assertFileInside(target);
        } catch (err) {
          result.failed.push({ path: target, reason: err.message === MSG_NOT_FOUND ? MSG_NOT_FOUND : MSG_NOT_INSIDE });
          continue;
        }
        try {
          await trash(target);
        } catch (err) {
          logger.warn('LutManager:deleteMany:lixeira_falhou', { error: err && err.message });
          result.failed.push({ path: target, reason: 'Não foi possível mover a LUT para a Lixeira.' });
          continue;
        }
        result.trashed++;
        this._loadHashes().delete(this._relPath(target));
      }
      this._schedulePersist();
      return result;
    });
  }

  // ─── Pastas (qualquer nível da coleção) ────────────────────────────────────────────────────────

  /** Troca, no cache de hash, o prefixo de caminho de tudo que estava dentro de uma pasta renomeada. */
  _remapHashPrefix(oldPrefix, newPrefix) {
    const cache = this._loadHashes();
    const norm = (s) => (IS_WIN ? s.toLowerCase() : s);
    const from = norm(oldPrefix);
    for (const [rel, entry] of [...cache]) {
      if (!norm(rel).startsWith(from)) continue;
      cache.delete(rel);
      cache.set(newPrefix + rel.slice(oldPrefix.length), entry);
    }
    this._schedulePersist();
  }

  /**
   * Renomeia uma pasta da coleção (qualquer nível). Recusa, com o motivo: nome inválido ou reservado, nome já usado,
   * pasta que não está mais lá ou que seja atalho/junção, e nome que deixaria o caminho de algum arquivo longo demais
   * para o Windows ou para o celular. Trocar só a caixa das letras funciona (por um nome temporário).
   * As LUTs de projeto continuam ligadas (a ligação é pelo conteúdo, não pelo caminho); o celular passa a ver caminhos novos.
   * @param {string} relPath - pasta atual, com "/"
   * @param {string} newName - novo nome (um único nível)
   * @returns {Promise<true>}
   */
  renameFolder(relPath, newName) {
    return this.withLock(async () => {
      const abs = this.assertFolderInside(relPath);
      const problem = checkFolderName(newName);
      if (problem) throw new LutUserError(problem);

      const parent = path.dirname(abs);
      const target = path.join(parent, newName);
      try {
        PathGuard.assertWithin(this.lutsDir, target);
      } catch {
        throw new LutUserError(MSG_FOLDER_NOT_INSIDE);
      }
      if (target === abs) return true;
      const onlyCase = target.toLowerCase() === abs.toLowerCase();
      if (!onlyCase && fs.existsSync(target)) throw new LutUserError('Já existe uma pasta ou arquivo com esse nome.');

      const contents = await walkTree(abs, { includeHidden: true, exts: null, maxSegments: Infinity, maxEntries: COLLECTION_MAX_ENTRIES, deadlineMs: 30000 });
      if (contents.truncated || contents.canceled) throw new LutUserError('A pasta tem arquivos demais para renomear de uma vez.');
      const newRel = relPath.split('/').slice(0, -1).concat(newName).join('/');
      const delta = target.length - abs.length;
      let tooLong = 0;
      for (const file of contents.files) {
        if (file.abs.length + delta + PATH_RESERVE > MAX_PATH_BUDGET || `${newRel}/${file.relPath}`.length > PHONE_MAX_PATH) tooLong++;
      }
      if (tooLong) {
        throw new LutUserError(`O novo nome deixaria o caminho de ${tooLong} ${tooLong === 1 ? 'arquivo' : 'arquivos'} longo demais. Use um nome mais curto.`);
      }

      // No Windows uma pasta não pode ser renomeada enquanto algum arquivo dentro dela está aberto: espera o cálculo
      // de hash em segundo plano (que lê as LUTs) terminar. Daqui até o rename não há nenhuma espera.
      await this._hashFill;
      try {
        if (onlyCase) {
          const temp = path.join(parent, `.renomeando-${crypto.randomBytes(6).toString('hex')}`);
          fs.renameSync(abs, temp);
          try { fs.renameSync(temp, target); } catch (err) { fs.renameSync(temp, abs); throw err; }
        } else {
          fs.renameSync(abs, target);
        }
      } catch (err) {
        logger.warn('LutManager:renameFolder:falhou', { error: err.message, code: err.code });
        throw new LutUserError('Não foi possível renomear a pasta. Feche os programas que estejam usando as LUTs e tente de novo.');
      }
      this._remapHashPrefix(`${relPath}/`, `${newRel}/`);
      return true;
    });
  }

  /**
   * Envia as LUTs de uma pasta (e das subpastas) para a Lixeira, uma a uma. NUNCA envia a pasta inteira: arquivos que
   * a lista não mostra (.3dl, anotações, ocultos, atalhos, pastas além do limite de níveis) ficam onde estão, e a pasta
   * só é removida se terminar vazia. Antes de excluir, `dryRun` informa o que haveria: quantas LUTs e quantos outros itens.
   * @param {string} relPath
   * @param {(p: string) => Promise<void>} trash - Ex.: shell.trashItem
   * @param {{ dryRun?: boolean }} [options]
   * @returns {Promise<{ luts: number, others: number } | { trashed: number, luts: number, others: number, remaining: number, folderRemoved: boolean }>}
   */
  deleteFolder(relPath, trash, { dryRun = false } = {}) {
    const run = async () => {
      const abs = this.assertFolderInside(relPath);
      const baseSegments = relPath.split('/').length;
      const contents = await walkTree(abs, { includeHidden: true, exts: null, maxSegments: Infinity, maxEntries: COLLECTION_MAX_ENTRIES, deadlineMs: 30000 });
      if (contents.truncated || contents.canceled) throw new LutUserError('A pasta tem arquivos demais para excluir de uma vez.');

      const cubes = [];
      let others = contents.ignoredLinks;
      for (const file of contents.files) {
        const hidden = file.relPath.split('/').some((segment) => segment.startsWith('.'));
        const listed = !hidden && file.name.toLowerCase().endsWith(LUT_EXT) && baseSegments + file.depth + 1 <= MAX_SEGMENTS;
        if (listed) cubes.push(file); else others++;
      }
      if (dryRun) return { luts: cubes.length, others };
      if (typeof trash !== 'function') throw new LutUserError('A Lixeira não está disponível; as LUTs não foram excluídas.');

      let trashed = 0;
      let failed = 0;
      for (const file of cubes) {
        try {
          await trash(file.abs);
          trashed++;
          this._loadHashes().delete(this._relPath(file.abs));
        } catch (err) {
          failed++;
          logger.warn('LutManager:deleteFolder:lixeira_falhou', { error: err && err.message });
        }
      }
      this._schedulePersist();
      if (failed && !trashed) throw new LutUserError('Não foi possível mover as LUTs para a Lixeira.');

      // Remove as pastas que ficaram vazias, de baixo para cima (rmdir nunca apaga conteúdo).
      let folderRemoved = false;
      for (const dir of [...contents.dirs].sort((a, b) => b.depth - a.depth)) {
        try {
          await fs.promises.rmdir(dir.abs);
          if (dir.relPath === '') folderRemoved = true;
        } catch { /* ainda tem conteúdo: fica */ }
      }
      return { trashed, luts: cubes.length, others, remaining: failed + others, folderRemoved };
    };
    return dryRun ? run() : this.withLock(run);
  }
}

module.exports = LutManager;
