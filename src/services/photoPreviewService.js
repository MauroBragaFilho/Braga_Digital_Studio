'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { ffmpegTool } = require('../infrastructure/external-tools/adapters/FfmpegTool');
const { ffprobeTool } = require('../infrastructure/external-tools/adapters/FfprobeTool');
const { dependencyManager } = require('../infrastructure/external-tools/DependencyManager');
const logger = require('./logService');

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

    if (options.thumbnailOnly && fs.existsSync(thumbCacheFile)) {
      return {
        renderablePath: thumbCacheFile,
        isCached: true,
        isRaw: isRawFile,
        isThumbnail: true
      };
    }

    if (fs.existsSync(highResCacheFile)) {
      return {
        renderablePath: highResCacheFile,
        isCached: true,
        isRaw: isRawFile
      };
    }

    // Se existir JPG par na mesma pasta com mesmo nome base, podemos usar como thumbnail/preview rápido
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name;
    for (const candidateExt of ['.jpg', '.JPG', '.jpeg', '.JPEG']) {
      const peerJpg = path.join(dir, base + candidateExt);
      if (fs.existsSync(peerJpg)) {
        return {
          renderablePath: peerJpg,
          isCached: false,
          isRaw: isRawFile,
          hasPeerJpg: true
        };
      }
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

  _runRawEngineIdentify(exePath, filePath) {
    return new Promise((resolve) => {
      const child = spawn(exePath, ['identify', filePath], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
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
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`Falha ao exportar RAW (código ${code}): ${stderr}`));
        }
      });
      child.on('error', reject);
    });
  }

  _convertWithFfmpeg(ffmpegPath, inputPath, outputPath, maxDimension = 2560) {
    return new Promise((resolve, reject) => {
      const vf = `scale=if(gte(iw\\,ih)\\,min(${maxDimension}\\,iw)\\,-2):if(lt(iw\\,ih)\\,min(${maxDimension}\\,ih)\\,-2)`;
      const args = [
        '-y',
        '-i', inputPath,
        '-vf', vf,
        '-vframes', '1',
        '-q:v', '2',
        outputPath
      ];

      const child = spawn(ffmpegPath, args, { windowsHide: true });
      child.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg finalizou com código ${code}`));
        }
      });
      child.on('error', reject);
    });
  }

  _probeImage(filePath) {
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
      child.on('close', code => {
        if (code !== 0) return reject(new Error(`FFprobe error code ${code}`));
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
