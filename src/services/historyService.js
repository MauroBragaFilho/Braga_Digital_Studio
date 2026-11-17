const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const logger = require('./logService');

/** Prazo de retenção do histórico de downloads/conversões (LGPD: dado pessoal só pelo tempo útil). */
const HISTORY_RETENTION_DAYS = 180;

class HistoryService {
  static async create(databaseDir) {
    // [PERF] Reaproveita o módulo WASM do sql.js já inicializado pelo dbManager (evita carregar
    // e compilar o WASM uma segunda vez no startup). Só inicializa outro se o dbManager ainda não abriu.
    let SQL = null;
    try { SQL = require('../core/database/database').SQL || null; } catch (_) { SQL = null; }
    if (!SQL) {
      SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
      });
    }
    // Agora passamos o diretório, não o arquivo final
    return new HistoryService(SQL, databaseDir);
  }

  constructor(SQL, databaseDir) {
    this.SQL = SQL;

    // Define os caminhos exatos para os dois bancos separados
    this.downloadsDbPath = path.join(databaseDir, 'downloads.db');
    this.conversionsDbPath = path.join(databaseDir, 'conversions.db');

    // Garante que a pasta pai existe
    fs.mkdirSync(databaseDir, { recursive: true });

    // Inicializa os bancos de DOWNLOADS e de CONVERSÕES (arquivo corrompido não impede o app de abrir)
    this.downloadsDb = this._loadOrQuarantine(this.downloadsDbPath);
    this.downloadsDb.run("PRAGMA encoding = 'UTF-8';");
    this.conversionsDb = this._loadOrQuarantine(this.conversionsDbPath);
    this.conversionsDb.run("PRAGMA encoding = 'UTF-8';");

    // Cria as tabelas em seus respectivos bancos
    this.downloadsDb.run(`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY,
        titulo TEXT,
        url TEXT,
        tipo TEXT,
        resolucao TEXT,
        pasta TEXT,
        data_download DATETIME,
        status TEXT
      );
    `);

    this.conversionsDb.run(`
      CREATE TABLE IF NOT EXISTS conversions (
        id INTEGER PRIMARY KEY,
        arquivo_origem TEXT,
        arquivo_saida TEXT,
        formato TEXT,
        encoder TEXT,
        pasta TEXT,
        data_conversao DATETIME,
        status TEXT
      );
    `);

    // [PERF] Timers de persistência em batch — evita exportar e gravar o DB inteiro a cada INSERT
    this._downloadsDirty = false;
    this._conversionsDirty = false;
    this._downloadsSaveTimer = null;
    this._conversionsSaveTimer = null;

    // LGPD: o histórico guarda URL, título e pasta. Não há motivo para manter isso para sempre:
    // na inicialização, apaga os registros com mais de HISTORY_RETENTION_DAYS (180 dias).
    this.applyRetention();

    // Salva os arquivos físicos caso tenham acabado de ser criados
    this.persistDownloads();
    this.persistConversions();
  }

  /**
   * Abre o arquivo como banco; se estiver ausente devolve um banco vazio, e se estiver corrompido
   * move-o para <arquivo>.corrupt-<ts> (quarentena) e devolve um banco vazio.
   */
  _loadOrQuarantine(file) {
    if (!fs.existsSync(file)) return new this.SQL.Database();
    try {
      const db = new this.SQL.Database(fs.readFileSync(file));
      db.exec('SELECT count(*) FROM sqlite_master'); // força a leitura do cabeçalho/esquema
      return db;
    } catch (err) {
      logger.error('[History] Banco de histórico corrompido; usando banco vazio.', { file: path.basename(file), error: err.message });
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) { /* melhor esforço */ }
      return new this.SQL.Database();
    }
  }

  /**
   * Retenção do histórico (LGPD): remove downloads e conversões mais antigos que `days`.
   * As datas são gravadas com datetime('now', 'localtime'), então a comparação usa a mesma base.
   * Registros sem data ficam (não dá para saber a idade).
   * @param {number} [days]
   * @returns {{ downloads: number, conversions: number }} quantos registros saíram
   */
  applyRetention(days = HISTORY_RETENTION_DAYS) {
    const removed = { downloads: 0, conversions: 0 };
    const modifier = `-${Math.max(1, Math.floor(Number(days) || HISTORY_RETENTION_DAYS))} days`;
    try {
      this.downloadsDb.run("DELETE FROM downloads WHERE data_download IS NOT NULL AND data_download < datetime('now', 'localtime', $m)", { $m: modifier });
      removed.downloads = this.downloadsDb.getRowsModified();
      this.conversionsDb.run("DELETE FROM conversions WHERE data_conversao IS NOT NULL AND data_conversao < datetime('now', 'localtime', $m)", { $m: modifier });
      removed.conversions = this.conversionsDb.getRowsModified();
      if (removed.downloads || removed.conversions) logger.info('[History] Retenção aplicada.', removed);
    } catch (err) {
      logger.error('[History] Falha ao aplicar a retenção do histórico.', { error: err.message });
    }
    return removed;
  }

  /** Escrita atômica: grava em .tmp e renomeia sobre o destino (o arquivo antigo nunca fica pela metade). */
  _writeAtomic(file, db) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, file);
  }

  // ==========================================
  // MÉTODOS DE DOWNLOADS (Usa this.downloadsDb)
  // ==========================================

  addDownload(download) {
    const statement = this.downloadsDb.prepare(`
      INSERT INTO downloads (titulo, url, tipo, resolucao, pasta, data_download, status)
      VALUES ($titulo, $url, $tipo, $resolucao, $pasta, datetime('now', 'localtime'), $status)
    `);
    statement.run({
      $titulo: download.titulo || 'Sem título',
      $url: download.url,
      $tipo: download.tipo,
      $resolucao: download.resolucao || '',
      $pasta: download.pasta,
      $status: download.status
    });
    statement.free();

    this._scheduleDownloadsPersist();
    return { changes: 1 };
  }

  listDownloads(limit = 250) {
    const statement = this.downloadsDb.prepare(`
      SELECT id, titulo, url, tipo, resolucao, pasta, data_download, status
      FROM downloads
      ORDER BY id DESC
      LIMIT $limit
    `);
    statement.bind({ $limit: limit });
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    statement.free();
    return rows;
  }

  clearDownloads() {
    this.downloadsDb.run('DELETE FROM downloads');
    this._scheduleDownloadsPersist(true);
    return { changes: 1 };
  }

  // [PERF] Batch persist — exporta e grava o DB no disco apenas 1x após 2s de inatividade,
  // em vez de fazer a cada INSERT (que envolvia exportar o DB inteiro + writeFileSync síncrono).
  _scheduleDownloadsPersist(force = false) {
    this._downloadsDirty = true;
    if (force) {
      clearTimeout(this._downloadsSaveTimer);
      this._persistDownloadsNow();
      return;
    }
    if (this._downloadsSaveTimer) return; // já agendado
    this._downloadsSaveTimer = setTimeout(() => {
      this._downloadsSaveTimer = null;
      this._persistDownloadsNow();
    }, 2000);
  }

  _persistDownloadsNow() {
    if (!this._downloadsDirty) return;
    this._downloadsDirty = false;
    try {
      this._writeAtomic(this.downloadsDbPath, this.downloadsDb);
    } catch (err) {
      this._downloadsDirty = true;
      logger.warn('[History] Falha ao gravar downloads.db', { error: err.message });
    }
  }

  // ==========================================
  // MÉTODOS DE CONVERSÕES (Usa this.conversionsDb)
  // ==========================================

  addConversion(conversion) {
    const statement = this.conversionsDb.prepare(`
      INSERT INTO conversions (
        arquivo_origem,
        arquivo_saida,
        formato,
        encoder,
        pasta,
        data_conversao,
        status
      )
      VALUES (
        $arquivo_origem,
        $arquivo_saida,
        $formato,
        $encoder,
        $pasta,
        datetime('now', 'localtime'),
        $status
      )
    `);

    statement.run({
      $arquivo_origem: conversion.arquivoOrigem,
      $arquivo_saida: conversion.arquivoSaida,
      $formato: conversion.formato,
      $encoder: conversion.encoder,
      $pasta: conversion.pasta,
      $status: conversion.status
    });

    statement.free();
    this._scheduleConversionsPersist();
    return { changes: 1 };
  }

  listConversions(limit = 250) {
    const statement = this.conversionsDb.prepare(`
      SELECT
        id,
        arquivo_origem,
        arquivo_saida,
        formato,
        encoder,
        pasta,
        data_conversao,
        status
      FROM conversions
      ORDER BY id DESC
      LIMIT $limit
    `);

    statement.bind({ $limit: limit });
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    statement.free();
    return rows;
  }

  clearConversions() {
    this.conversionsDb.run('DELETE FROM conversions');
    this._scheduleConversionsPersist(true);
    return { changes: 1 };
  }

  // [PERF] Batch persist para conversões — mesmo debounce de 2s
  _scheduleConversionsPersist(force = false) {
    this._conversionsDirty = true;
    if (force) {
      clearTimeout(this._conversionsSaveTimer);
      this._persistConversionsNow();
      return;
    }
    if (this._conversionsSaveTimer) return;
    this._conversionsSaveTimer = setTimeout(() => {
      this._conversionsSaveTimer = null;
      this._persistConversionsNow();
    }, 2000);
  }

  _persistConversionsNow() {
    if (!this._conversionsDirty) return;
    this._conversionsDirty = false;
    try {
      this._writeAtomic(this.conversionsDbPath, this.conversionsDb);
    } catch (err) {
      this._conversionsDirty = true;
      logger.warn('[History] Falha ao gravar conversions.db', { error: err.message });
    }
  }

  /** Grava na hora o que estiver pendente (chamar no encerramento do app). */
  flush() {
    clearTimeout(this._downloadsSaveTimer);
    clearTimeout(this._conversionsSaveTimer);
    this._downloadsSaveTimer = null;
    this._conversionsSaveTimer = null;
    this._persistDownloadsNow();
    this._persistConversionsNow();
  }

  persistDownloads() {
    this._persistDownloadsNow();
  }

  persistConversions() {
    this._persistConversionsNow();
  }
}

module.exports = HistoryService;
module.exports.HISTORY_RETENTION_DAYS = HISTORY_RETENTION_DAYS;