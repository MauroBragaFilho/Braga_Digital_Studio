'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { uniqueOutputPath } = require('./uniquePath');
const {
  createRecoveryLogger, logsDirOf, recoveryLock, emitError, safeUnlink,
} = require('./recovery/common');
const {
  readPhotoFile, scanJpeg, hasDecodableHeaders, indexOfSoi, findEmbeddedJpegs, pickBestJpeg, trimTrailingZeros,
} = require('./recovery/photoCarver');
const { decodeCheck } = require('./recovery/photoDecodeCheck');

const EOI = Buffer.from([0xff, 0xd9]);

/**
 * JpgRecoveryService — diagnóstico e reparo de fotos JPG corrompidas ou cortadas.
 *
 * Estratégias (da mais fiel para a menos):
 *   1. Limpeza        — o JPG está completo, mas há bytes extras antes/depois (comum em arquivos recuperados do cartão)
 *   2. Fechamento     — a foto foi cortada no meio: mantém o que existe e fecha o arquivo (parte de baixo some/fica cinza)
 *   3. Miniatura      — a imagem principal é inaproveitável: extrai o maior JPEG embutido (miniatura do EXIF)
 *
 * O arquivo original NUNCA é alterado: a saída é sempre um arquivo novo "<nome>_recuperado.jpg".
 */
class JpgRecoveryService extends EventEmitter {
  constructor({ paths, decodeCheckFn = decodeCheck } = {}) {
    super();
    this.paths = paths;
    this._cancelled = false;
    this._decodeCheck = decodeCheckFn;
    this._log = createRecoveryLogger('recovery-jpg.log', () => logsDirOf(this.paths));
  }

  /** Analisa o arquivo e diz qual estratégia se aplica. A referência não é usada para JPG. */
  async diagnose(corruptPath, _referencePath = null) {
    this._log('Iniciando diagnóstico JPG', { corruptPath });
    if (!fs.existsSync(corruptPath)) throw new Error('O arquivo JPG selecionado não foi encontrado no disco.');

    const buf = readPhotoFile(corruptPath);
    const analysis = this._analyze(buf);
    const check = analysis.mainOk ? await this._decodeCheck(corruptPath).catch(() => null) : null;

    const m = analysis.main;
    const corruptInfo = {
      path: corruptPath,
      fileName: path.basename(corruptPath),
      sizeBytes: buf.length,
      format: 'JPG',
      readable: Boolean(analysis.mainOk),
      complete: Boolean(m && m.complete),
      truncated: Boolean(m && hasDecodableHeaders(m) && !m.complete),
      resolution: m && m.width ? `${m.width}x${m.height}` : null,
      hasMetadata: Boolean(m && m.hasExif),
      leadingBytes: analysis.soi > 0 ? analysis.soi : 0,
      trailingBytes: m && m.complete ? Math.max(0, buf.length - m.end) : 0,
      decodable: check ? check.decoded : null,
      embeddedPreviews: analysis.embedded.length,
      severity: this._severity(analysis, check),
    };

    const diagnosis = {
      corrupted: corruptInfo,
      reference: null,
      compatibility: {
        status: 'NENHUMA_REFERENCIA',
        score: 0,
        badge: 'Referência não necessária',
        message: 'Para JPG o reparo usa só o próprio arquivo; não precisa de uma foto de referência.',
        details: [],
      },
      suggestedStrategy: analysis.strategy,
    };
    this._log('Diagnóstico JPG concluído', diagnosis);
    return diagnosis;
  }

  /**
   * Recupera o JPG.
   * @param {{corruptPath: string, outputDir?: string|null}} options
   */
  async recoverJpg({ corruptPath, outputDir = null }) {
    const release = recoveryLock.acquire('jpg');
    this._cancelled = false;
    let partPath = null;
    try {
      this._log('Iniciando recuperação JPG', { corruptPath, outputDir });
      if (!fs.existsSync(corruptPath)) throw new Error('Arquivo JPG não encontrado.');

      const targetDir = outputDir || path.dirname(corruptPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      this._emitStage('diagnostic', 5, 'Analisando a estrutura da foto...');
      const buf = readPhotoFile(corruptPath);
      const analysis = this._analyze(buf);
      this._throwIfCancelled();

      const plan = this._plan(buf, analysis);
      if (!plan.length) {
        const msg = 'Não foi possível recuperar esta foto: o cabeçalho da imagem está destruído e não há miniatura aproveitável no arquivo.';
        this._log('Recuperação JPG sem estratégia aplicável', { analysis: { soi: analysis.soi, strategy: analysis.strategy } });
        throw new Error(msg);
      }

      // Foto já íntegra: nada a reparar
      if (plan[0].unchanged) {
        const check = await this._decodeCheck(corruptPath).catch(() => null);
        if (!check || check.ok) {
          this._emitStage('completed', 100, 'A foto já está íntegra; nada precisou ser reparado.');
          const result = {
            success: true, unchanged: true, outputPath: corruptPath, fileName: path.basename(corruptPath),
            sizeBytes: buf.length, methodUsed: 'Nenhum reparo necessário',
            resolution: `${analysis.main.width}x${analysis.main.height}`, outputType: 'JPG (original)',
            resultQuality: 'ARQUIVO ÍNTEGRO', warnings: [],
          };
          this.emit('finished', result);
          return result;
        }
        plan.shift(); // íntegro na estrutura, mas não decodifica: tenta as demais
      }

      let lastWarning = null;
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        this._throwIfCancelled();
        this._emitStage('repair', 30 + i * 20, step.message);

        const stem = path.parse(corruptPath).name;
        const finalPath = uniqueOutputPath(targetDir, `${stem}_recuperado.jpg`);
        partPath = `${finalPath}.part`;
        fs.writeFileSync(partPath, step.build());

        this._emitStage('validation', 80, 'Validando a foto recuperada...');
        const check = await this._decodeCheck(partPath).catch(() => null);
        if (check && !check.decoded) {
          lastWarning = check.message;
          this._log('Candidato JPG não decodifica', { method: step.method, message: check.message });
          safeUnlink(partPath);
          partPath = null;
          continue;
        }

        fs.renameSync(partPath, finalPath);
        partPath = null;
        this._emitStage('completed', 100, 'Foto recuperada!');
        const warnings = [...step.warnings];
        if (check && !check.ok && check.message) warnings.push('A foto abre, mas o decodificador apontou avisos de dados danificados.');
        const result = {
          success: true,
          outputPath: finalPath,
          fileName: path.basename(finalPath),
          sizeBytes: fs.statSync(finalPath).size,
          methodUsed: step.method,
          resolution: `${step.width}x${step.height}`,
          outputType: step.outputType,
          resultQuality: step.partial ? 'RECUPERAÇÃO PARCIAL' : 'RECUPERAÇÃO COMPLETA',
          warnings,
        };
        this._log('Recuperação JPG concluída', result);
        this.emit('finished', result);
        return result;
      }

      throw new Error(`Não foi possível recuperar esta foto${lastWarning ? ' (os candidatos gerados não abrem)' : ''}.`);
    } catch (err) {
      if (partPath) safeUnlink(partPath);
      this._log('Recuperação JPG encerrada com falha', { error: err.message });
      emitError(this, err);
      throw err;
    } finally {
      release();
    }
  }

  /** Posição, estrutura e miniaturas do arquivo. */
  _analyze(buf) {
    const soi = indexOfSoi(buf, 0);
    const main = soi >= 0 ? scanJpeg(buf, soi) : null;
    const mainOk = Boolean(main && hasDecodableHeaders(main));
    const embedded = findEmbeddedJpegs(buf).filter((s) => !main || s.start !== main.start);
    let strategy = 'IMPOSSIVEL';
    if (mainOk && main.complete) strategy = (soi === 0 && main.end === buf.length) ? 'NENHUM_REPARO' : 'LIMPEZA';
    else if (mainOk) strategy = 'FECHAR_ARQUIVO';
    else if (embedded.length) strategy = 'EXTRAIR_MINIATURA';
    return { soi, main, mainOk, embedded, strategy };
  }

  _severity(analysis, check) {
    switch (analysis.strategy) {
      case 'NENHUM_REPARO': return check && !check.decoded ? 'MODERADA (Estrutura íntegra, mas a imagem não decodifica)' : 'LEVE (Arquivo aparentemente íntegro)';
      case 'LIMPEZA': return 'LEVE (Bytes extras ao redor da imagem)';
      case 'FECHAR_ARQUIVO': return 'MODERADA (Arquivo cortado antes do fim)';
      case 'EXTRAIR_MINIATURA': return 'CRÍTICA (Imagem principal inutilizável; só há miniatura)';
      default: return 'CRÍTICA (Nenhuma imagem JPEG encontrada)';
    }
  }

  /** Lista, em ordem de preferência, o que dá para gerar. Cada item tem `build()` que devolve o Buffer. */
  _plan(buf, analysis) {
    const plan = [];
    const { soi, main, mainOk, embedded } = analysis;

    if (mainOk && main.complete) {
      if (analysis.strategy === 'NENHUM_REPARO') {
        plan.push({ unchanged: true });
      }
      plan.push({
        method: 'Limpeza de dados extras',
        message: 'Removendo bytes extras ao redor da imagem...',
        outputType: 'JPG (completo)', partial: false, warnings: [],
        width: main.width, height: main.height,
        build: () => buf.subarray(soi, main.end),
      });
    } else if (mainOk) {
      const end = Math.max(trimTrailingZeros(buf, soi, main.end), soi + 4);
      plan.push({
        method: 'Fechamento do arquivo cortado',
        message: 'Fechando o arquivo no ponto em que foi cortado...',
        outputType: 'JPG (parcial)', partial: true,
        warnings: ['A foto estava cortada: a parte final da imagem (de baixo) não pôde ser recuperada.'],
        width: main.width, height: main.height,
        build: () => Buffer.concat([buf.subarray(soi, end), EOI]),
      });
    }

    const best = pickBestJpeg(embedded);
    if (best) {
      const end = best.complete ? best.end : Math.max(trimTrailingZeros(buf, best.start, best.end), best.start + 4);
      plan.push({
        method: 'Extração da miniatura embutida',
        message: 'Extraindo a miniatura embutida no arquivo...',
        outputType: 'JPG (miniatura)', partial: true,
        warnings: [`Só foi possível recuperar a miniatura (${best.width}x${best.height}); a resolução original se perdeu.`],
        width: best.width, height: best.height,
        build: () => (best.complete ? buf.subarray(best.start, end) : Buffer.concat([buf.subarray(best.start, end), EOI])),
      });
    }
    return plan;
  }

  _throwIfCancelled() {
    if (this._cancelled) throw new Error('Operação cancelada pelo usuário.');
  }

  cancel() {
    this._cancelled = true;
    this.emit('cancelled');
    this._log('Operação de recuperação JPG cancelada pelo usuário.');
    return Promise.resolve();
  }

  _emitStage(stage, percent, message) {
    this.emit('stage', { stage, percent, message });
    this.emit('progress', { stage, percent, message });
  }
}

module.exports = JpgRecoveryService;
