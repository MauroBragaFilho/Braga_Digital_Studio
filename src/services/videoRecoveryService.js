'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const probeCache = require('../core/ffmpeg/ProbeCache');
const { uniqueOutputPath } = require('./uniquePath');
const {
  createRecoveryLogger, logsDirOf, recoveryLock, emitError, safeUnlink, safeRmDir, moveFile,
  isWritableDir, assessVideoOutput, parseFfmpegProgressSeconds,
} = require('./recovery/common');

// onProgress com throttle; stderr guarda só o final (~4 KB)
const PROGRESS_THROTTLE_MS = 250;
const STDERR_TAIL_BYTES = 4096;
// Contêineres que o remux do nível 1 preserva; qualquer outro vira .mp4
const REMUX_KEEP_EXT = new Set(['.mp4', '.mov', '.m4v', '.3gp']);

/**
 * VideoRecoveryService — Orquestração de diagnóstico e recuperação em 2 níveis de vídeos corrompidos.
 *
 *   Nível 1: remux com FFmpeg (rápido; serve para índice quebrado ou arquivo cortado com cabeçalho íntegro)
 *   Nível 2: reconstrução estrutural com Untrunc, usando um vídeo íntegro da mesma câmera como referência
 *
 * Todo trabalho acontece numa pasta temporária ao lado da saída; só o resultado final sai de lá.
 * O arquivo original NUNCA é alterado nem sobrescrito.
 */
class VideoRecoveryService extends EventEmitter {
  constructor({ paths } = {}) {
    super();
    this.paths = paths;
    this._currentProcess = null;
    this._cancelled = false;
    this._lastProgressAt = 0;
    this._log = createRecoveryLogger('recovery.log', () => logsDirOf(this.paths));
  }

  /**
   * Diagnostica o arquivo corrompido e analisa compatibilidade com o vídeo de referência.
   * @param {string} corruptPath
   * @param {string} [referencePath]
   * @returns {Promise<object>}
   */
  async diagnose(corruptPath, referencePath = null) {
    this._log('Iniciando diagnóstico', { corruptPath, referencePath });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('O arquivo corrompido selecionado não foi encontrado no disco.');
    }

    const corruptProbe = await this._probeFile(corruptPath).catch(() => null);
    const corruptStats = fs.statSync(corruptPath);
    const durationSec = corruptProbe?.format?.duration ? parseFloat(corruptProbe.format.duration) : null;
    const hasVideo = Boolean(corruptProbe?.videoStream);

    // Arquivo menor do que as taxas de bits e a duração declaradas pelos fluxos: foi cortado (cópia interrompida, cartão removido).
    // A taxa do formato não serve: o FFprobe a calcula a partir do próprio tamanho do arquivo.
    const streamBitRate = (parseFloat(corruptProbe?.videoStream?.bit_rate) || 0) + (parseFloat(corruptProbe?.audioStream?.bit_rate) || 0);
    const truncated = Boolean(durationSec > 0 && streamBitRate > 0 && (durationSec * streamBitRate) / 8 > corruptStats.size * 1.15);

    let severity;
    if (!corruptProbe) severity = 'CRÍTICA (Headers ou Moov Ausente)';
    else if (!hasVideo) severity = 'GRAVE (Sem fluxo de vídeo legível)';
    else if (!durationSec) severity = 'MODERADA (Duração desconhecida)';
    else if (truncated) severity = 'MODERADA (Arquivo incompleto: menor do que o esperado)';
    else severity = 'LEVE';

    const corruptInfo = {
      path: corruptPath,
      fileName: path.basename(corruptPath),
      sizeBytes: corruptStats.size,
      readable: Boolean(corruptProbe && corruptProbe.format),
      codec: corruptProbe?.videoStream?.codec_name || 'Desconhecido / Ilegível',
      resolution: corruptProbe?.videoStream ? `${corruptProbe.videoStream.width}x${corruptProbe.videoStream.height}` : 'Desconhecido',
      fps: corruptProbe?.videoStream?.r_frame_rate || 'Desconhecido',
      hasAudio: Boolean(corruptProbe?.audioStream),
      durationSec,
      truncated,
      severity,
    };

    let referenceInfo = null;
    let compatibility = {
      status: 'NENHUMA_REFERENCIA',
      score: 0,
      badge: 'Sem Referência',
      message: 'Recomendamos selecionar um vídeo íntegro gravado pela mesma câmera para recuperação completa.',
      details: [],
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
          details: ['Não foi possível extrair metadados do arquivo de referência.'],
        };
      }
    }

    this._log('Diagnóstico concluído', { corruptInfo, referenceInfo, compatibility });

    return {
      corrupted: corruptInfo,
      reference: referenceInfo,
      compatibility,
      suggestedLevel: !corruptInfo.readable || !hasVideo || !durationSec ? 'NIVEL_2_ESTRUTURAL' : 'NIVEL_1_RAPIDO',
    };
  }

  /** Calcula compatibilidade entre o vídeo danificado e o de referência. */
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

    if (corrupt.fps !== 'Desconhecido' && reference.fps !== 'Desconhecido') {
      if (corrupt.fps === reference.fps) details.push(`Mesma taxa de quadros (${reference.fps}).`);
      else { score -= 10; details.push(`Taxas de quadros distintas (${corrupt.fps} vs ${reference.fps}).`); }
    }

    if (corrupt.hasAudio !== reference.hasAudio) {
      score -= 10;
      details.push(corrupt.hasAudio ? 'A referência não tem trilha de áudio.' : 'A referência tem áudio e o arquivo danificado não foi lido com áudio.');
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
    const release = recoveryLock.acquire('video');
    this._cancelled = false;
    let workDir = null;
    try {
      this._log('Iniciando processo de recuperação', { corruptPath, referencePath, outputDir, preferredLevel });

      if (!fs.existsSync(corruptPath)) throw new Error('Arquivo corrompido não encontrado.');

      const targetDir = outputDir || path.dirname(corruptPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      workDir = fs.mkdtempSync(path.join(targetDir, '.bds-recuperando-'));

      const parsed = path.parse(corruptPath);
      const ext = parsed.ext || '.mp4';

      this._emitStage('diagnostic', 5, 'Analisando integridade do arquivo...');
      const diag = await this.diagnose(corruptPath, referencePath);
      this._throwIfCancelled();

      const hasReference = Boolean(referencePath && fs.existsSync(referencePath));
      const { plan, skipped } = this._buildPlan(preferredLevel, diag, hasReference);
      const failures = [...skipped];
      const input = { durationSec: diag.corrupted.durationSec, sizeBytes: diag.corrupted.sizeBytes };

      let best = null; // melhor resultado até agora: { file, method, info, assessment }
      for (const step of plan) {
        this._throwIfCancelled();
        const tmp = path.join(workDir, `${step.id}${step.id === 'level1' && !REMUX_KEEP_EXT.has(ext.toLowerCase()) ? '.mp4' : ext}`);
        try {
          if (step.id === 'level1') {
            this._emitStage('level1', 20, step.message);
            await this._executeLevel1Recovery(corruptPath, tmp, diag.corrupted.durationSec);
          } else {
            this._emitStage('level2', 45, step.message);
            await this._executeLevel2Untrunc(referencePath, corruptPath, tmp, workDir);
          }
          const info = await this._inspectOutput(tmp);
          if (!info) {
            failures.push(`${step.label}: o arquivo gerado não é um vídeo válido.`);
            safeUnlink(tmp);
            continue;
          }
          const assessment = assessVideoOutput(input, info);
          this._log('Tentativa concluída', { step: step.id, info, assessment });
          if (!best || info.durationSec > best.info.durationSec) {
            if (best) safeUnlink(best.file);
            best = { file: tmp, method: step.label, info, assessment, ext: path.extname(tmp) };
          } else {
            safeUnlink(tmp);
          }
          if (assessment.complete) break;
          failures.push(`${step.label}: ${assessment.warnings[0]}`);
        } catch (err) {
          if (this._cancelled) throw err;
          this._log(`Falha em ${step.label}`, { error: err.message });
          failures.push(`${step.label}: ${err.message}`);
          safeUnlink(tmp);
        }
      }

      if (!best) {
        const friendlyError = 'Não foi possível recuperar este vídeo. ' + (hasReference
          ? 'O arquivo de referência pode não conter os mesmos parâmetros de gravação.'
          : 'Selecione um vídeo de referência saudável da mesma câmera e tente novamente.')
          + (skipped.length ? ` ${skipped.join(' ')}` : '');
        this._log('Recuperação encerrada com falha', { friendlyError, failures });
        throw new Error(friendlyError);
      }

      // Pós-processamento: nome livre (nunca sobrescreve) e movimento para a pasta final
      this._emitStage('postprocessing', 90, 'Finalizando o arquivo recuperado...');
      const finalOutputPath = uniqueOutputPath(targetDir, `${parsed.name}_recuperado${best.ext}`);
      moveFile(best.file, finalOutputPath);

      const finalProbe = await this._probeFile(finalOutputPath).catch(() => null);
      const finalStats = fs.statSync(finalOutputPath);
      this._emitStage('completed', 100, 'Vídeo recuperado!');

      const result = {
        success: true,
        outputPath: finalOutputPath,
        fileName: path.basename(finalOutputPath),
        sizeBytes: finalStats.size,
        methodUsed: best.method,
        durationSec: finalProbe?.format?.duration ? parseFloat(finalProbe.format.duration) : best.info.durationSec,
        resolution: finalProbe?.videoStream ? `${finalProbe.videoStream.width}x${finalProbe.videoStream.height}` : 'Desconhecido',
        codec: finalProbe?.videoStream?.codec_name || 'Desconhecido',
        resultQuality: best.assessment.complete ? 'RECUPERAÇÃO COMPLETA' : 'RECUPERAÇÃO PARCIAL',
        warnings: best.assessment.warnings,
      };

      this._log('Recuperação concluída com sucesso', result);
      this.emit('finished', result);
      return result;
    } catch (err) {
      this._log('Recuperação interrompida', { error: err.message });
      emitError(this, err);
      throw err;
    } finally {
      safeRmDir(workDir);
      release();
    }
  }

  /**
   * Define a ordem das tentativas. Todas as aplicáveis são usadas como alternativa umas das outras.
   * @returns {{plan: Array<{id: string, label: string, message: string}>, skipped: string[]}}
   */
  _buildPlan(preferredLevel, diag, hasReference) {
    const l1 = { id: 'level1', label: diag.corrupted.readable ? 'Recuperação de Container (Nível 1)' : 'Reparo Direto de Índices', message: 'Executando recuperação rápida de container...' };
    const l2 = { id: 'level2', label: 'Reconstrução Estrutural (Nível 2)', message: 'Reconstruindo estrutura e átomos de mídia (Nível 2)...' };
    let order;
    if (preferredLevel === 'NIVEL_2') order = [l2, l1];
    else if (preferredLevel === 'NIVEL_1') order = [l1, l2];
    else order = diag.suggestedLevel === 'NIVEL_1_RAPIDO' ? [l1, l2] : [l2, l1];

    const skipped = [];
    const plan = order.filter((s) => {
      if (s.id !== 'level2') return true;
      if (!hasReference) return false; // sem referência não é falha: o nível 2 simplesmente não se aplica
      if (!this._untruncAvailable()) {
        skipped.push('O componente de recuperação de vídeo não está instalado (ative o módulo Recuperar para baixá-lo).');
        return false;
      }
      return true;
    });
    return { plan, skipped };
  }

  _untruncAvailable() {
    try { return dependencyManager.isAvailable('recoveryEngine'); } catch (_) { return false; }
  }

  /**
   * Nível 1 (FFmpeg reindex e remux seguro). Escreve em `outputPath` (já dentro da pasta temporária).
   */
  async _executeLevel1Recovery(corruptPath, outputPath, durationSec = null) {
    const ffmpegExe = dependencyManager.resolveComponent('mediaEngine');

    const args = [
      '-y',
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-progress', 'pipe:1', '-nostats',
      '-err_detect', 'ignore_err',
      '-fflags', '+genpts+discardcorrupt',
      '-i', corruptPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    this._log('Executando recuperação de nível 1 (remux)', { args });

    await this._runProcess(ffmpegExe, args, {
      onStdoutLine: (line) => {
        const sec = parseFfmpegProgressSeconds(line);
        if (sec === null) return;
        if (durationSec > 0) {
          const ratio = Math.min(1, sec / durationSec);
          this._emitStageThrottled('level1', 20 + Math.round(ratio * 25), 'Reparando índices de fluxo...');
        } else {
          this._emitStageThrottled('level1', null, 'Reparando índices de fluxo...');
        }
      },
    });

    if (!fs.existsSync(outputPath)) throw new Error('O motor de mídia não gerou o arquivo de saída.');
  }

  /**
   * Nível 2 (Untrunc com vídeo de referência). O Untrunc grava "<nome>_fixed<ext>" ao lado do arquivo
   * de origem: se essa pasta não aceita escrita, trabalha numa cópia dentro da pasta temporária; saídas
   * antigas com o mesmo nome nunca são aceitas nem apagadas, e as criadas por esta execução são limpas.
   */
  async _executeLevel2Untrunc(referencePath, corruptPath, outputPath, workDir) {
    const untruncExe = dependencyManager.resolveComponent('recoveryEngine');

    let source = corruptPath;
    if (!isWritableDir(path.dirname(corruptPath))) {
      source = path.join(workDir, `origem${path.extname(corruptPath)}`);
      this._log('Pasta de origem somente leitura: trabalhando em cópia', { source });
      await fs.promises.copyFile(corruptPath, source);
    }

    const srcDir = path.dirname(source);
    // O Untrunc nomeia a saída "<nome completo>_fixed.<ext>" (ex.: clip.mp4_fixed.mp4); versões antigas usavam "<nome>_fixed.<ext>"
    const prefix = [`${path.basename(source)}_fixed`, `${path.parse(source).name}_fixed`];
    const before = this._listFixed(srcDir, prefix);
    const args = [referencePath, source];

    this._log('Executando recuperação de nível 2 (reconstrução)', { args });
    let created = [];
    try {
      await this._runProcess(untruncExe, args, {
        onOutput: (chunk) => {
          const m = /(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(chunk);
          if (m) this._emitStageThrottled('level2', 45 + Math.round(Math.min(100, parseFloat(m[1].replace(',', '.'))) * 0.35), 'Reconstruindo matrizes de frames e áudio...');
        },
      });
    } finally {
      created = this._newFixed(srcDir, prefix, before);
    }

    try {
      if (!created.length) throw new Error('O motor de recuperação não conseguiu reconstruir a estrutura do arquivo.');
      // Se houver mais de uma saída nova, a maior é a reconstrução completa
      created.sort((a, b) => b.size - a.size);
      moveFile(created[0].file, outputPath);
    } finally {
      created.forEach((c) => safeUnlink(c.file));
      if (source !== corruptPath) safeUnlink(source);
    }
  }

  /** Arquivos que começam com algum dos prefixos (texto ou lista) na pasta, com data de modificação. */
  _listFixed(dir, prefix) {
    const map = new Map();
    const prefixes = [].concat(prefix).map((p) => p.toLowerCase());
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!prefixes.some((p) => name.toLowerCase().startsWith(p))) continue;
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) map.set(name, st.mtimeMs);
      }
    } catch (_) { /* pasta ilegível: nada a listar */ }
    return map;
  }

  /** Saídas criadas (ou reescritas) depois do snapshot `before`. */
  _newFixed(dir, prefix, before) {
    const out = [];
    for (const [name, mtime] of this._listFixed(dir, prefix)) {
      if (before.has(name) && before.get(name) === mtime) continue;
      const file = path.join(dir, name);
      try { out.push({ file, size: fs.statSync(file).size }); } catch (_) { /* sumiu */ }
    }
    return out;
  }

  /**
   * Confere se o arquivo gerado é um vídeo (ou áudio) válido, com duração e tamanho plausíveis.
   * @returns {Promise<{durationSec: number, sizeBytes: number}|null>}
   */
  async _inspectOutput(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stats = fs.statSync(filePath);
    if (stats.size < 1024) return null;

    try {
      const probe = await this._probeLight(filePath);
      if (!probe || !(probe.hasVideo || probe.hasAudio) || !(probe.duration > 0)) return null;
      return { durationSec: probe.duration, sizeBytes: stats.size };
    } catch (_) {
      return null;
    }
  }

  /**
   * Probe mínimo para validar a saída (só duração e tipos de stream, sem JSON completo de format/streams).
   * Não usa cache: o arquivo de saída acabou de ser gerado.
   */
  async _probeLight(filePath) {
    const ffprobeExe = dependencyManager.resolveComponent('probeEngine');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-print_format', 'json',
      filePath,
    ];
    return new Promise((resolve, reject) => {
      const child = processRunner.spawn(ffprobeExe, args);
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; processRunner.cancel(child); }, 60000);
      if (timer.unref) timer.unref();
      child.stdout.on('data', (d) => { output += d.toString('utf8'); });
      child.stderr.resume();
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('Tempo limite excedido na validação do arquivo.'));
        if (code !== 0 || !output.trim()) return reject(new Error(`Falha na validação (código ${code})`));
        try {
          const data = JSON.parse(output);
          const streams = data.streams || [];
          resolve({
            duration: parseFloat(data.format?.duration) || 0,
            hasVideo: streams.some((s) => s.codec_type === 'video'),
            hasAudio: streams.some((s) => s.codec_type === 'audio'),
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Lê metadados detalhados de um arquivo com o probeEngine. */
  async _probeFile(filePath) {
    return probeCache.getOrLoad(filePath, () => this._probeFileRaw(filePath), 'recovery-probe');
  }

  async _probeFileRaw(filePath) {
    const ffprobeExe = dependencyManager.resolveComponent('probeEngine');
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];

    return new Promise((resolve, reject) => {
      const child = processRunner.spawn(ffprobeExe, args);
      let output = '';
      let timedOut = false;
      // ffprobe travado não pode deixar a recuperação pendurada: encerra a árvore após 60s
      const timer = setTimeout(() => { timedOut = true; processRunner.cancel(child); }, 60000);
      if (timer.unref) timer.unref();

      child.stdout.on('data', (d) => { output += d.toString('utf8'); });
      child.stderr.resume(); // nunca lido: sem drenar, o pipe pode encher e travar o ffprobe
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('Tempo limite excedido na análise estrutural do arquivo.'));
        if (code === 0 && output.trim()) {
          try {
            const data = JSON.parse(output);
            const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
            const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');
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
   * @param {string} exePath
   * @param {string[]} args
   * @param {{onStdoutLine?: (line: string) => void, onOutput?: (chunk: string) => void}} [hooks]
   *   onStdoutLine: cada linha do stdout (separada por \n ou \r); onOutput: cada trecho de stdout/stderr
   */
  _runProcess(exePath, args, { onStdoutLine = null, onOutput = null } = {}) {
    return new Promise((resolve, reject) => {
      if (this._cancelled) {
        return reject(new Error('Operação cancelada.'));
      }

      const child = processRunner.spawn(exePath, args);
      this._currentProcess = child;

      let stderr = '';
      let pending = '';
      child.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
        if (onOutput) onOutput(text);
      });
      // stdout sempre é drenado: pipe cheio bloquearia o processo
      child.stdout.on('data', (d) => {
        const text = d.toString('utf8');
        if (onOutput) onOutput(text);
        if (!onStdoutLine) return;
        pending += text;
        const lines = pending.split(/\r\n|\n|\r/);
        pending = lines.pop();
        lines.forEach((l) => onStdoutLine(l));
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
          if (stderr) this._log('Saída de erro do processo', { code, stderr: stderr.slice(-1000) });
          reject(new Error(`Processo finalizado com status ${code}`));
        }
      });
    });
  }

  _throwIfCancelled() {
    if (this._cancelled) throw new Error('Operação cancelada pelo usuário.');
  }

  cancel() {
    this._cancelled = true;
    // Encerra a árvore de processos (ffmpeg/untrunc podem ter filhos); resolve quando terminou
    const killed = processRunner.cancel(this._currentProcess);
    this._currentProcess = null;
    this.emit('cancelled');
    this._log('Operação de recuperação cancelada pelo usuário.');
    return killed;
  }

  _emitStage(stage, percent, message) {
    this.emit('stage', { stage, percent, message });
    this.emit('progress', { stage, percent, message });
  }

  /** Progresso frequente (saída do processo): no máximo um evento a cada 250 ms. */
  _emitStageThrottled(stage, percent, message) {
    const now = Date.now();
    if (now - this._lastProgressAt < PROGRESS_THROTTLE_MS) return;
    this._lastProgressAt = now;
    this._emitStage(stage, percent, message);
  }
}

module.exports = VideoRecoveryService;
