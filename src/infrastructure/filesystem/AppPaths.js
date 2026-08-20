'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/**
 * AppPaths — Gerenciador centralizado de caminhos da aplicação.
 *
 * Elimina o objeto `paths` ad-hoc do main.js e centraliza todos os
 * diretórios em um único lugar, com suporte multiplataforma.
 *
 * Uso:
 *   const { appPaths } = require('./src/infrastructure/filesystem/AppPaths');
 *   appPaths.init(writableRoot, appRoot);
 *
 * Compatibilidade com código legado:
 *   appPaths.toPlainObject() → retorna o objeto { dataDir, configDir, ... }
 */
class AppPaths {
  constructor() {
    this._writableRoot = null;
    this._appRoot = null;
  }

  /**
   * Inicializa os caminhos base.
   * Deve ser chamado uma vez, logo no início do app (antes dos serviços).
   *
   * @param {string} writableRoot - Diretório gravável (userData em produção, __dirname em dev)
   * @param {string} appRoot - Raiz do app (resourcesPath em produção, __dirname em dev)
   */
  init(writableRoot, appRoot) {
    this._writableRoot = writableRoot;
    this._appRoot = appRoot;
  }

  _assertInit() {
    if (!this._writableRoot) {
      throw new Error('AppPaths não foi inicializado. Chame appPaths.init(writableRoot, appRoot) antes de usar.');
    }
  }

  // ─── Diretórios internos da aplicação ────────────────────────────────────

  /** Diretório raiz da aplicação (recursos estáticos) */
  get appRoot() {
    this._assertInit();
    return this._appRoot;
  }

  /** Diretório gravável raiz */
  get writableRoot() {
    this._assertInit();
    return this._writableRoot;
  }

  /** Dados gerais da aplicação (ferramentas, thumbnails, waveforms, etc.) */
  get dataDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data');
  }

  /** Configurações do usuário */
  get configDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'config');
  }

  /** Banco de dados */
  get databaseDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'database');
  }

  /** Logs da aplicação */
  get logsDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'logs');
  }

  /** LUTs do usuário */
  get lutsDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data', 'LUTs');
  }

  /** Thumbnails gerados */
  get thumbnailsDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data', 'Thumbnails');
  }

  /** Cache de waveforms */
  get waveformsDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data', 'Waveforms');
  }

  /** Arquivos temporários */
  get tempDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data', 'Temp');
  }

  /** Covers de projetos */
  get coversDir() {
    this._assertInit();
    return path.join(this._writableRoot, 'data', 'covers');
  }

  // ─── Diretórios do sistema / usuário ─────────────────────────────────────

  /**
   * Diretório de vídeos do usuário.
   * Usa app.getPath('videos') do Electron quando disponível,
   * com fallback para ~/Videos (multiplataforma).
   */
  get videosDir() {
    try {
      const { app } = require('electron');
      if (app && app.getPath) return app.getPath('videos');
    } catch (_) {}
    return path.join(os.homedir(), 'Videos');
  }

  /**
   * Diretório de downloads do usuário.
   * Usa app.getPath('downloads') do Electron quando disponível.
   */
  get downloadsDir() {
    try {
      const { app } = require('electron');
      if (app && app.getPath) return app.getPath('downloads');
    } catch (_) {}
    return path.join(os.homedir(), 'Downloads');
  }

  /**
   * Raiz do sistema de arquivos do SO.
   * Windows: 'C:\' | Linux/macOS: '/'
   */
  get systemRoot() {
    return process.platform === 'win32' ? 'C:\\' : '/';
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────

  /**
   * Cria todos os diretórios essenciais da aplicação.
   * Deve ser chamado na inicialização do app.
   */
  ensureDirectories() {
    const dirs = [
      this.dataDir,
      this.configDir,
      this.databaseDir,
      this.logsDir,
      this.lutsDir,
      this.thumbnailsDir,
      this.waveformsDir,
      this.tempDir,
      this.coversDir,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Retorna objeto plano compatível com o código legado que recebe `{ paths }`.
   * Permite migração incremental: os serviços continuam recebendo `paths`
   * enquanto são migrados para usar `AppPaths` diretamente.
   *
   * @returns {{ appRoot, dataDir, configDir, databaseDir, logsDir, lutsDir,
   *             thumbnailsDir, waveformsDir, tempDir, coversDir }}
   */
  toPlainObject() {
    return {
      appRoot: this.appRoot,
      dataDir: this.dataDir,
      configDir: this.configDir,
      databaseDir: this.databaseDir,
      logsDir: this.logsDir,
      lutsDir: this.lutsDir,
      thumbnailsDir: this.thumbnailsDir,
      waveformsDir: this.waveformsDir,
      tempDir: this.tempDir,
      coversDir: this.coversDir,
    };
  }
}

// Singleton — uma única instância compartilhada por toda a aplicação.
const appPaths = new AppPaths();

module.exports = { AppPaths, appPaths };
