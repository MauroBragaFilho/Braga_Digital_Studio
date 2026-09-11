'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { app, shell } = require('electron');
const logger = require('../../services/logService');
const { localDateKey, zonedISO } = require('../../services/timeUtils');
const { DEVELOPER_EMAIL } = require('../../config/appInfo');

/**
 * ErrorReporter — Sistema de captura, diagnóstico e envio de relatórios de erros para o desenvolvedor.
 *
 * Configurado para encaminhar relatórios para o desenvolvedor (ver src/config/appInfo.js).
 *
 * Recursos:
 * - Captura de erros não tratados no Main Process (uncaughtException, unhandledRejection)
 * - Captura de erros do Renderer via IPC
 * - Coleta de metadados do SO, hardware, memória, versão do Electron e Node
 * - Extração das últimas linhas do log recente para contexto de execução
 * - Persistência local em logs/crash-reports/
 * - Envio assíncrono via HTTP POST (Webhook / API) com rate limiting
 * - Geração de link mailto com relatório formatado
 */
class ErrorReporter {
  constructor() {
    this.developerEmail = DEVELOPER_EMAIL;
    this.endpointUrl = ''; // Opcional: URL de webhook HTTP POST (ex: Cloudflare Worker, Discord Webhook, etc.)
    this.logsDir = null;
    this.crashReportsDir = null;
    this.getSettings = null;
    this.recentErrors = new Map(); // hash -> timestamp para debouncing / antiflood
    this.initialized = false;
  }

  /**
   * Inicializa o ErrorReporter.
   * @param {Object} options
   * @param {string} options.logsDir - Diretório de logs da aplicação
   * @param {string} [options.developerEmail] - E-mail do desenvolvedor
   * @param {string} [options.endpointUrl] - URL do endpoint de telemetria
   * @param {Function} [options.getSettings] - Função para obter configurações
   */
  init(options = {}) {
    this.logsDir = options.logsDir || path.join(process.cwd(), 'logs');
    this.developerEmail = options.developerEmail || DEVELOPER_EMAIL;
    this.endpointUrl = options.endpointUrl || '';
    this.getSettings = options.getSettings || null;

    this.crashReportsDir = path.join(this.logsDir, 'crash-reports');
    if (!fs.existsSync(this.crashReportsDir)) {
      fs.mkdirSync(this.crashReportsDir, { recursive: true });
    }

    this._setupGlobalHandlers();
    this.initialized = true;
    logger.info('ErrorReporter inicializado.', { developerEmail: this.developerEmail });
  }

  /**
   * Configura listeners globais no Node.js Main Process.
   * @private
   */
  _setupGlobalHandlers() {
    process.on('uncaughtException', (error) => {
      logger.error('CRITICAL:uncaughtException', { error: error.message, stack: error.stack });
      this.report(error, { source: 'main:uncaughtException', isFatal: true });
    });

    process.on('unhandledRejection', (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logger.error('CRITICAL:unhandledRejection', { error: error.message, stack: error.stack });
      this.report(error, { source: 'main:unhandledRejection', isFatal: false });
    });
  }

  /**
   * Registra e envia um relatório de erro.
   * @param {Error|Object|string} error - Objeto de erro ou mensagem
   * @param {Object} [context] - Informações contextuais adicionais
   * @returns {Promise<Object>} Dados do relatório de crash gerado
   */
  async report(error, context = {}) {
    try {
      const settings = this.getSettings ? this.getSettings() : {};
      if (settings.errorReportingEnabled === false) {
        return null; // Usuário desabilitou envio de relatórios nas configurações
      }

      const errObj = this._normalizeError(error);
      const errorKey = `${errObj.name}:${errObj.message}`;
      const now = Date.now();

      // Debounce antiflood: não envia o mesmo erro mais de 1x em 10 segundos
      if (this.recentErrors.has(errorKey)) {
        const lastSent = this.recentErrors.get(errorKey);
        if (now - lastSent < 10000) {
          return null;
        }
      }
      this.recentErrors.set(errorKey, now);

      // Limpa chaves antigas
      if (this.recentErrors.size > 50) {
        for (const [k, v] of this.recentErrors.entries()) {
          if (now - v > 60000) this.recentErrors.delete(k);
        }
      }

      const reportData = this._buildReportPayload(errObj, context);

      // 1. Salva localmente em arquivo
      const savedPath = this._saveReportToDisk(reportData);
      reportData.localFilePath = savedPath;

      // 2. Dispara envio HTTP para endpoint (se configurado)
      const targetUrl = settings.errorReportingEndpoint || this.endpointUrl;
      if (targetUrl) {
        this._dispatchHttp(targetUrl, reportData).catch(() => {});
      }

      return reportData;
    } catch (e) {
      console.error('Falha ao processar relatório de erro no ErrorReporter:', e);
      return null;
    }
  }

  /**
   * Normaliza qualquer entrada para um formato de erro padronizado.
   * @private
   */
  _normalizeError(error) {
    if (error instanceof Error) {
      return {
        name: error.name || 'Error',
        message: error.message || 'Erro desconhecido',
        stack: error.stack || '',
        code: error.code || null
      };
    }
    if (typeof error === 'object' && error !== null) {
      return {
        name: error.name || 'Error',
        message: error.message || JSON.stringify(error),
        stack: error.stack || '',
        code: error.code || null
      };
    }
    return {
      name: 'Error',
      message: String(error || 'Erro não especificado'),
      stack: '',
      code: null
    };
  }

  /**
   * Constrói o payload completo de diagnóstico.
   * @private
   */
  _buildReportPayload(errObj, context) {
    let appVersion = '1.0.2';
    try {
      if (app && app.getVersion) appVersion = app.getVersion();
    } catch (_) {}

    return {
      id: `crash_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: zonedISO(),
      developerEmail: this.developerEmail,
      app: {
        name: 'Braga Digital Studio (BDS)',
        version: appVersion,
        isPackaged: app ? app.isPackaged : false
      },
      system: {
        platform: process.platform,
        arch: process.arch,
        osType: os.type(),
        osRelease: os.release(),
        osVersion: os.version ? os.version() : '',
        totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
        cpuModel: os.cpus()?.[0]?.model || 'Unknown',
        cpuCores: os.cpus()?.length || 0,
        nodeVersion: process.version,
        electronVersion: process.versions.electron || null,
        chromeVersion: process.versions.chrome || null
      },
      error: errObj,
      context: {
        source: context.source || 'unspecified',
        isFatal: !!context.isFatal,
        action: context.action || null,
        metadata: context.metadata || {}
      },
      recentLogs: this._getRecentLogsSnippet(30)
    };
  }

  /**
   * Obtém as últimas linhas do arquivo de log do dia.
   * @private
   */
  _getRecentLogsSnippet(maxLines = 30) {
    try {
      const day = localDateKey();
      const logFile = path.join(this.logsDir, `${day}.log`);
      if (!fs.existsSync(logFile)) return [];

      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines);
    } catch (_) {
      return [];
    }
  }

  /**
   * Salva o relatório como JSON no disco.
   * @private
   */
  _saveReportToDisk(reportData) {
    try {
      const dateStr = zonedISO().replace(/[:.]/g, '-');
      const filename = `crash_${dateStr}.json`;
      const fullPath = path.join(this.crashReportsDir, filename);
      fs.writeFileSync(fullPath, JSON.stringify(reportData, null, 2), 'utf8');
      return fullPath;
    } catch (e) {
      console.error('ErrorReporter:saveToDisk:error', e.message);
      return null;
    }
  }

  /**
   * Envia o relatório via HTTP/HTTPS POST para endpoint de telemetria.
   * @private
   */
  _dispatchHttp(urlStr, data) {
    return new Promise((resolve, reject) => {
      try {
        const payload = JSON.stringify(data);
        const urlObj = new URL(urlStr);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const req = client.request(urlObj, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'User-Agent': 'BDS-ErrorReporter/1.0'
          },
          timeout: 8000
        }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode));
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout ao enviar crash report'));
        });

        req.write(payload);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Gera um link `mailto:` contendo os detalhes do erro para abertura no cliente de e-mail do usuário.
   * @param {Object} reportData
   * @returns {string} URL no esquema mailto:
   */
  generateMailtoLink(reportData) {
    const subject = encodeURIComponent(`[BDS Error Report] ${reportData.error.name}: ${reportData.error.message.slice(0, 60)}`);
    const bodyText = [
      `Olá Mauro,`,
      ``,
      `Ocorreu um erro no Braga Digital Studio:`,
      `----------------------------------------`,
      `Versão do BDS: ${reportData.app.version}`,
      `Sistema Operacional: ${reportData.system.platform} (${reportData.system.osRelease}) ${reportData.system.arch}`,
      `Data/Hora: ${reportData.timestamp}`,
      `Origem: ${reportData.context.source}`,
      ``,
      `Erro: ${reportData.error.name} - ${reportData.error.message}`,
      ``,
      `Stack Trace:`,
      `${reportData.error.stack || '(Sem stack trace)'}`,
      ``,
      `----------------------------------------`,
      `Relatório gerado automaticamente pelo BDS.`
    ].join('\n');

    return `mailto:${this.developerEmail}?subject=${subject}&body=${encodeURIComponent(bodyText)}`;
  }

  /**
   * Abre a pasta de crash reports no gerenciador de arquivos do SO.
   */
  openCrashReportsFolder() {
    if (this.crashReportsDir && fs.existsSync(this.crashReportsDir)) {
      shell.openPath(this.crashReportsDir);
    }
  }

  /**
   * Lista todos os relatórios de crash salvos localmente.
   * @returns {Array<{ filename: string, path: string, timestamp: Date, error: string }>}
   */
  /**
   * Remove todos os relatórios de crash salvos localmente.
   * @returns {{ deleted: number }} Quantidade de arquivos removidos.
   */
  clearAllReports() {
    let deleted = 0;
    try {
      if (!this.crashReportsDir || !fs.existsSync(this.crashReportsDir)) return { deleted: 0 };
      const files = fs.readdirSync(this.crashReportsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const fullPath = path.join(this.crashReportsDir, file);
          try {
            fs.unlinkSync(fullPath);
            deleted++;
          } catch (_) {}
        }
      }
      logger.info('ErrorReporter:clearAllReports', { deleted });
    } catch (e) {
      logger.error('ErrorReporter:clearAllReports:error', { error: e.message });
    }
    return { deleted };
  }

  listLocalReports() {
    try {
      if (!fs.existsSync(this.crashReportsDir)) return [];
      const files = fs.readdirSync(this.crashReportsDir);
      const reports = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const fullPath = path.join(this.crashReportsDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            reports.push({
              id: data.id,
              filename: file,
              path: fullPath,
              timestamp: data.timestamp,
              errorMessage: data.error?.message || 'Sem mensagem',
              source: data.context?.source || 'unknown'
            });
          } catch (_) {}
        }
      }

      return reports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch (e) {
      logger.error('ErrorReporter:listLocalReports:error', { error: e.message });
      return [];
    }
  }

  /**
   * Resolve o caminho de um relatório garantindo que esteja dentro de `crashReportsDir`
   * (proteção contra path traversal quando o caminho vem da UI).
   * @private
   * @param {string} filePath - Caminho absoluto ou nome de arquivo dentro de crashReportsDir
   * @returns {string|null}
   */
  _resolveReportPath(filePath) {
    try {
      if (!this.crashReportsDir || !filePath) return null;
      const base = path.resolve(this.crashReportsDir);
      const fullPath = path.resolve(filePath);
      if (fullPath !== base && !fullPath.startsWith(base + path.sep)) return null;
      return fs.existsSync(fullPath) ? fullPath : null;
    } catch (e) {
      logger.error('ErrorReporter:_resolveReportPath:error', { error: e.message });
      return null;
    }
  }

  /**
   * Gera o link mailto de um relatório já salvo em disco (ação explícita do usuário na UI).
   * @param {string} filePath - Caminho absoluto ou nome do arquivo em crashReportsDir
   * @returns {string|null}
   */
  generateMailtoFromSavedReport(filePath) {
    const fullPath = this._resolveReportPath(filePath);
    if (!fullPath) return null;
    try {
      const reportData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      return this.generateMailtoLink(reportData);
    } catch (e) {
      logger.error('ErrorReporter:generateMailtoFromSavedReport:error', { error: e.message });
      return null;
    }
  }

  /**
   * Retorna o conteúdo completo de um relatório salvo para visualização na UI.
   * @param {string} filePath - Caminho absoluto ou nome do arquivo em crashReportsDir
   * @returns {Object|null}
   */
  getReportDetails(filePath) {
    const fullPath = this._resolveReportPath(filePath);
    if (!fullPath) return null;
    try {
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (e) {
      logger.error('ErrorReporter:getReportDetails:error', { error: e.message });
      return null;
    }
  }

  /**
   * Gera um relatório manual a partir da descrição do usuário e retorna o link mailto.
   * É uma ação explícita do usuário (Relatar um Problema), portanto NÃO é bloqueada pela
   * configuração `errorReportingEnabled`, não dispara envio HTTP automático e a cópia é
   * salva localmente para constar no histórico de crash reports.
   * @param {string} description - Descrição do problema informada pelo usuário
   * @returns {string|null}
   */
  generateManualMailto(description) {
    try {
      const text = String(description || '').trim();
      if (!text) return null;

      const errObj = { name: 'ManualReport', message: text, stack: '', code: null };
      const reportData = this._buildReportPayload(errObj, {
        source: 'manual-report',
        isFatal: false,
        action: 'user-report',
        metadata: { description: text }
      });

      const savedPath = this._saveReportToDisk(reportData);
      reportData.localFilePath = savedPath;

      return this.generateMailtoLink(reportData);
    } catch (e) {
      console.error('ErrorReporter:generateManualMailto:error', e);
      return null;
    }
  }
}

// Instância singleton
const errorReporter = new ErrorReporter();

module.exports = { ErrorReporter, errorReporter };
