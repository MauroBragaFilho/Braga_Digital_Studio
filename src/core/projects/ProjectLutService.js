'use strict';

const fs = require('node:fs');
const path = require('node:path');
const CubeParser = require('../luts/CubeParser');
const {
  LUT_EXT, MAX_FILE_BYTES, MAX_PROJECT_LUTS, MAX_PACKAGE_LUT_FILE, MAX_PACKAGE_LUT_BYTES
} = require('../luts/lutConstants');
const { sha256, copyFileExclusive } = require('../luts/lutFileOps');
const { LutUserError } = require('../luts/lutErrors');
const { sanitizeFileName } = require('./outputPath');
const logger = require('../../services/logService');

/** Motivos (já em português) com que o pacote marca uma LUT que não foi levada junto. */
const REASON_MISSING = 'LUT ausente';
const REASON_CHANGED = 'arquivo alterado';
const REASON_TOO_BIG = 'grande demais para o pacote';
const REASON_FULL = 'pacote cheio';
/** Quantos caminhos uma única chamada de adicionar lê (cada um é lido por inteiro para conferir o conteúdo). */
const MAX_ADD_ITEMS = 500;
/** Quantos caminhos (já expandidos das pastas) a consulta de uso aceita. */
const MAX_USAGE_ITEMS = 5000;
const HEX64 = /^[0-9a-f]{64}$/;
const SQL_CHUNK = 400;
const IS_WIN = process.platform === 'win32';
const SAVEPOINT = 'bds_project_luts';

const MSG_NO_PROJECT = 'Este projeto não existe mais.';
const MSG_NOT_IN_COLLECTION = 'Esta LUT não está mais na coleção.';
const MSG_BAD_LUT = 'Não foi possível ler esta LUT.';
const MSG_NOT_INSIDE = 'Esta LUT não está na pasta de LUTs.';
const MSG_NOT_FOUND = 'A LUT não foi encontrada na pasta.';

/** Caminho relativo na forma usada para comparar (o Windows não diferencia maiúsculas). */
const norm = (rel) => (IS_WIN ? String(rel).toLowerCase() : String(rel));

const byName = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });

/**
 * LUTs de projeto: ligam LUTs da coleção a um projeto INTEIRO (nunca a clipes), pelo conteúdo (SHA-256), não pelo nome.
 * Renomear ou mover a LUT na coleção mantém a ligação; se o conteúdo mudar ela vira "Arquivo alterado" e, se o arquivo
 * sair da coleção, "LUT ausente". Não depende de o módulo LUTs estar ligado.
 */
class ProjectLutService {
  /**
   * @param {{ db: object|(() => object), lutManager: import('../luts/LutManager'), projectService: { logActivity: Function } }} deps
   *   db: o banco (ou uma função que o devolve; ele pode ser reaberto)
   */
  constructor({ db, lutManager, projectService }) {
    this._db = db;
    this.lutManager = lutManager;
    this.projectService = projectService;
  }

  get db() {
    return typeof this._db === 'function' ? this._db() : this._db;
  }

  _project(projectId) {
    const row = this.db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    if (!row) throw new LutUserError(MSG_NO_PROJECT);
    return row;
  }

  /** Executa `fn` de forma atômica, também dentro de uma transação já aberta (SAVEPOINT não aninha BEGIN). */
  _atomic(fn) {
    const db = this.db;
    db.exec(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${SAVEPOINT}`);
      return result;
    } catch (err) {
      try { db.exec(`ROLLBACK TO ${SAVEPOINT}`); db.exec(`RELEASE ${SAVEPOINT}`); } catch (_) { /* a transação externa cuida */ }
      throw err;
    }
  }

  /** Junta caminhos soltos e as LUTs das pastas indicadas (qualquer nível), sem repetir. */
  _expand(relPaths, folders) {
    const out = new Map();
    for (const rel of Array.isArray(relPaths) ? relPaths : []) {
      if (typeof rel === 'string' && rel !== '') out.set(norm(rel), rel);
    }
    const list = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string' && f !== '') : [];
    if (list.length) {
      const { items } = this.lutManager.listDetailed();
      for (const folder of list) {
        this.lutManager.resolveRel(folder); // confere o texto do caminho; recusa ".." e afins
        const prefix = `${norm(folder)}/`;
        for (const item of items) {
          if (norm(item.relPath).startsWith(prefix)) out.set(norm(item.relPath), item.relPath);
        }
      }
    }
    return [...out.values()];
  }

  /**
   * Retrato da coleção: itens, índice conteúdo → caminhos relativos e caminho → item. Construído UMA vez por operação
   * (nunca uma busca por LUT); o conteúdo vem do cache de hash e só o que falta é lido, um arquivo por vez.
   */
  async _snapshot() {
    const { items } = this.lutManager.listDetailed();
    const index = new Map();
    const byRel = new Map();
    for (const item of items) {
      byRel.set(norm(item.relPath), item);
      const hash = item.hash || await this.lutManager.hashOfAsync(item.path);
      if (!hash) continue;
      item.hash = hash;
      if (!index.has(hash)) index.set(hash, []);
      index.get(hash).push(item.relPath);
    }
    for (const list of index.values()) list.sort(byName);
    return { items, index, byRel };
  }

  /** Resolve uma ligação contra o retrato da coleção. */
  _resolve(row, snapshot) {
    const copies = snapshot.index.get(row.lut_hash) || [];
    if (copies.length) {
      const hint = row.lut_rel_path ? copies.find((rel) => norm(rel) === norm(row.lut_rel_path)) : null;
      const item = snapshot.byRel.get(norm(hint || copies[0]));
      return { status: 'ok', item };
    }
    const atHint = row.lut_rel_path ? snapshot.byRel.get(norm(row.lut_rel_path)) : null;
    if (atHint) return { status: 'changed', item: atHint }; // o arquivo da dica ainda existe, com outro conteúdo
    return { status: 'missing', item: null };
  }

  /**
   * LUTs do projeto, já resolvidas contra a coleção.
   * @returns {Promise<Array<{ id: number, hash: string, name: string, title: string|null, kind: string|null, lutSize: number|null, bytes: number|null, addedAt: string, status: 'ok'|'changed'|'missing', path: string|null, relPath: string|null }>>}
   */
  async list(projectId) {
    const rows = this.db.prepare('SELECT * FROM project_luts WHERE project_id = ? ORDER BY id').all(projectId);
    if (!rows.length) return [];
    const snapshot = await this._snapshot();
    return rows.map((row) => {
      const { status, item } = this._resolve(row, snapshot);
      return {
        id: row.id,
        hash: row.lut_hash,
        name: item ? item.displayName : row.lut_name,
        title: row.lut_title || null,
        kind: row.lut_kind || null,
        lutSize: row.lut_size ?? null,
        bytes: row.file_bytes ?? null,
        addedAt: row.added_at,
        status,
        path: item ? item.path : null,
        relPath: item ? item.relPath : null
      };
    });
  }

  /** Lê UMA vez, valida e calcula o conteúdo do mesmo buffer (o cache de hash nunca vale aqui). */
  async _readValidated(relPath) {
    let abs;
    try {
      abs = this.lutManager.resolveRel(relPath);
    } catch (_) {
      return { ok: false, reason: MSG_NOT_INSIDE }; // caminho com "..", separador errado, nome reservado…
    }
    try {
      this.lutManager.assertFileInside(abs);
    } catch (err) {
      return { ok: false, reason: err && err.message === MSG_NOT_FOUND ? MSG_NOT_FOUND : MSG_NOT_INSIDE };
    }
    try {
      const stats = await fs.promises.stat(abs);
      if (stats.size > MAX_FILE_BYTES || stats.size === 0) return { ok: false, reason: CubeParser.validate(abs).reason };
      const buffer = await fs.promises.readFile(abs);
      const check = CubeParser.validate(buffer);
      if (!check.ok) return { ok: false, reason: check.reason };
      const base = path.basename(abs);
      return {
        ok: true,
        hash: sha256(buffer),
        name: base.toLowerCase().endsWith(LUT_EXT) ? base.slice(0, -LUT_EXT.length) : base,
        title: check.info.title || null,
        kind: check.info.kind,
        lutSize: check.info.lutSize,
        bytes: buffer.length
      };
    } catch (err) {
      logger.warn('ProjectLutService:add:leitura_falhou', { relPath, code: err && err.code });
      return { ok: false, reason: MSG_BAD_LUT };
    }
  }

  /**
   * Adiciona LUTs da coleção ao projeto. Cada uma é lida uma única vez; a validação e o conteúdo saem do mesmo buffer.
   * Inválida é recusada com o motivo; a que o projeto já tem conta em `already`; acima de 100 LUTs no projeto o
   * excedente fica de fora e é contado em `overLimit` (nunca em silêncio).
   * @param {number} projectId
   * @param {string[]} relPaths - caminhos relativos na coleção ("Pasta/Sub/LUT.cube")
   * @param {{ folders?: string[] }} [options] - pastas da coleção cujas LUTs (qualquer nível) entram também
   * @returns {Promise<{ added: number, already: number, invalid: Array<{ name: string, reason: string }>, overLimit: number }>}
   */
  async add(projectId, relPaths, { folders = [] } = {}) {
    const project = this._project(projectId);
    const wanted = this._expand(relPaths, folders);
    const result = { added: 0, already: 0, invalid: [], overLimit: 0 };
    if (!wanted.length) return result;
    if (wanted.length > MAX_ADD_ITEMS) {
      result.overLimit += wanted.length - MAX_ADD_ITEMS;
      wanted.length = MAX_ADD_ITEMS;
    }

    const have = new Set(this.db.prepare('SELECT lut_hash FROM project_luts WHERE project_id = ?').all(projectId).map((r) => r.lut_hash));
    const seen = new Set(have);
    const fresh = [];
    for (const rel of wanted) {
      const read = await this._readValidated(rel);
      if (!read.ok) { result.invalid.push({ name: rel.split(/[\\/]/).pop() || rel, reason: read.reason }); continue; }
      if (seen.has(read.hash)) { result.already++; continue; } // a mesma LUT (outra cópia ou já no projeto)
      seen.add(read.hash);
      fresh.push({ ...read, relPath: rel });
    }

    const addedNames = [];
    this._atomic(() => {
      // Reconta dentro do bloco atômico: o projeto pode ter mudado durante as leituras
      let count = this.db.prepare('SELECT COUNT(*) AS n FROM project_luts WHERE project_id = ?').get(projectId).n;
      const stored = new Set(this.db.prepare('SELECT lut_hash FROM project_luts WHERE project_id = ?').all(projectId).map((r) => r.lut_hash));
      const insert = this.db.prepare(`INSERT OR IGNORE INTO project_luts
        (project_id, lut_hash, lut_name, lut_title, lut_kind, lut_size, file_bytes, lut_rel_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const lut of fresh) {
        if (stored.has(lut.hash)) { result.already++; continue; }
        if (count >= MAX_PROJECT_LUTS) { result.overLimit++; continue; }
        const info = insert.run(projectId, lut.hash, lut.name, lut.title, lut.kind, lut.lutSize, lut.bytes, lut.relPath);
        if (info.changes > 0) { result.added++; count++; addedNames.push(lut.name); } else result.already++;
      }
    });

    if (result.added) {
      const shown = addedNames.slice(0, 3).join(', ');
      const more = addedNames.length > 3 ? ` e mais ${addedNames.length - 3}` : '';
      this.projectService.logActivity(project.id, 'lut', addedNames.length === 1 ? `LUT adicionada: ${shown}` : `LUTs adicionadas: ${shown}${more}`);
    }
    return result;
  }

  /** Tira uma LUT do projeto (a LUT da coleção não é tocada). @returns {boolean} false se o projeto não a tinha */
  remove(projectId, hash) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new LutUserError('LUT inválida.');
    const row = this.db.prepare('SELECT id, lut_name FROM project_luts WHERE project_id = ? AND lut_hash = ?').get(projectId, hash);
    if (!row) return false;
    const info = this.db.prepare('DELETE FROM project_luts WHERE id = ?').run(row.id);
    if (info.changes > 0) this.projectService.logActivity(projectId, 'lut', `LUT removida: ${row.lut_name}`);
    return info.changes > 0;
  }

  /**
   * Caminho do arquivo da LUT do projeto na coleção (para mostrar na pasta). Falha com mensagem amigável se a LUT já
   * não está lá. Uma LUT "alterada" também tem arquivo (o do mesmo caminho, com outro conteúdo).
   * @returns {Promise<string>}
   */
  async resolvePath(projectId, hash) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new LutUserError('LUT inválida.');
    const row = this.db.prepare('SELECT * FROM project_luts WHERE project_id = ? AND lut_hash = ?').get(projectId, hash);
    if (!row) throw new LutUserError('Esta LUT não está neste projeto.');
    const { item } = this._resolve(row, await this._snapshot());
    if (!item) throw new LutUserError(MSG_NOT_IN_COLLECTION);
    return this.lutManager.assertFileInside(item.path);
  }

  /** Projetos que usam cada conteúdo: Map(hash → [{ id, name }]). */
  _projectsByHash(hashes) {
    const users = new Map();
    for (let i = 0; i < hashes.length; i += SQL_CHUNK) {
      const chunk = hashes.slice(i, i + SQL_CHUNK);
      const rows = this.db.prepare(`SELECT DISTINCT pl.lut_hash AS hash, p.id AS id, p.name AS name
        FROM project_luts pl JOIN projects p ON p.id = pl.project_id
        WHERE pl.lut_hash IN (${chunk.map(() => '?').join(',')}) ORDER BY p.name COLLATE NOCASE, p.id`).all(...chunk);
      for (const r of rows) {
        if (!users.has(r.hash)) users.set(r.hash, []);
        users.get(r.hash).push({ id: r.id, name: r.name });
      }
    }
    return users;
  }

  /**
   * Em quais projetos as LUTs indicadas estão em uso, calculado sobre o CONJUNTO a excluir (ou a escolher): o que
   * `remainingCopies` conta são só as cópias idênticas que NÃO estão no conjunto. Só entram na resposta as LUTs usadas
   * em algum projeto; quem decide o aviso é a tela (avisa quando `remainingCopies` é 0).
   * @param {{ relPaths?: string[], folders?: string[] }} request
   * @returns {Promise<Array<{ relPath: string, hash: string, projects: Array<{ id: number, name: string }>, remainingCopies: number }>>}
   */
  async usage({ relPaths = [], folders = [] } = {}) {
    const wanted = this._expand(relPaths, folders);
    if (!wanted.length) return [];
    if (wanted.length > MAX_USAGE_ITEMS) throw new LutUserError('LUTs demais para conferir de uma vez.');
    // Sem nenhuma LUT em projetos não há o que avisar: evita ler a coleção inteira à toa
    if (!this.db.prepare('SELECT COUNT(*) AS n FROM project_luts').get().n) return [];

    const snapshot = await this._snapshot();
    const hashOfRel = new Map();
    for (const [hash, rels] of snapshot.index) for (const rel of rels) hashOfRel.set(norm(rel), hash);
    const chosen = new Set(wanted.map(norm));
    const hashes = [...new Set(wanted.map((rel) => hashOfRel.get(norm(rel))).filter(Boolean))];
    const users = this._projectsByHash(hashes);

    const out = [];
    for (const rel of wanted) {
      const hash = hashOfRel.get(norm(rel));
      const projects = hash ? users.get(hash) : null;
      if (!projects || !projects.length) continue;
      const remaining = (snapshot.index.get(hash) || []).filter((copy) => !chosen.has(norm(copy))).length;
      out.push({ relPath: snapshot.byRel.get(norm(rel)).relPath, hash, projects, remainingCopies: remaining });
    }
    return out;
  }

  // ─── Exportação: pacote .bdspro e pasta ao lado do XML ─────────────────────────────────────────
  // Aqui a ligação (conteúdo registrado) é reencontrada na coleção LENDO o arquivo: o conteúdo lido é recalculado e
  // só vale se igual ao registrado (o cache de hash serve apenas para descartar arquivos que certamente não servem).
  // Cada arquivo é lido no máximo uma vez por operação. LUT ausente ou alterada nunca é copiada nem levada.

  /** Itens da coleção organizados para achar o arquivo de cada ligação sem varrer tudo de novo. */
  _context(items) {
    const byRel = new Map();
    const byHash = new Map();
    const unhashed = [];
    for (const item of items) {
      byRel.set(norm(item.relPath), item);
      if (item.hash) {
        if (!byHash.has(item.hash)) byHash.set(item.hash, []);
        byHash.get(item.hash).push(item);
      } else {
        unhashed.push(item);
      }
    }
    for (const list of byHash.values()) list.sort((a, b) => byName(a.relPath, b.relPath));
    return { byRel, byHash, unhashed, known: new Map() };
  }

  /**
   * Arquivos que podem ter o conteúdo da ligação: o do caminho que a ligação guardou, os de mesmo conteúdo já no
   * cache e os ainda sem hash com o mesmo tamanho. `known` (conteúdo já lido nesta operação) descarta os que se
   * sabe diferentes. `hint` é o arquivo do caminho guardado, se existe (vira "alterado" quando nenhum bate).
   */
  _candidates(row, ctx) {
    const sameSize = (item) => row.file_bytes == null || item.size === row.file_bytes;
    const hint = row.lut_rel_path ? ctx.byRel.get(norm(row.lut_rel_path)) || null : null;
    const list = [];
    const seen = new Set();
    const push = (item) => {
      const key = norm(item.relPath);
      if (seen.has(key)) return;
      seen.add(key);
      const known = ctx.known.get(key);
      if (known === undefined || known === row.lut_hash) list.push(item);
    };
    if (hint && (!hint.hash || hint.hash === row.lut_hash) && sameSize(hint)) push(hint);
    for (const item of ctx.byHash.get(row.lut_hash) || []) push(item);
    for (const item of ctx.unhashed) if (sameSize(item)) push(item);
    return { hint, list };
  }

  /** Acha (lendo, de forma síncrona) o arquivo da coleção com o conteúdo da ligação. */
  _locateSync(row, ctx) {
    const { hint, list } = this._candidates(row, ctx);
    for (const item of list) {
      let buffer;
      try {
        const abs = this.lutManager.assertFileInside(item.path);
        const stats = fs.statSync(abs);
        if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) continue;
        buffer = fs.readFileSync(abs);
      } catch (_) { continue; }
      const hash = sha256(buffer);
      ctx.known.set(norm(item.relPath), hash);
      if (hash === row.lut_hash) return { status: 'ok', item, buffer };
    }
    return hint ? { status: 'changed', item: hint } : { status: 'missing', item: null };
  }

  /**
   * Igual a `_locateSync`, sem bloquear o processo e com o tamanho conferido ANTES de ler cada arquivo: `fits(size)`
   * devolve null (cabe) ou o motivo ('toobig', 'full') e a busca para ali.
   */
  async _locate(row, ctx, fits) {
    const { hint, list } = this._candidates(row, ctx);
    for (const item of list) {
      let abs;
      let stats;
      try {
        abs = this.lutManager.assertFileInside(item.path);
        stats = await fs.promises.stat(abs);
      } catch (_) { continue; }
      if (!stats.isFile() || stats.size === 0 || stats.size > MAX_FILE_BYTES) continue;
      const before = fits(stats.size);
      if (before) return { status: before, item };
      let buffer;
      try { buffer = await fs.promises.readFile(abs); } catch (_) { continue; }
      const after = fits(buffer.length); // o arquivo pode ter crescido entre a medida e a leitura
      if (after) return { status: after, item };
      const hash = sha256(buffer);
      ctx.known.set(norm(item.relPath), hash);
      if (hash === row.lut_hash) return { status: 'ok', item, buffer };
    }
    return hint ? { status: 'changed', item: hint } : { status: 'missing', item: null };
  }

  /**
   * LUTs do projeto prontas para entrar no pacote .bdspro: cada arquivo é lido (uma vez), seu conteúdo conferido contra
   * o registrado e somado ao orçamento ANTES do próximo (até 32 MB por LUT e `maxBytes` no total, no máximo 128 MB sem
   * compressão). O que não entra fica na lista com `included: false` e o motivo: nada é omitido em silêncio.
   * @param {number} projectId
   * @param {{ maxBytes?: number }} [options] - espaço que o pacote ainda comporta para LUTs
   * @returns {Promise<null | {
   *   list: Array<{ hash: string, name: string, title: string|null, kind: string|null, lutSize: number|null, bytes: number|null, entry: string|null, included: boolean, reason: string|null }>,
   *   buffers: Map<string, Buffer>,
   *   summary: { included: number, missing: number, skipped: number, bytes: number }
   * }>} null se o projeto não tem LUTs (o pacote então fica idêntico ao de antes). `list` é a chave `luts` do project.json.
   */
  async collectForExport(projectId, { maxBytes = MAX_PACKAGE_LUT_BYTES } = {}) {
    const rows = this.db.prepare('SELECT * FROM project_luts WHERE project_id = ? ORDER BY id').all(projectId);
    if (!rows.length) return null;
    const budget = Math.max(0, Math.min(Number(maxBytes) || 0, MAX_PACKAGE_LUT_BYTES));
    const ctx = this._context(this.lutManager.listDetailed().items);
    const list = [];
    const buffers = new Map();
    const summary = { included: 0, missing: 0, skipped: 0, bytes: 0 };
    const fits = (size) => (size > MAX_PACKAGE_LUT_FILE ? 'toobig' : (summary.bytes + size > budget ? 'full' : null));

    for (const row of rows) {
      const entry = {
        hash: row.lut_hash, name: row.lut_name, title: row.lut_title || null, kind: row.lut_kind || null,
        lutSize: row.lut_size ?? null, bytes: row.file_bytes ?? null, entry: null, included: false, reason: null
      };
      list.push(entry);
      if (row.file_bytes != null && row.file_bytes > MAX_PACKAGE_LUT_FILE) {
        entry.reason = REASON_TOO_BIG;
        summary.skipped++;
        continue;
      }
      let found;
      try {
        found = await this._locate(row, ctx, fits);
      } catch (err) {
        logger.warn('ProjectLutService:collectForExport:leitura_falhou', { code: err && err.code });
        found = { status: 'missing' };
      }
      if (found.status === 'ok') {
        entry.included = true;
        entry.entry = `luts/${row.lut_hash}.cube`;
        entry.name = found.item.displayName || row.lut_name;
        entry.bytes = found.buffer.length;
        buffers.set(row.lut_hash, found.buffer);
        summary.included++;
        summary.bytes += found.buffer.length;
      } else if (found.status === 'toobig') {
        entry.reason = REASON_TOO_BIG;
        summary.skipped++;
      } else if (found.status === 'full') {
        entry.reason = REASON_FULL;
        summary.skipped++;
      } else {
        entry.reason = found.status === 'changed' ? REASON_CHANGED : REASON_MISSING;
        summary.missing++;
      }
    }
    return { list, buffers, summary };
  }

  /**
   * Copia as LUTs do projeto para uma pasta ao lado do XML exportado ("<nome do XML> - LUTs"). Cada arquivo é lido uma
   * vez, o conteúdo conferido contra o registrado (alterada ou ausente não é copiada) e gravado por arquivo temporário
   * sem sobrescrever nada: o mesmo conteúdo já na pasta é pulado e nome igual com conteúdo diferente ganha " (2)".
   * Sem LUTs no projeto devolve null (nenhuma pasta é criada). Nunca lança: qualquer falha vira contagem e log, e o
   * XML já gravado não é afetado.
   * @param {number} projectId
   * @param {string} xmlPath - caminho do XML já gravado (decidido pelo programa, nunca pela tela)
   * @returns {null | { folder: string|null, copied: number, existing: number, missing: number, changed: number, failed: number }}
   */
  copyBesideXml(projectId, xmlPath) {
    let rows;
    try {
      rows = this.db.prepare('SELECT * FROM project_luts WHERE project_id = ? ORDER BY id').all(projectId);
    } catch (err) {
      logger.warn('ProjectLutService:copyBesideXml:consulta_falhou', { error: err && err.message });
      return null;
    }
    if (!rows.length) return null;
    const result = { folder: null, copied: 0, existing: 0, missing: 0, changed: 0, failed: 0 };
    try {
      const ctx = this._context(this.lutManager.listDetailed().items);
      const dir = path.join(path.dirname(xmlPath), `${sanitizeFileName(path.basename(xmlPath, path.extname(xmlPath)), 'Projeto')} - LUTs`);
      let present = null; // conteúdo já na pasta de destino: Map(hash → nome)
      const prepareDir = () => {
        let stats = null;
        try { stats = fs.lstatSync(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) throw new Error('O destino das LUTs não é uma pasta comum.');
        if (!stats) fs.mkdirSync(dir, { recursive: true });
        present = new Map();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith(LUT_EXT)) continue;
          try {
            const file = path.join(dir, entry.name);
            if (fs.statSync(file).size <= MAX_FILE_BYTES) present.set(sha256(fs.readFileSync(file)), entry.name);
          } catch (_) { /* ilegível: não conta como já presente */ }
        }
      };

      for (const row of rows) {
        const found = this._locateSync(row, ctx);
        if (found.status === 'changed') { result.changed++; continue; }
        if (found.status !== 'ok') { result.missing++; continue; }
        try {
          if (!present) prepareDir();
          result.folder = dir;
          if (present.has(row.lut_hash)) { result.existing++; continue; }
          const name = `${sanitizeFileName(found.item.displayName || row.lut_name, 'LUT')}${LUT_EXT}`;
          const copy = copyFileExclusive(found.buffer, dir, name);
          present.set(row.lut_hash, copy.name);
          result.copied++;
        } catch (err) {
          result.failed++;
          logger.warn('ProjectLutService:copyBesideXml:copia_falhou', { error: err && err.message });
        }
      }
      if (result.copied || result.existing) {
        try { this.projectService.logActivity(projectId, 'lut', 'LUTs copiadas ao lado do XML'); } catch (_) { /* atividade é só histórico */ }
      }
    } catch (err) {
      logger.warn('ProjectLutService:copyBesideXml:falhou', { error: err && err.message });
      result.failed = Math.max(0, rows.length - result.copied - result.existing - result.missing - result.changed);
    }
    return result;
  }
}

ProjectLutService.MAX_PROJECT_LUTS = MAX_PROJECT_LUTS;
ProjectLutService.MAX_PACKAGE_LUT_BYTES = MAX_PACKAGE_LUT_BYTES;
ProjectLutService.MAX_PACKAGE_LUT_FILE = MAX_PACKAGE_LUT_FILE;
ProjectLutService.MAX_ADD_ITEMS = MAX_ADD_ITEMS;
ProjectLutService.MAX_USAGE_ITEMS = MAX_USAGE_ITEMS;

module.exports = ProjectLutService;
