'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const { processRunner } = require('../infrastructure/external-tools/ProcessRunner');
const { uniqueOutputPath } = require('./uniquePath');
const { createRecoveryLogger, logsDirOf, recoveryLock, emitError, safeUnlink } = require('./recovery/common');
const {
  readPhotoFile, detectContainer, readTiffMakeModel, findEmbeddedJpegs, pickBestJpeg, trimTrailingZeros,
} = require('./recovery/photoCarver');
const { decodeCheck } = require('./recovery/photoDecodeCheck');

/**
 * Formatos RAW reconhecidos. O JPEG de pré-visualização embutido é localizado por varredura de
 * assinatura, então não depende do índice (IFD) do arquivo estar íntegro nem do formato exato.
 */
const MANUFACTURER_BY_EXT = {
  '.cr2': 'Canon', '.cr3': 'Canon', '.crw': 'Canon',
  '.arw': 'Sony', '.sr2': 'Sony', '.srf': 'Sony',
  '.nef': 'Nikon', '.nrw': 'Nikon',
  '.raf': 'Fujifilm',
  '.orf': 'Olympus',
  '.rw2': 'Panasonic',
  '.pef': 'Pentax',
  '.srw': 'Samsung',
  '.3fr': 'Hasselblad',
  '.erf': 'Epson',
  '.kdc': 'Kodak',
  '.mrw': 'Minolta',
  '.dng': 'Adobe DNG',
};
const SUPPORTED_RAW_EXTENSIONS = Object.keys(MANUFACTURER_BY_EXT);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * RawRecoveryService — diagnóstico e recuperação de arquivos RAW corrompidos.
 *
 * Estratégias, na ordem em que são tentadas:
 *   1. DirectRecovery    — [motor RAW, se instalado] decodifica e exporta os dados do sensor para TIFF
 *   2. ReferenceRecovery — [motor RAW, se instalado] reconstrução estrutural com um RAW íntegro da mesma câmera
 *   3. ExportRecovery    — [motor RAW, se instalado] exportação tolerante a erros (parcial)
 *   4. PreviewRecovery   — extrai o JPEG de pré-visualização embutido no RAW (sempre disponível, sem ferramentas externas)
 *
 * Sem o motor RAW, só a estratégia 4 roda: o resultado é um JPG (pré-visualização), não o RAW reconstruído.
 * O arquivo original NUNCA é sobrescrito.
 */
class RawRecoveryService extends EventEmitter {
  constructor({ paths, decodeCheckFn = decodeCheck } = {}) {
    super();
    this.paths = paths;
    this._currentProcess = null;
    this._cancelled = false;
    this._decodeCheck = decodeCheckFn;
    this._log = createRecoveryLogger('recovery-raw.log', () => logsDirOf(this.paths));
  }

  /** O motor RAW (instalação manual) está disponível? */
  _engineAvailable() {
    try { return dependencyManager.isAvailable('rawEngine'); } catch (_) { return false; }
  }

  /**
   * Diagnostica o RAW corrompido e analisa compatibilidade com o RAW de referência (opcional).
   */
  async diagnose(corruptPath, referencePath = null) {
    this._log('Iniciando diagnóstico RAW', { corruptPath, referencePath });

    if (!fs.existsSync(corruptPath)) {
      throw new Error('O arquivo RAW selecionado não foi encontrado no disco.');
    }

    const ext = path.extname(corruptPath).toLowerCase();
    this._assertSupported(ext);

    const buf = readPhotoFile(corruptPath);
    const engine = this._engineAvailable();
    const identify = engine ? await this._identifyRaw(corruptPath).catch(() => null) : null;
    const container = detectContainer(buf);
    const makeModel = readTiffMakeModel(buf);
    const best = pickBestJpeg(findEmbeddedJpegs(buf));

    const corruptInfo = {
      path: corruptPath,
      fileName: path.basename(corruptPath),
      sizeBytes: buf.length,
      format: ext.replace('.', '').toUpperCase(),
      manufacturer: identify?.manufacturer && identify.manufacturer !== 'Desconhecido' ? identify.manufacturer : (makeModel?.make || MANUFACTURER_BY_EXT[ext] || 'Desconhecido'),
      camera: identify?.camera && identify.camera !== 'Desconhecido' ? identify.camera : (makeModel?.model || 'Desconhecido'),
      resolution: identify?.resolution || null,
      decodable: Boolean(identify?.decodable),
      metadataReadable: Boolean(container),
      previewAvailable: Boolean(best),
      previewResolution: best ? `${best.width}x${best.height}` : null,
      previewComplete: best ? best.complete : false,
      engineAvailable: engine,
      severity: this._severity(identify, container, best),
    };

    let referenceInfo = null;
    let compatibility = {
      status: 'NENHUMA_REFERENCIA',
      score: 0,
      badge: 'Sem Referência',
      message: engine
        ? 'Recomendamos selecionar um RAW íntegro da mesma câmera para recuperação estrutural.'
        : 'A referência só é usada pelo reparo estrutural, que depende do motor RAW (não instalado). Será extraída a pré-visualização embutida.',
      details: [],
    };

    if (referencePath && fs.existsSync(referencePath)) {
      const refExt = path.extname(referencePath).toLowerCase();
      let refBuf = null;
      try { refBuf = readPhotoFile(referencePath); } catch (_) { /* tratada abaixo */ }
      const refContainer = refBuf ? detectContainer(refBuf) : null;
      const refMakeModel = refBuf ? readTiffMakeModel(refBuf) : null;
      const refIdentify = engine ? await this._identifyRaw(referencePath).catch(() => null) : null;

      if (refIdentify || refContainer) {
        referenceInfo = {
          path: referencePath,
          fileName: path.basename(referencePath),
          sizeBytes: refBuf ? refBuf.length : fs.statSync(referencePath).size,
          format: refExt.replace('.', '').toUpperCase(),
          manufacturer: refIdentify?.manufacturer && refIdentify.manufacturer !== 'Desconhecido' ? refIdentify.manufacturer : (refMakeModel?.make || MANUFACTURER_BY_EXT[refExt] || 'Desconhecido'),
          camera: refIdentify?.camera && refIdentify.camera !== 'Desconhecido' ? refIdentify.camera : (refMakeModel?.model || 'Desconhecido'),
          resolution: refIdentify?.resolution || null,
        };
        compatibility = this._calculateCompatibility(corruptInfo, referenceInfo, ext === refExt);
        if (!engine) compatibility.details.push('Sem o motor RAW, a referência não será usada nesta recuperação.');
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

    let suggestedStrategy = 'IMPOSSIVEL';
    if (engine && corruptInfo.decodable) suggestedStrategy = 'DIRECT_RECOVERY';
    else if (engine && referenceInfo && compatibility.status !== 'INVALIDA') suggestedStrategy = 'REFERENCE_RECOVERY';
    else if (best) suggestedStrategy = 'PREVIEW_RECOVERY';
    else if (engine) suggestedStrategy = 'EXPORT_RECOVERY';

    this._log('Diagnóstico RAW concluído', { corruptInfo, referenceInfo, compatibility });
    return { corrupted: corruptInfo, reference: referenceInfo, compatibility, suggestedStrategy };
  }

  _assertSupported(ext) {
    if (!SUPPORTED_RAW_EXTENSIONS.includes(ext)) {
      const list = SUPPORTED_RAW_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(', ');
      throw new Error(`Formato RAW ainda não suportado (${ext || 'desconhecido'}). Formatos suportados: ${list}.`);
    }
  }

  _severity(identify, container, best) {
    if (identify?.decodable) return 'LEVE (Dados de imagem acessíveis)';
    if (best && best.complete) return container
      ? 'MODERADA (Cabeçalho legível, dados do sensor danificados; pré-visualização aproveitável)'
      : 'GRAVE (Cabeçalho ilegível; só a pré-visualização embutida é aproveitável)';
    if (best) return 'GRAVE (Só um trecho da pré-visualização embutida é aproveitável)';
    return container ? 'CRÍTICA (Cabeçalho legível, mas sem dados de imagem aproveitáveis)' : 'CRÍTICA (Assinatura de arquivo ausente)';
  }

  /** Calcula compatibilidade entre o RAW danificado e o de referência. */
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
   */
  async recoverRaw({ corruptPath, referencePath = null, outputDir = null }) {
    const release = recoveryLock.acquire('raw');
    this._cancelled = false;
    const created = []; // saídas parciais desta execução, apagadas se nenhuma estratégia der certo
    try {
      this._log('Iniciando processo de recuperação RAW', { corruptPath, referencePath, outputDir });

      if (!fs.existsSync(corruptPath)) throw new Error('Arquivo RAW não encontrado.');
      this._assertSupported(path.extname(corruptPath).toLowerCase());

      const targetDir = outputDir || path.dirname(corruptPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      const parsed = path.parse(corruptPath);
      this._emitStage('diagnostic', 5, 'Analisando integridade do arquivo RAW...');
      const diag = await this.diagnose(corruptPath, referencePath);
      this._throwIfCancelled();

      const engine = diag.corrupted.engineAvailable;
      const hasReference = Boolean(referencePath && fs.existsSync(referencePath));
      const failures = [];

      const result = await (async () => {
        // ESTRATÉGIA 1: DirectRecovery
        if (engine && diag.corrupted.decodable) {
          const out = uniqueOutputPath(targetDir, `${parsed.name}_recuperado.tiff`);
          created.push(out);
          try {
            this._emitStage('direct', 25, 'Exportando dados de imagem diretamente...');
            await this._exportTiff(corruptPath, out);
            return this._finish({ out, diag, method: 'Recuperação Direta (Exportação)', outputType: 'TIFF (Convertido)', partial: false, warnings: [] });
          } catch (err) {
            this._cancelledOrThrow(err);
            failures.push(`Exportação direta: ${err.message}`); safeUnlink(out);
          }
        }

        // ESTRATÉGIA 2: ReferenceRecovery
        if (engine && hasReference) {
          const out = uniqueOutputPath(targetDir, `${parsed.name}_recuperado${parsed.ext || '.raw'}`);
          created.push(out);
          try {
            this._emitStage('reference', 45, 'Reconstruindo estrutura do RAW com referência...');
            await this._executeReferenceRepair(referencePath, corruptPath, out);
            this._emitStage('validation', 75, 'Validando estrutura reconstruída...');
            return this._finish({ out, diag, method: 'Reconstrução Estrutural (Referência)', outputType: `${diag.corrupted.format} (Estrutura Original)`, partial: false, warnings: [] });
          } catch (err) {
            this._cancelledOrThrow(err);
            failures.push(`Reconstrução com referência: ${err.message}`); safeUnlink(out);
          }
        }

        // ESTRATÉGIA 3: ExportRecovery (tolerante a erros)
        if (engine) {
          const out = uniqueOutputPath(targetDir, `${parsed.name}_recuperado.tiff`);
          created.push(out);
          try {
            this._emitStage('export', 60, 'Tentando exportação tolerante a falhas...');
            await this._exportTiff(corruptPath, out, { tolerant: true });
            return this._finish({ out, diag, method: 'Exportação Parcial (Dados Disponíveis)', outputType: 'TIFF (Convertido)', partial: true, warnings: ['Parte dos dados do sensor estava danificada; a imagem pode ter áreas faltando.'] });
          } catch (err) {
            this._cancelledOrThrow(err);
            failures.push(`Exportação parcial: ${err.message}`); safeUnlink(out);
          }
        }

        // ESTRATÉGIA 4: PreviewRecovery (sempre disponível)
        this._emitStage('preview', 80, 'Procurando a pré-visualização embutida no arquivo...');
        const preview = await this._recoverPreview(corruptPath, targetDir, parsed.name, created);
        if (preview) return this._finish({ out: preview.out, diag, method: 'Extração da Pré-visualização Embutida', outputType: 'JPG (Pré-visualização)', partial: true, warnings: preview.warnings, resolution: preview.resolution });
        failures.push('Pré-visualização: não há JPEG aproveitável dentro do arquivo.');
        return null;
      })();

      if (!result) {
        const friendlyError = engine
          ? (hasReference
            ? 'Não foi possível recuperar este arquivo RAW. O arquivo de referência pode não conter os mesmos parâmetros de gravação.'
            : 'Não foi possível recuperar este arquivo RAW. Selecione um RAW de referência íntegro da mesma câmera e tente novamente.')
          : 'Não foi possível recuperar este arquivo RAW: não há pré-visualização aproveitável dentro dele e o reparo completo depende do motor RAW, que não está instalado.';
        this._log('Recuperação RAW encerrada com falha', { friendlyError, failures });
        throw new Error(friendlyError);
      }

      this._emitStage('completed', 100, 'Arquivo recuperado!');
      this._log('Recuperação RAW concluída com sucesso', result);
      this.emit('finished', result);
      return result;
    } catch (err) {
      created.forEach(safeUnlink);
      this._log('Recuperação RAW interrompida', { error: err.message });
      emitError(this, err);
      throw err;
    } finally {
      release();
    }
  }

  /** Monta o objeto de resultado depois de validar a saída (mantém o arquivo gerado). */
  async _finish({ out, diag, method, outputType, partial, warnings, resolution = null }) {
    this._emitStage('postprocessing', 92, 'Validando e indexando resultado final...');
    const stats = fs.statSync(out);
    const finalIdentify = path.extname(out).toLowerCase() === '.jpg' || !this._engineAvailable()
      ? null
      : await this._identifyRaw(out).catch(() => null);
    return {
      success: true,
      outputPath: out,
      fileName: path.basename(out),
      sizeBytes: stats.size,
      methodUsed: method,
      outputType,
      camera: finalIdentify?.camera || diag.corrupted.camera,
      resolution: resolution || finalIdentify?.resolution || diag.corrupted.resolution || diag.corrupted.previewResolution,
      resultQuality: partial ? 'RECUPERAÇÃO PARCIAL' : 'RECUPERAÇÃO COMPLETA',
      warnings,
    };
  }

  /** Extrai o melhor JPEG embutido. Devolve { out, warnings, resolution } ou null. */
  async _recoverPreview(corruptPath, targetDir, stem, created) {
    const buf = readPhotoFile(corruptPath);
    const best = pickBestJpeg(findEmbeddedJpegs(buf));
    if (!best) return null;

    const data = best.complete
      ? buf.subarray(best.start, best.end)
      : Buffer.concat([buf.subarray(best.start, Math.max(trimTrailingZeros(buf, best.start, best.end), best.start + 4)), EOI]);

    const out = uniqueOutputPath(targetDir, `${stem}_recuperado.jpg`);
    created.push(out);
    fs.writeFileSync(out, data);

    const check = await this._decodeCheck(out).catch(() => null);
    if (check && !check.decoded) {
      safeUnlink(out);
      this._log('Pré-visualização extraída não decodifica', { message: check.message });
      return null;
    }
    const warnings = ['Foi recuperada apenas a pré-visualização JPEG; os dados originais do sensor (RAW) não puderam ser reconstruídos.'];
    if (!best.complete) warnings.push('A pré-visualização estava cortada: parte da imagem pode estar faltando.');
    return { out, warnings, resolution: `${best.width}x${best.height}` };
  }

  _cancelledOrThrow(err) {
    if (this._cancelled) throw err;
  }

  _throwIfCancelled() {
    if (this._cancelled) throw new Error('Operação cancelada pelo usuário.');
  }

  /** Identifica o RAW usando o motor RAW (fabricante, modelo, resolução, se decodifica). */
  async _identifyRaw(filePath) {
    if (!this._engineAvailable()) return null;
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

  /** Exporta os dados de imagem do RAW para TIFF usando o motor RAW. */
  async _exportTiff(sourcePath, outputPath, { tolerant = false } = {}) {
    const exe = dependencyManager.resolveComponent('rawEngine');
    const args = ['export', sourcePath, outputPath];
    if (tolerant) args.push('--tolerant');

    this._log('Executando exportação TIFF', { args, tolerant });
    const data = await this._runEngineJson(exe, args);

    if (!data.success) {
      throw new Error(data.error || 'O motor de decodificação não gerou dados de imagem válidos.');
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
      throw new Error('O arquivo TIFF de saída não foi gerado corretamente.');
    }
  }

  /** Reparo estrutural do RAW com um arquivo de referência íntegro, via motor RAW. */
  async _executeReferenceRepair(referencePath, corruptPath, outputPath) {
    const exe = dependencyManager.resolveComponent('rawEngine');
    const args = ['repair', corruptPath, referencePath, outputPath];

    this._log('Executando reparo estrutural RAW', { args });
    this._emitStage('reference', 60, 'Reconstruindo dados de sensor e metadados...');
    const data = await this._runEngineJson(exe, args);

    if (!data.success) {
      throw new Error(data.error || 'O motor de reparo não gerou o arquivo reconstruído.');
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
      throw new Error('O motor de reparo não gerou o arquivo reconstruído.');
    }
  }

  /**
   * Executa o motor RAW e faz o parsing da última linha JSON do stdout.
   * stderr (progresso do motor) só serve para a mensagem de erro.
   */
  _runEngineJson(exePath, args) {
    return new Promise((resolve, reject) => {
      if (this._cancelled) return reject(new Error('Operação cancelada.'));

      const child = processRunner.spawn(exePath, args);
      this._currentProcess = child;

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout = (stdout + d.toString('utf8')).slice(-1048576); });
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4096); });

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
          reject(new Error(`Resposta inválida do motor RAW: ${stderr.slice(-300) || stdout.slice(-300)}`));
        }
      });
    });
  }

  cancel() {
    this._cancelled = true;
    const killed = processRunner.cancel(this._currentProcess);
    this._currentProcess = null;
    this.emit('cancelled');
    this._log('Operação de recuperação RAW cancelada pelo usuário.');
    return killed;
  }

  _emitStage(stage, percent, message) {
    this.emit('stage', { stage, percent, message });
    this.emit('progress', { stage, percent, message });
  }
}

RawRecoveryService.SUPPORTED_RAW_EXTENSIONS = SUPPORTED_RAW_EXTENSIONS;

module.exports = RawRecoveryService;
