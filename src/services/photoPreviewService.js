'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const logger = require('./logService');
const probeCache = require('../core/ffmpeg/ProbeCache');
const ffmpegLimiter = require('../core/media/FfmpegLimiter');
const { findSiblingJpg } = require('../core/media/MediaTypes');

// Miniatura de RAW/TIFF: lado maior de 480 px (grade ~300 px + HiDPI)
const THUMB_MAX_DIMENSION = 480;
const STDERR_TAIL_BYTES = 4096;

const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.arw', '.nef', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw'
]);

const STANDARD_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif', '.bmp', '.gif', '.svg'
]);

class PhotoPreviewService {
  constructor({ paths }) {
    this.paths = paths;
    this.cacheDir = path.join(this.paths.dataDir || process.cwd(), 'cache', 'previews');
    this._ensureCacheDir();
    const toolsDir = this.paths.tools || this.paths.dataDir;
    if (toolsDir) {
      dependencyManager.init(path.resolve(toolsDir));
    }
  }

  _ensureCacheDir() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      logger.error('[PhotoPreviewService] Falha ao criar diretório de cache:', e.message);
    }
  }

  isRaw(filePath) {
    if (!filePath) return false;
    const ext = path.extname(filePath).toLowerCase();
    return RAW_EXTENSIONS.has(ext);
  }

  isSupportedImage(filePath) {
    if (!filePath) return false;
    const ext = path.extname(filePath).toLowerCase();
    return RAW_EXTENSIONS.has(ext) || STANDARD_IMAGE_EXTENSIONS.has(ext);
  }

  /**
   * Obtém metadados técnicos de imagem (EXIF, dimensões, câmera, abertura, ISO, etc.).
   */
  async getMetadata(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Arquivo não encontrado no disco.');
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isRawFile = this.isRaw(filePath);

    const metadata = {
      file: {
        name: path.basename(filePath),
        path: filePath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        format: ext.replace('.', '').toUpperCase(),
        isRaw: isRawFile,
      },
      camera: {},
      capture: {},
      image: {},
      location: null,
      raw: {}
    };

    // 1. Se for RAW, tenta usar o RawRecoveryEngine para metadados de câmera/sensor
    if (isRawFile && dependencyManager.isAvailable('rawEngine')) {
      try {
        const rawEngineExe = dependencyManager.resolveComponent('rawEngine');
        const rawInfo = await this._runRawEngineIdentify(rawEngineExe, filePath);
        if (rawInfo) {
          if (rawInfo.camera && rawInfo.camera !== 'Desconhecido') {
            metadata.camera.model = rawInfo.camera;
          }
          if (rawInfo.manufacturer && rawInfo.manufacturer !== 'Desconhecido') {
            metadata.camera.make = rawInfo.manufacturer;
          }
          if (rawInfo.isoSpeed) {
            metadata.capture.iso = Math.round(rawInfo.isoSpeed);
          }
          if (rawInfo.resolution) {
            const [w, h] = rawInfo.resolution.split('x').map(n => parseInt(n, 10));
            if (w && h) {
              metadata.image.width = w;
              metadata.image.height = h;
            }
          }
        }
      } catch (err) {
        logger.warn('[PhotoPreviewService] identify via rawEngine falhou:', err.message);
      }
    }

    // 2. Extração via FFprobe para detalhes adicionais (espaço de cor, tags EXIF)
    try {
      const probeData = await this._probeImage(filePath);
      const stream = probeData.streams?.find(s => s.codec_type === 'video');
      const formatTags = probeData.format?.tags || {};
      const streamTags = stream?.tags || {};
      const allTags = { ...formatTags, ...streamTags };

      if (stream) {
        if (!metadata.image.width && stream.width) metadata.image.width = stream.width;
        if (!metadata.image.height && stream.height) metadata.image.height = stream.height;
        if (stream.pix_fmt) metadata.image.pixelFormat = stream.pix_fmt;
        if (stream.color_space) metadata.image.colorSpace = stream.color_space;
        if (stream.bits_per_raw_sample) metadata.image.bitDepth = parseInt(stream.bits_per_raw_sample, 10);
      }

      // EXIF / Tags da câmera
      const getTag = (...keys) => {
        for (const k of keys) {
          if (allTags[k]) return allTags[k];
          const lower = k.toLowerCase();
          for (const actualKey of Object.keys(allTags)) {
            if (actualKey.toLowerCase() === lower) return allTags[actualKey];
          }
        }
        return null;
      };

      const make = getTag('make', 'Make');
      const model = getTag('model', 'Model');
      const lens = getTag('lens_model', 'LensModel', 'lens', 'Lens');
      const focalLength = getTag('focal_length', 'FocalLength');
      const aperture = getTag('f_number', 'FNumber', 'aperture', 'ApertureValue');
      const exposureTime = getTag('exposure_time', 'ExposureTime', 'shutter_speed', 'ShutterSpeedValue');
      const iso = getTag('iso_speed_ratings', 'ISO', 'ISOSpeedRatings');
      const dateTime = getTag('date_time_original', 'DateTimeOriginal', 'creation_time', 'DateTime');
      const software = getTag('software', 'Software');

      if (make && !metadata.camera.make) metadata.camera.make = String(make).trim();
      if (model && !metadata.camera.model) metadata.camera.model = String(model).trim();
      if (lens) metadata.camera.lens = String(lens).trim();
      if (focalLength) metadata.capture.focalLength = String(focalLength).trim();
      if (aperture) metadata.capture.aperture = this._formatAperture(aperture);
      if (exposureTime) metadata.capture.shutterSpeed = this._formatShutterSpeed(exposureTime);
      if (iso && !metadata.capture.iso) metadata.capture.iso = parseInt(iso, 10) || iso;
      if (dateTime) metadata.capture.dateTime = String(dateTime).trim();
      if (software) metadata.file.software = String(software).trim();

      // GPS
      const lat = getTag('gps_latitude', 'GPSLatitude');
      const lon = getTag('gps_longitude', 'GPSLongitude');
      if (lat && lon) {
        metadata.location = { latitude: lat, longitude: lon };
      }
    } catch (e) {
      logger.warn('[PhotoPreviewService] ffprobe tags extração incompleta:', e.message);
    }

    return metadata;
  }

  _formatAperture(val) {
    if (!val) return null;
    const num = parseFloat(val);
    if (!isNaN(num)) return `f/${num.toFixed(1).replace('.0', '')}`;
    return String(val);
  }

  _formatShutterSpeed(val) {
    if (!val) return null;
    const num = parseFloat(val);
    if (!isNaN(num)) {
      if (num < 1 && num > 0) {
        const recip = Math.round(1 / num);
        return `1/${recip}s`;
      }
      return `${num}s`;
    }
    return String(val);
  }

  /**
   * Retorna um caminho de imagem renderizável pelo Chromium.
   * Se for JPG/PNG/WEBP nativo, retorna o próprio filePath.
   * Se for RAW, decodifica/converte sob demanda para o cache e retorna o arquivo de cache.
   */
  async getRenderablePath(filePath, options = {}) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('Arquivo não encontrado: ' + filePath);
    }

    const isRawFile = this.isRaw(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Formatos nativamente decodificáveis pelo Chromium
    if (!isRawFile && ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) {
      return {
        renderablePath: filePath,
        isCached: false,
        isRaw: false
      };
    }

    // Para TIFF ou RAW, precisamos gerar ou recuperar do cache
    const stat = fs.statSync(filePath);
    const cacheKey = `${stat.size}_${stat.mtimeMs}_${path.basename(filePath, ext)}`;
    const highResCacheFile = path.join(this.cacheDir, `${cacheKey}_preview.jpg`);
    const thumbCacheFile = path.join(this.cacheDir, `${cacheKey}_thumb.jpg`);

    // Miniatura (grade): devolve a do cache ou a GERA (480 px) e grava em <chave>_thumb.jpg.
    if (options.thumbnailOnly) {
      if (fs.existsSync(thumbCacheFile)) {
        return {
          renderablePath: thumbCacheFile,
          isCached: true,
          isRaw: isRawFile,
          isThumbnail: true
        };
      }
      // Pedidos simultâneos da mesma miniatura compartilham uma única geração
      this._thumbInflight = this._thumbInflight || new Map();
      let pending = this._thumbInflight.get(thumbCacheFile);
      if (!pending) {
        pending = this._generateThumbnail(filePath, isRawFile, highResCacheFile, thumbCacheFile)
          .finally(() => this._thumbInflight.delete(thumbCacheFile));
        this._thumbInflight.set(thumbCacheFile, pending);
      }
      const thumb = await pending;
      if (thumb) {
        return {
          renderablePath: thumbCacheFile,
          isCached: true,
          isRaw: isRawFile,
          isThumbnail: true,
          hasPeerJpg: thumb.usedPeerJpg || undefined
        };
      }
      // Sem como gerar a miniatura: segue o fluxo normal (JPG par / preview em alta)
    }

    if (fs.existsSync(highResCacheFile)) {
      return {
        renderablePath: highResCacheFile,
        isCached: true,
        isRaw: isRawFile
      };
    }

    // Se existir JPG par na mesma pasta com mesmo nome base, podemos usar como thumbnail/preview rápido
    const peerJpg = findSiblingJpg(filePath);
    if (peerJpg) {
      return {
        renderablePath: peerJpg,
        isCached: false,
        isRaw: isRawFile,
        hasPeerJpg: true
      };
    }

    // Decodificação via RawRecoveryEngine (se for RAW) ou FFmpeg (se for TIFF)
    if (isRawFile && dependencyManager.isAvailable('rawEngine')) {
      const rawEngineExe = dependencyManager.resolveComponent('rawEngine');
      const tempTiff = path.join(this.cacheDir, `${cacheKey}_temp.tiff`);

      try {
        await this._runRawEngineExport(rawEngineExe, filePath, tempTiff);
        if (fs.existsSync(tempTiff)) {
          // Converte o TIFF exportado para JPG de visualização em alta qualidade via ffmpeg
          const ffmpeg = ffmpegTool.resolve();
          await this._convertWithFfmpeg(ffmpeg, tempTiff, highResCacheFile, 2560);
          try { fs.unlinkSync(tempTiff); } catch (_) {}

          if (fs.existsSync(highResCacheFile)) {
            return {
              renderablePath: highResCacheFile,
              isCached: true,
              isRaw: true
            };
          }
        }
      } catch (err) {
        logger.error('[PhotoPreviewService] Falha na decodificação RAW com RawRecoveryEngine:', err.message);
        if (fs.existsSync(tempTiff)) {
          try { fs.unlinkSync(tempTiff); } catch (_) {}
        }
      }
    }

    // Fallback: Tenta decodificar via FFmpeg (útil para TIFFs ou RAWs que FFmpeg consiga abrir)
    try {
      const ffmpeg = ffmpegTool.resolve();
      await this._convertWithFfmpeg(ffmpeg, filePath, highResCacheFile, 2560);
      if (fs.existsSync(highResCacheFile)) {
        return {
          renderablePath: highResCacheFile,
          isCached: true,
          isRaw: isRawFile
        };
      }
    } catch (ffmpegErr) {
      logger.warn('[PhotoPreviewService] Falha no fallback FFmpeg:', ffmpegErr.message);
    }

    throw new Error('Não foi possível gerar visualização para este formato de imagem.');
  }

  /**
   * Gera a miniatura de 480 px em `thumbFile`. Fonte, em ordem: preview em alta já em cache, JPG par da
   * mesma pasta, ou decodificação do RAW (motor RAW -> TIFF temporário) / do próprio arquivo (TIFF etc.).
   * @returns {Promise<{usedPeerJpg: boolean}|null>} null se não foi possível gerar.
   */
  async _generateThumbnail(filePath, isRawFile, highResCacheFile, thumbFile) {
    let ffmpeg;
    try {
      ffmpeg = ffmpegTool.resolve();
    } catch (_) {
      return null;
    }

    const attempt = async (source, usedPeerJpg) => {
      // Escrita atômica: gera em .tmp.jpg e renomeia, para nunca deixar miniatura truncada no cache
      const tmpFile = `${thumbFile}.tmp.jpg`;
      try {
        await this._convertWithFfmpeg(ffmpeg, source, tmpFile, THUMB_MAX_DIMENSION, 4);
        fs.renameSync(tmpFile, thumbFile);
        return { usedPeerJpg };
      } catch (err) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        logger.warn('[PhotoPreviewService] Falha ao gerar miniatura:', err.message);
        return null;
      }
    };

    if (fs.existsSync(highResCacheFile)) {
      const r = await attempt(highResCacheFile, false);
      if (r) return r;
    }

    const peerJpg = findSiblingJpg(filePath);
    if (peerJpg) {
      const r = await attempt(peerJpg, true);
      if (r) return r;
    }

    if (isRawFile && dependencyManager.isAvailable('rawEngine')) {
      const rawEngineExe = dependencyManager.resolveComponent('rawEngine');
      const tempTiff = `${thumbFile}.tmp.tiff`;
      try {
        await this._runRawEngineExport(rawEngineExe, filePath, tempTiff);
        const r = await attempt(tempTiff, false);
        if (r) return r;
      } catch (err) {
        logger.warn('[PhotoPreviewService] Miniatura RAW via motor falhou:', err.message);
      } finally {
        try { fs.unlinkSync(tempTiff); } catch (_) {}
      }
    }

    return attempt(filePath, false);
  }

  _runRawEngineIdentify(exePath, filePath) {
    return new Promise((resolve) => {
      const child = spawn(exePath, ['identify', filePath], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.resume(); // o motor escreve progresso no stderr: sem drenar, o pipe pode encher e travar
      child.on('close', code => {
        if (code !== 0) return resolve(null);
        try {
          const line = stdout.trim().split(/\r?\n/).pop();
          resolve(JSON.parse(line));
        } catch (_) {
          resolve(null);
        }
      });
      child.on('error', () => resolve(null));
    });
  }

  _runRawEngineExport(exePath, filePath, outputPath) {
    return new Promise((resolve, reject) => {
      const child = spawn(exePath, ['export', filePath, outputPath, '--tolerant'], { windowsHide: true });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', d => { stderr = (stderr + d.toString('utf8')).slice(-STDERR_TAIL_BYTES); });
      child.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`Falha ao exportar RAW (código ${code}): ${stderr.slice(-300)}`));
        }
      });
      child.on('error', reject);
    });
  }

  /**
   * Converte/reduz uma imagem para JPG via ffmpeg (pedido do usuário => prioridade ALTA no limitador).
   * stderr é drenado (só o final é guardado); sem isso o pipe cheio podia travar o ffmpeg.
   */
  _convertWithFfmpeg(ffmpegPath, inputPath, outputPath, maxDimension = 2560, quality = 2) {
    return ffmpegLimiter.run(() => new Promise((resolve, reject) => {
      const vf = `scale=if(gte(iw\\,ih)\\,min(${maxDimension}\\,iw)\\,-2):if(lt(iw\\,ih)\\,min(${maxDimension}\\,ih)\\,-2)`;
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-vf', vf,
        '-vframes', '1',
        '-q:v', String(quality),
        outputPath
      ];

      const child = spawn(ffmpegPath, args, { windowsHide: true });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', d => { stderr = (stderr + d.toString('utf8')).slice(-STDERR_TAIL_BYTES); });
      child.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`O motor de mídia finalizou com código ${code}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`));
        }
      });
      child.on('error', reject);
    }), ffmpegLimiter.PRIORITY.HIGH);
  }

  _probeImage(filePath) {
    return probeCache.getOrLoad(filePath, () => this._probeImageRaw(filePath), 'photo-probe');
  }

  _probeImageRaw(filePath) {
    const ffprobe = ffprobeTool.resolve();
    return new Promise((resolve, reject) => {
      const child = spawn(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ], { windowsHide: true });

      let stdout = '';
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.resume();
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`Erro ao analisar a imagem (código ${code})`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
      child.on('error', reject);
    });
  }
}

module.exports = PhotoPreviewService;
