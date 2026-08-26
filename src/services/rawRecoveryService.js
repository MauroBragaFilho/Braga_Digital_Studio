'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const logger = require('./logService');

/**
 * Formatos RAW suportados na primeira versão (ver plano de Recuperação de Mídia).
 * Todos são containers baseados em TIFF, o que permite identificação por assinatura de bytes
 * mesmo quando o RawRecoveryEngine (binário próprio, rawpy/LibRaw) não está disponível.
 */
const SUPPORTED_RAW_EXTENSIONS = ['.cr2', '.arw', '.nef'];

const MANUFACTURER_BY_EXT = {
  '.cr2': 'Canon',
  '.arw': 'Sony',
  '.nef': 'Nikon',
};

/**
 * Registra logs técnicos detalhados da recuperação RAW em logs/recovery-raw.log
 */
function logRecovery(message, data = null) {
  try {
    const logsDir = process.env.BMD_LOGS_DIR || path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'recovery-raw.log');
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    fs.appendFileSync(logPath, `[${timestamp}] ${message}${dataStr}\n`, 'utf8');
  } catch (_) {}
}

/**
 * RawRecoveryService — Orquestração de diagnóstico e recuperação de arquivos RAW corrompidos.
 *
 * Estratégia (ver RecoveryStrategy do plano):
 *   1. DirectRecovery    — decodificar diretamente com o RawRecoveryEngine (rawpy/LibRaw)
 *   2. ReferenceRecovery — reconstrução estrutural usando um RAW íntegro da mesma câmera como referência
 *   3. ExportRecovery    — quando o RAW não pode ser reconstruído, exporta o que for legível para TIFF
 *
 * O arquivo original NUNCA é sobrescrito.
 */
class RawRecoveryService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this._currentProcess = null;
    this._cancelled = false;
  }

  /**
   * Diagnostica o RAW corrompido e analisa compatibilidade com o RAW de referência (opcional).
   * @param {string} corruptPath
   * @param {string} [referencePath]
   * @returns {Promise<object>}
   */
  async diagnose(corruptPath, referencePath = null) {
    logRecovery('Iniciando diagnóstico RAW', { corruptPath, referencePath });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('O arquivo RAW selecionado não foi encontrado no disco.');
    }

    const ext = path.extname(corruptPath).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.includes(ext)) {
      throw new Error(`Formato RAW ainda não suportado (${ext || 'desconhecido'}). Formatos suportados: CR2, ARW, NEF.`);
    }

    const corruptStats = fs.statSync(corruptPath);
    const corruptIdentify = await this._identifyRaw(corruptPath).catch(() => null);
    const signatureOk = this._checkTiffSignature(corruptPath);

    const corruptInfo = {
      path: corruptPath,
      fileName: path.basename(corruptPath),
      sizeBytes: corruptStats.size,
      format: ext.replace('.', '').toUpperCase(),
      manufacturer: corruptIdentify?.manufacturer || MANUFACTURER_BY_EXT[ext] || 'Desconhecido',
      camera: corruptIdentify?.camera || 'Desconhecido',
      resolution: corruptIdentify?.resolution || null,
      decodable: Boolean(corruptIdentify?.decodable),
      metadataReadable: signatureOk,
      severity: corruptIdentify?.decodable
        ? 'LEVE (Dados de imagem acessíveis)'
        : (signatureOk ? 'MODERADA (Cabeçalho legível, dados danificados)' : 'CRÍTICA (Assinatura de arquivo ausente)'),
    };

    let referenceInfo = null;
    let compatibility = {
      status: 'NENHUMA_REFERENCIA',
      score: 0,
      badge: 'Sem Referência',
      message: 'Recomendamos selecionar um RAW íntegro da mesma câmera para recuperação estrutural.',
      details: []
    };

    if (referencePath && fs.existsSync(referencePath)) {
      const refExt = path.extname(referencePath).toLowerCase();
      const refIdentify = await this._identifyRaw(referencePath).catch(() => null);

      if (refIdentify || this._checkTiffSignature(referencePath)) {
        const refStats = fs.statSync(referencePath);
        referenceInfo = {
          path: referencePath,
          fileName: path.basename(referencePath),
          sizeBytes: refStats.size,
          format: refExt.replace('.', '').toUpperCase(),
          manufacturer: refIdentify?.manufacturer || MANUFACTURER_BY_EXT[refExt] || 'Desconhecido',
          camera: refIdentify?.camera || 'Desconhecido',
          resolution: refIdentify?.resolution || null,
        };

        compatibility = this._calculateCompatibility(corruptInfo, referenceInfo, ext === refExt);
      } else {
        compatibility = {
          status: 'INVALIDA',
          score: 0,
          badge: 'Referência Inválida',
          message: 'O arquivo de referência selecionado também parece estar ilegível.',
          details: ['Não foi possível extrair metadados do arquivo de referência.']
        };
      }
    }

    logRecovery('Diagnóstico RAW concluído', { corruptInfo, referenceInfo, compatibility });

    return {
      corrupted: corruptInfo,
      reference: referenceInfo,
      compatibility,
      suggestedStrategy: corruptInfo.decodable ? 'DIRECT_RECOVERY' : (referenceInfo ? 'REFERENCE_RECOVERY' : 'EXPORT_RECOVERY'),
    };
  }

  /**
   * Calcula compatibilidade entre o RAW danificado e o de referência.
   */
  _calculateCompatibility(corrupt, reference, sameFormat) {
    const details = [];
    let score = 40; // Pontuação base se o arquivo de referência for íntegro

    if (sameFormat) {
      score += 20;
      details.push(`Mesmo formato RAW (${corrupt.format}).`);
    } else {
      score -= 25;
      details.push(`Formatos RAW divergentes (${corrupt.format} vs ${reference.format}).`);
    }

    if (corrupt.manufacturer !== 'Desconhecido' && corrupt.manufacturer === reference.manufacturer) {
      score += 20;
      details.push(`Mesmo fabricante (${reference.manufacturer}).`);
    } else if (corrupt.manufacturer !== 'Desconhecido') {
      score -= 20;
      details.push(`Fabricantes divergentes (${corrupt.manufacturer} vs ${reference.manufacturer}).`);
    }

    if (corrupt.camera !== 'Desconhecido' && reference.camera !== 'Desconhecido') {
      if (corrupt.camera === reference.camera) {
        score += 20;
        details.push(`Mesmo modelo de câmera (${reference.camera}).`);
      } else {
        score -= 10;
        details.push(`Modelos de câmera distintos (${corrupt.camera} vs ${reference.camera}).`);
      }
    } else {
      details.push(`Câmera de referência: ${reference.camera}.`);
    }

    score = Math.max(0, Math.min(100, score));

    let status = 'ALTA';
    let badge = 'Compatibilidade Alta';
    let message = 'Excelente compatibilidade. Alta probabilidade de reconstrução da estrutura RAW.';

    if (score < 40) {
      status = 'INCOMPATIVEL';
      badge = 'Baixa Compatibilidade';
      message = 'O arquivo selecionado pode não ser uma referência adequada para este RAW.';
    } else if (score < 75) {
      status = 'MEDIA';
      badge = 'Compatibilidade Média';
      message = 'Compatibilidade aceitável. O sistema tentará a reconstrução dos dados disponíveis.';
    }

    return { status, score, badge, message, details };
  }

  /**
   * Inicia o fluxo completo de recuperação do RAW.
   * @param {object} options
   * @param {string} options.corruptPath
   * @param {string} [options.referencePath]
   * @param {string} [options.outputDir]
   * @returns {Promise<object>}
   */
  async recoverRaw({ corruptPath, referencePath = null, outputDir = null }) {
    this._cancelled = false;
    logRecovery('Iniciando processo de recuperação RAW', { corruptPath, referencePath, outputDir });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('Arquivo RAW não encontrado.');
    }

    const targetDir = outputDir || path.dirname(corruptPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const parsedCorrupt = path.parse(corruptPath);
    const rawOutputPath = path.join(targetDir, `${parsedCorrupt.name}_recuperado${parsedCorrupt.ext || '.raw'}`);
    const tiffOutputPath = path.join(targetDir, `${parsedCorrupt.name}_recuperado.tiff`);

    this._emitStage('diagnostic', 5, 'Analisando integridade do arquivo RAW...');

    const diag = await this.diagnose(corruptPath, referencePath);
    const hasReference = Boolean(referencePath && fs.existsSync(referencePath));

    let recoverySucceeded = false;
    let methodUsed = '';
    let finalOutputPath = null;
    let lastError = null;

    // ESTRATÉGIA 1: DirectRecovery — o motor de decodificação já consegue ler o arquivo
    if (diag.corrupted.decodable) {
      try {
        this._emitStage('direct', 25, 'Exportando dados de imagem diretamente...');
        await this._exportTiff(corruptPath, tiffOutputPath);
        if (fs.existsSync(tiffOutputPath)) {
          recoverySucceeded = true;
          methodUsed = 'Recuperação Direta (Exportação)';
          finalOutputPath = tiffOutputPath;
        }
      } catch (err) {
        logRecovery('Falha na recuperação direta, prosseguindo', { error: err.message });
        lastError = err;
      }
    }

    // ESTRATÉGIA 2: ReferenceRecovery — reparo estrutural com RAW de referência
    if (!recoverySucceeded && hasReference) {
      try {
        this._emitStage('reference', 50, 'Reconstruindo estrutura do RAW com referência...');
        await this._executeReferenceRepair(referencePath, corruptPath, rawOutputPath);
        if (fs.existsSync(rawOutputPath)) {
          recoverySucceeded = true;
          methodUsed = 'Reconstrução Estrutural (Referência)';
          finalOutputPath = rawOutputPath;

          // Após o reparo estrutural, tenta também gerar um preview/TIFF de validação
          this._emitStage('validation', 80, 'Validando estrutura reconstruída...');
          await this._exportTiff(rawOutputPath, tiffOutputPath).catch(() => {});
        }
      } catch (err) {
        logRecovery('Falha na reconstrução estrutural', { error: err.message });
        lastError = err;
      }
    }

    // ESTRATÉGIA 3: ExportRecovery — sem decodificação limpa nem referência, tenta exportação tolerante a erros
    if (!recoverySucceeded) {
      try {
        this._emitStage('export', 65, 'Tentando exportação tolerante a falhas...');
        await this._exportTiff(corruptPath, tiffOutputPath, { tolerant: true });
        if (fs.existsSync(tiffOutputPath)) {
          recoverySucceeded = true;
          methodUsed = 'Exportação Parcial (Dados Disponíveis)';
          finalOutputPath = tiffOutputPath;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!recoverySucceeded) {
      const friendlyError = hasReference
        ? 'Não foi possível recuperar este arquivo RAW. O arquivo de referência pode não conter os mesmos parâmetros de gravação.'
        : 'Não foi possível concluir a recuperação direta. Selecione um RAW de referência íntegro da mesma câmera e tente novamente.';

      logRecovery('Recuperação RAW encerrada com falha', { friendlyError, lastError: lastError?.message });
      throw new Error(friendlyError);
    }

    this._emitStage('postprocessing', 90, 'Validando e indexando resultado final...');
    const finalStats = fs.statSync(finalOutputPath);
    const finalIdentify = await this._identifyRaw(finalOutputPath).catch(() => null);
    const isTiffOutput = path.extname(finalOutputPath).toLowerCase() === '.tiff';

    this._emitStage('completed', 100, 'Arquivo RAW recuperado com sucesso!');

    const result = {
      success: true,
      outputPath: finalOutputPath,
      fileName: path.basename(finalOutputPath),
      sizeBytes: finalStats.size,
      methodUsed,
      outputType: isTiffOutput ? 'TIFF (Convertido)' : `${diag.corrupted.format} (Estrutura Original)`,
      camera: finalIdentify?.camera || diag.corrupted.camera,
      resolution: finalIdentify?.resolution || diag.corrupted.resolution,
      resultQuality: methodUsed.includes('Parcial') ? 'RECUPERAÇÃO PARCIAL' : 'RECUPERAÇÃO COMPLETA',
    };

    logRecovery('Recuperação RAW concluída com sucesso', result);
    this.emit('finished', result);
    return result;
  }

  /**
   * Identifica o RAW usando o RawRecoveryEngine (rawpy/LibRaw), extraindo fabricante,
   * modelo, resolução e ISO via EXIF + LibRaw, e reportando se os dados de imagem são decodificáveis.
   */
  async _identifyRaw(filePath) {
    if (!dependencyManager.isAvailable('rawEngine')) {
      return null;
    }
    const exe = dependencyManager.resolveComponent('rawEngine');
    const data = await this._runEngineJson(exe, ['identify', filePath]);

    if (data.error && !data.decodable && !data.signatureValid) {
      throw new Error(data.error);
    }

    return {
      camera: data.camera || 'Desconhecido',
      manufacturer: data.manufacturer || 'Desconhecido',
      resolution: data.resolution || null,
      decodable: Boolean(data.decodable),
      isoSpeed: data.isoSpeed || null,
    };
  }

  /**
   * Exporta os dados de imagem do RAW para TIFF usando o RawRecoveryEngine.
   */
  async _exportTiff(sourcePath, outputPath, { tolerant = false } = {}) {
    const exe = dependencyManager.resolveComponent('rawEngine');
    const args = ['export', sourcePath, outputPath];
    if (tolerant) args.push('--tolerant');

    logRecovery('Executando exportação TIFF', { args, tolerant });

    const data = await this._runEngineJson(exe, args);

    if (!data.success) {
      throw new Error(data.error || 'O motor de decodificação não gerou dados de imagem válidos.');
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
      throw new Error('O arquivo TIFF de saída não foi gerado corretamente.');
    }
  }

  /**
   * Executa o reparo estrutural do RAW usando um arquivo de referência íntegro,
   * via RawRecoveryEngine.
   */
  async _executeReferenceRepair(referencePath, corruptPath, outputPath) {
    const exe = dependencyManager.resolveComponent('rawEngine');
    const args = ['repair', corruptPath, referencePath, outputPath];

    logRecovery('Executando reparo estrutural RAW', { args });

    this._emitStage('reference', 60, 'Reconstruindo dados de sensor e metadados...');
    const data = await this._runEngineJson(exe, args);

    if (!data.success) {
      throw new Error(data.error || 'O motor de reparo não gerou o arquivo reconstruído.');
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error('O motor de reparo não gerou o arquivo reconstruído.');
    }
  }

  /**
   * Executa o RawRecoveryEngine e faz o parsing da linha JSON impressa em stdout.
   * Mensagens de progresso (stderr) são apenas logadas, não fazem parte do resultado.
   */
  _runEngineJson(exePath, args) {
    return new Promise((resolve, reject) => {
      if (this._cancelled) return reject(new Error('Operação cancelada.'));

      const child = spawn(exePath, args, { windowsHide: true });
      this._currentProcess = child;

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

      child.on('error', (err) => {
        this._currentProcess = null;
        reject(new Error(`Falha ao executar o motor RAW: ${err.message}`));
      });

      child.on('close', () => {
        this._currentProcess = null;
        if (this._cancelled) return reject(new Error('Operação cancelada pelo usuário.'));

        const line = stdout.trim().split(/\r?\n/).pop();
        try {
          resolve(JSON.parse(line));
        } catch (_) {
          reject(new Error(`Resposta inválida do motor RAW: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
        }
      });
    });
  }

  /**
   * Verifica se o arquivo possui uma assinatura de container TIFF válida (base dos formatos
   * CR2/ARW/NEF), mesmo sem o motor de decodificação disponível.
   */
  _checkTiffSignature(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(4);
      fs.readSync(fd, buffer, 0, 4, 0);
      fs.closeSync(fd);
      const isLittleEndian = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
      const isBigEndian = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
      return isLittleEndian || isBigEndian;
    } catch (_) {
      return false;
    }
  }

  cancel() {
    this._cancelled = true;
    if (this._currentProcess) {
      try { this._currentProcess.kill('SIGKILL'); } catch (_) {}
      this._currentProcess = null;
    }
    this.emit('cancelled');
    logRecovery('Operação de recuperação RAW cancelada pelo usuário.');
  }

  _emitStage(stage, percent, message) {
    this.emit('stage', { stage, percent, message });
    this.emit('progress', { stage, percent, message });
  }
}

module.exports = RawRecoveryService;
