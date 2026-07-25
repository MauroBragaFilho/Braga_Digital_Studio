const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

class HistoryService {
  static async create(databaseDir) {
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
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

    // Inicializa o banco de DOWNLOADS
    if (fs.existsSync(this.downloadsDbPath)) {
      const bytes = fs.readFileSync(this.downloadsDbPath);
      this.downloadsDb = new SQL.Database(bytes);
    } else {
      this.downloadsDb = new SQL.Database();
    }
    this.downloadsDb.run("PRAGMA encoding = 'UTF-8';");

    // Inicializa o banco de CONVERSÕES
    if (fs.existsSync(this.conversionsDbPath)) {
      const bytes = fs.readFileSync(this.conversionsDbPath);
      this.conversionsDb = new SQL.Database(bytes);
    } else {
      this.conversionsDb = new SQL.Database();
    }
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

    // Salva os arquivos físicos vazios ou atualizados caso tenham acabado de ser criados
    this.persistDownloads();
    this.persistConversions();
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
    
    this.persistDownloads();
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
    this.persistDownloads();
    return { changes: 1 };
  }

  persistDownloads() {
    const data = this.downloadsDb.export();
    fs.writeFileSync(this.downloadsDbPath, Buffer.from(data));
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
    this.persistConversions();
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
    this.persistConversions();
    return { changes: 1 };
  }

  persistConversions() {
    const data = this.conversionsDb.export();
    fs.writeFileSync(this.conversionsDbPath, Buffer.from(data));
  }
}

module.exports = HistoryService;