'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const logger = require('./logService');

/**
 * Registra logs técnicos detalhados da recuperação em logs/recovery.log
 */
function logRecovery(message, data = null) {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'recovery.log');
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    fs.appendFileSync(logPath, `[${timestamp}] ${message}${dataStr}\n`, 'utf8');
  } catch (_) {}
}

/**
 * VideoRecoveryService — Orquestração de diagnóstico e recuperação em 3 níveis de vídeos corrompidos.
 */
class VideoRecoveryService extends EventEmitter {
  constructor({ paths }) {
    super();
    this.paths = paths;
    this._currentProcess = null;
    this._cancelled = false;
  }

  /**
   * Diagnostica o arquivo corrompido e analisa compatibilidade com o vídeo de referência.
   * @param {string} corruptPath
   * @param {string} [referencePath]
   * @returns {Promise<object>}
   */
  async diagnose(corruptPath, referencePath = null) {
    logRecovery('Iniciando diagnóstico', { corruptPath, referencePath });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('O arquivo corrompido selecionado não foi encontrado no disco.');
    }

    const corruptProbe = await this._probeFile(corruptPath).catch(() => null);
    const corruptStats = fs.statSync(corruptPath);

    const corruptInfo = {
      path: corruptPath,
      fileName: path.basename(corruptPath),
      sizeBytes: corruptStats.size,
      readable: Boolean(corruptProbe && corruptProbe.format),
      codec: corruptProbe?.videoStream?.codec_name || 'Desconhecido / Ilegível',
      resolution: corruptProbe?.videoStream ? `${corruptProbe.videoStream.width}x${corruptProbe.videoStream.height}` : 'Desconhecido',
      fps: corruptProbe?.videoStream?.r_frame_rate || 'Desconhecido',
      hasAudio: Boolean(corruptProbe?.audioStream),
      durationSec: corruptProbe?.format?.duration ? parseFloat(corruptProbe.format.duration) : null,
      severity: !corruptProbe ? 'CRÍTICA (Headers ou Moov Ausente)' : (corruptProbe.format?.duration ? 'LEVE' : 'MODERADA'),
    };

    let referenceInfo = null;
    let compatibility = {
      status: 'NENHUMA_REFERENCIA',
      score: 0,
      badge: 'Sem Referência',
      message: 'Recomendamos selecionar um vídeo íntegro gravado pela mesma câmera para recuperação completa.',
      details: []
    };

    if (referencePath && fs.existsSync(referencePath)) {
      const refProbe = await this._probeFile(referencePath).catch(() => null);
      if (refProbe && refProbe.format) {
        const refStats = fs.statSync(referencePath);
        referenceInfo = {
          path: referencePath,
          fileName: path.basename(referencePath),
          sizeBytes: refStats.size,
          codec: refProbe.videoStream?.codec_name || 'Desconhecido',
          resolution: refProbe.videoStream ? `${refProbe.videoStream.width}x${refProbe.videoStream.height}` : 'Desconhecido',
          fps: refProbe.videoStream?.r_frame_rate || 'Desconhecido',
          hasAudio: Boolean(refProbe.audioStream),
          durationSec: refProbe.format.duration ? parseFloat(refProbe.format.duration) : null,
        };

        compatibility = this._calculateCompatibility(corruptInfo, referenceInfo);
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

    logRecovery('Diagnóstico concluído', { corruptInfo, referenceInfo, compatibility });

    return {
      corrupted: corruptInfo,
      reference: referenceInfo,
      compatibility,
      suggestedLevel: !corruptInfo.readable || !corruptInfo.durationSec ? 'NIVEL_2_ESTRUTURAL' : 'NIVEL_1_RAPIDO',
    };
  }

  /**
   * Calcula compatibilidade entre o vídeo danificado e o de referência.
   */
  _calculateCompatibility(corrupt, reference) {
    const details = [];
    let score = 50; // Pontuação base se o arquivo de referência for íntegro

    if (corrupt.codec !== 'Desconhecido / Ilegível' && reference.codec !== 'Desconhecido') {
      if (corrupt.codec === reference.codec) {
        score += 25;
        details.push(`Codec de vídeo compatível (${reference.codec}).`);
      } else {
        score -= 30;
        details.push(`Codecs de vídeo divergentes (${corrupt.codec} vs ${reference.codec}).`);
      }
    } else {
      details.push(`Codec de referência detectado: ${reference.codec}.`);
    }

    if (corrupt.resolution !== 'Desconhecido' && reference.resolution !== 'Desconhecido') {
      if (corrupt.resolution === reference.resolution) {
        score += 25;
        details.push(`Resolução idêntica (${reference.resolution}).`);
      } else {
        score -= 20;
        details.push(`Resoluções distintas (${corrupt.resolution} vs ${reference.resolution}).`);
      }
    } else {
      details.push(`Resolução de referência: ${reference.resolution}.`);
    }

    score = Math.max(0, Math.min(100, score));

    let status = 'ALTA';
    let badge = 'Compatibilidade Alta';
    let message = 'Excelente compatibilidade. Alta probabilidade de reconstrução total da estrutura.';

    if (score < 40) {
      status = 'INCOMPATIVEL';
      badge = 'Baixa Compatibilidade';
      message = 'O arquivo selecionado pode não ser uma referência adequada para este vídeo.';
    } else if (score < 75) {
      status = 'MEDIA';
      badge = 'Compatibilidade Média';
      message = 'Compatibilidade aceitável. O sistema tentará a reconstrução dos dados disponíveis.';
    }

    return { status, score, badge, message, details };
  }

  /**
   * Inicia o fluxo completo de recuperação do vídeo.
   * @param {object} options
   * @param {string} options.corruptPath
   * @param {string} [options.referencePath]
   * @param {string} [options.outputDir]
   * @param {string} [options.preferredLevel] 'AUTO' | 'NIVEL_1' | 'NIVEL_2'
   * @returns {Promise<object>}
   */
  async recoverVideo({ corruptPath, referencePath = null, outputDir = null, preferredLevel = 'AUTO' }) {
    this._cancelled = false;
    logRecovery('Iniciando processo de recuperação', { corruptPath, referencePath, outputDir, preferredLevel });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('Arquivo corrompido não encontrado.');
    }

    const targetDir = outputDir || path.dirname(corruptPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const parsedCorrupt = path.parse(corruptPath);
    const finalOutputPath = path.join(targetDir, `${parsedCorrupt.name}_recuperado${parsedCorrupt.ext || '.mp4'}`);

    this._emitStage('diagnostic', 5, 'Analisando integridade do arquivo...');

    const diag = await this.diagnose(corruptPath, referencePath);

    let recoverySucceeded = false;
    let methodUsed = '';
    let lastError = null;

    // Decisão do nível
    const shouldTryLevel1 = preferredLevel === 'NIVEL_1' || (preferredLevel === 'AUTO' && diag.suggestedLevel === 'NIVEL_1_RAPIDO');
    const hasReference = Boolean(referencePath && fs.existsSync(referencePath));

    // NÍVEL 1: Recuperação Rápida com FFmpeg
    if (shouldTryLevel1) {
      try {
        this._emitStage('level1', 20, 'Executando recuperação rápida de container...');
        await this._executeLevel1Recovery(corruptPath, finalOutputPath);
        const valid = await this._validateOutputFile(finalOutputPath);
        if (valid) {
          recoverySucceeded = true;
          methodUsed = 'Recuperação de Container (Nível 1)';
        }
      } catch (err) {
        logRecovery('Falha no Nível 1, prosseguindo para métodos estruturais', { error: err.message });
        lastError = err;
      }
    }

    // NÍVEL 2: Reconstrução Estrutural com Untrunc
    if (!recoverySucceeded && hasReference) {
      try {
        this._emitStage('level2', 45, 'Reconstruindo estrutura e átomos de mídia (Nível 2)...');
        await this._executeLevel2Untrunc(referencePath, corruptPath, finalOutputPath);
        const valid = await this._validateOutputFile(finalOutputPath);
        if (valid) {
          recoverySucceeded = true;
          methodUsed = 'Reconstrução Estrutural (Nível 2)';
        }
      } catch (err) {
        logRecovery('Falha no Nível 2', { error: err.message });
        lastError = err;
      }
    } else if (!recoverySucceeded && !hasReference && !shouldTryLevel1) {
      // Tentativa fallback de Nível 1 se não tiver arquivo de referência
      try {
        this._emitStage('level1_fallback', 30, 'Tentando reparo direto de índices de fluxo...');
        await this._executeLevel1Recovery(corruptPath, finalOutputPath);
        const valid = await this._validateOutputFile(finalOutputPath);
        if (valid) {
          recoverySucceeded = true;
          methodUsed = 'Reparo Direto de Índices';
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!recoverySucceeded) {
      const friendlyError = hasReference
        ? 'Não foi possível recuperar este vídeo. O arquivo de referência pode não conter os mesmos parâmetros de gravação.'
        : 'Não foi possível concluir a operação de recuperação rápida. Selecione um vídeo de referência saudável da mesma câmera e tente novamente.';
      
      logRecovery('Recuperação encerrada com falha', { friendlyError, lastError: lastError?.message });
      throw new Error(friendlyError);
    }

    // Pós-Processamento e Validação Final
    this._emitStage('postprocessing', 85, 'Validando e indexando arquivo final recuperado...');
    const finalProbe = await this._probeFile(finalOutputPath).catch(() => null);
    const finalStats = fs.statSync(finalOutputPath);

    this._emitStage('completed', 100, 'Vídeo recuperado com sucesso!');

    const result = {
      success: true,
      outputPath: finalOutputPath,
      fileName: path.basename(finalOutputPath),
      sizeBytes: finalStats.size,
      methodUsed,
      durationSec: finalProbe?.format?.duration ? parseFloat(finalProbe.format.duration) : null,
      resolution: finalProbe?.videoStream ? `${finalProbe.videoStream.width}x${finalProbe.videoStream.height}` : 'Desconhecido',
      codec: finalProbe?.videoStream?.codec_name || 'Desconhecido',
    };

    logRecovery('Recuperação concluída com sucesso', result);
    this.emit('finished', result);
    return result;
  }

  /**
   * Executa Nível 1 (FFmpeg reindex e remuxing seguro).
   */
  async _executeLevel1Recovery(corruptPath, outputPath) {
    const ffmpegExe = dependencyManager.resolveComponent('mediaEngine');
    const tempOutput = `${outputPath}.tmp_l1.mp4`;

    const args = [
      '-y',
      '-err_detect', 'ignore_err',
      '-fflags', '+genpts+discardcorrupt',
      '-i', corruptPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      tempOutput
    ];

    logRecovery('Executando FFmpeg Level 1', { args });

    await this._runProcess(ffmpegExe, args, (progress) => {
      this._emitStage('level1', 20 + Math.round(progress * 0.25), 'Reparando índices de fluxo...');
    });

    if (fs.existsSync(tempOutput)) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      fs.renameSync(tempOutput, outputPath);
    } else {
      throw new Error('FFmpeg não gerou o arquivo de saída.');
    }
  }

  /**
   * Executa Nível 2 (Untrunc com vídeo de referência).
   */
  async _executeLevel2Untrunc(referencePath, corruptPath, outputPath) {
    const untruncExe = dependencyManager.resolveComponent('recoveryEngine');
    const corruptDir = path.dirname(corruptPath);
    const corruptName = path.parse(corruptPath).name;

    const args = [referencePath, corruptPath];

    logRecovery('Executando Untrunc Level 2', { args });

    await this._runProcess(untruncExe, args, (progress) => {
      this._emitStage('level2', 45 + Math.round(progress * 0.35), 'Reconstruindo matrizes de frames e áudio...');
    });

    // Untrunc por padrão gera: <corrupt_path>_fixed.mp4
    const untruncOutputCandidates = [
      path.join(corruptDir, `${corruptName}_fixed.mp4`),
      path.join(corruptDir, `${corruptName}_fixed.mov`),
      path.join(corruptDir, `${path.basename(corruptPath)}_fixed.mp4`),
      `${corruptPath}_fixed.mp4`
    ];

    let foundOutput = null;
    for (const candidate of untruncOutputCandidates) {
      if (fs.existsSync(candidate)) {
        foundOutput = candidate;
        break;
      }
    }

    if (!foundOutput) {
      throw new Error('Untrunc não conseguiu reconstruir a estrutura do arquivo.');
    }

    // Move para o outputPath definitivo
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(foundOutput, outputPath);
  }

  /**
   * Valida se o arquivo gerado é um vídeo válido e com duração maior que 0.
   */
  async _validateOutputFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const stats = fs.statSync(filePath);
    if (stats.size < 1024) return false;

    try {
      const probe = await this._probeFile(filePath);
      return Boolean(probe && (probe.videoStream || probe.audioStream) && (probe.format?.duration > 0 || stats.size > 100000));
    } catch (_) {
      return false;
    }
  }

  /**
   * Lê metadados detalhados de um arquivo com o probeEngine.
   */
  async _probeFile(filePath) {
    const ffprobeExe = dependencyManager.resolveComponent('probeEngine');
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(ffprobeExe, args, { windowsHide: true });
      let output = '';

      child.stdout.on('data', (d) => { output += d.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && output.trim()) {
          try {
            const data = JSON.parse(output);
            const videoStream = (data.streams || []).find(s => s.codec_type === 'video');
            const audioStream = (data.streams || []).find(s => s.codec_type === 'audio');
            resolve({ format: data.format, videoStream, audioStream, raw: data });
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Falha na análise estrutural (código ${code})`));
        }
      });
    });
  }

  /**
   * Executa um processo filho de forma segura e encapsulada.
   */
  _runProcess(exePath, args, onProgress) {
    return new Promise((resolve, reject) => {
      if (this._cancelled) {
        return reject(new Error('Operação cancelada.'));
      }

      const child = spawn(exePath, args, { windowsHide: true });
      this._currentProcess = child;

      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        if (onProgress) onProgress(0.5);
      });

      child.on('error', (err) => {
        this._currentProcess = null;
        reject(err);
      });

      child.on('close', (code) => {
        this._currentProcess = null;
        if (this._cancelled) {
          return reject(new Error('Operação cancelada pelo usuário.'));
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Processo finalizado com status ${code}`));
        }
      });
    });
  }

  cancel() {
    this._cancelled = true;
    if (this._currentProcess) {
      try {
        this._currentProcess.kill('SIGKILL');
      } catch (_) {}
      this._currentProcess = null;
    }
    this.emit('cancelled');
    logRecovery('Operação de recuperação cancelada pelo usuário.');
  }

  _emitStage(stage, percent, message) {
    this.emit('stage', { stage, percent, message });
    this.emit('progress', { stage, percent, message });
  }
}

module.exports = VideoRecoveryService;
