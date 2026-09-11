'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const logger = require('../services/logService');

/**
 * Encoders de software (fallback garantido quando a GPU não está disponível).
 */
const SOFTWARE_ENCODERS = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1'
};

/**
 * Mapa de encoders de hardware por fabricante e codec.
 */
const VENDOR_ENCODERS = {
  nvidia: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: 'av1_nvenc' },
  intel:  { h264: 'h264_qsv',   hevc: 'hevc_qsv',   av1: 'av1_qsv'   },
  amd:    { h264: 'h264_amf',   hevc: 'hevc_amf',   av1: 'av1_amf'   }
};

/**
 * Normaliza a escolha de codec do usuário para uma chave interna.
 * @param {string} choice "H.264", "H.265", "HEVC", "AV1", etc.
 * @returns {string|null} 'h264' | 'hevc' | 'av1' | null
 */
function normalizeCodecKey(choice) {
  const c = String(choice || '').toLowerCase();
  if (c === 'h264' || c === 'avc' || c === 'h.264' || c === 'x264') return 'h264';
  if (c === 'h265' || c === 'h.265' || c === 'hevc' || c === 'hevc10' || c === 'hevc 10-bit') return 'hevc';
  if (c === 'av1') return 'av1';
  return null;
}

/**
 * HardwareDetectionService
 * ------------------------
 * Detecta a capacidade de aceleração de hardware do computador e escolhe o
 * melhor encoder para o FFmpeg (NVENC / QSV / AMF), com fallback para CPU.
 *
 * Melhorias vs. versão anterior:
 *  - Enumera os encoders reais do FFmpeg (`-encoders`) para não testar o que
 *    nem existe no build → detecção muito mais rápida.
 *  - Teste de encoder menor (0.2s) e com timeout de segurança.
 *  - Leitura do nome/driver/VRAM da GPU via WMI (Win32_VideoController).
 *  - Respeita as preferências do usuário: useHardwareAcceleration e
 *    preferredGpuVendor (auto | nvidia | amd | intel).
 */
class HardwareDetectionService {
  constructor() {
    this.cachedBestEncoder = {
      h264: null,
      hevc: null,
      av1: null
    };

    /** Preferências carregadas do config/settings.json (via configure()). */
    this.settings = null;

    /** Cache da listagem de encoders (chave: caminho do ffmpeg). */
    this._encodersCache = null;

    /** Cache da GPU (10 minutos). */
    this._gpuCache = null;
  }

  /**
   * Aplica as preferências de aceleração de hardware vinda das Configurações.
   * @param {Object} settings
   */
  configure(settings) {
    this.settings = settings || {};
  }

  /**
   * Invalida os caches de encoder/GPU (ex: após mudar as configurações).
   */
  invalidateCache() {
    this.cachedBestEncoder = { h264: null, hevc: null, av1: null };
    this._gpuCache = null;
  }

  // ------------------------------------------------------------------
  // UTILITÁRIOS
  // ------------------------------------------------------------------

  /**
   * Lista os encoders realmente compilados no FFmpeg (uma vez por caminho).
   * @param {string} ffmpegPath
   * @returns {Promise<Set<string>>}
   */
  async listEncoders(ffmpegPath) {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return new Set();
    if (this._encodersCache && this._encodersCache.path === ffmpegPath) return this._encodersCache.set;

    const set = new Set();
    try {
      await new Promise((resolve) => {
        const child = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 6000);

        child.on('close', () => {
          clearTimeout(timer);
          for (const line of out.split('\n')) {
            // Formato: "V....D h264_nvenc ..." (6 chars de flags: V/A/S/F/X/B/D/.)
            const match = line.match(/^\s*[VASFXBD.]{6}\s+([a-z0-9_]+)/i);
            if (match) set.add(match[1]);
          }
          resolve();
        });
        child.on('error', () => { clearTimeout(timer); resolve(); });
      });
    } catch (_) {
      return new Set();
    }

    this._encodersCache = { path: ffmpegPath, set };
    return set;
  }


  /**
   * Testa se um encoder consegue codificar de verdade (mini encoding).
   * Pula o teste quando o encoder nem existe no build (via listEncoders).
   *
   * NOTA: usa 128x128 + bitrate fixo porque:
   *  - HEVC NVENC exige resolução mínima > 64x64 (senão dá
   *    "Frame dimensions are less than the minimum supported value");
   *  - AV1 NVENC e alguns encoders exigem -b:v explícito para inicializar.
   * @returns {Promise<boolean>}
   */
  async testEncoder(ffmpegPath, encoder) {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) return false;

    const available = await this.listEncoders(ffmpegPath);
    if (available.size > 0 && !available.has(encoder)) return false;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

      const child = spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-f', 'lavfi',
          '-i', 'nullsrc=s=128x128:d=0.2',
          '-c:v', encoder,
          '-b:v', '1M',       // bitrate mínimo — sem ele, hevc_nvenc / av1_nvenc
                               // podem travar aguardando configuração de rate-control.
          '-f', 'null',
          '-'
        ],
        { windowsHide: true }
      );

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 6000);

      child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
      child.on('error', () => { clearTimeout(timer); finish(false); });
    });
  }

  /**
   * Ordem dos fabricantes a tentar, respeitando a preferência do usuário.
   */
  _buildVendorOrder(preferredVendor) {
    const defaultOrder = ['nvidia', 'intel', 'amd'];
    const pref = String(preferredVendor || 'auto').toLowerCase();
    if (pref === 'auto' || !VENDOR_ENCODERS[pref]) return defaultOrder;
    return [pref, ...defaultOrder.filter((v) => v !== pref)];
  }


  // ------------------------------------------------------------------
  // DETECÇÃO DE ENCODER
  // ------------------------------------------------------------------

  /**
   * Escolhe o melhor encoder para o codec desejado.
   * @param {string} ffmpegPath - Caminho do ffmpeg
   * @param {string} codecChoice - 'H.264' | 'H.265'/'HEVC' | 'AV1'
   * @param {Object} [opts] - { forceSoftware?: boolean, forceHardware?: boolean }
   * @returns {Promise<string>}
   */
  async detectEncoder(ffmpegPath, codecChoice = 'H.264', opts = {}) {
    const codecKey = normalizeCodecKey(codecChoice);
    if (!codecKey) return 'libx264';

    if (this.cachedBestEncoder[codecKey]) return this.cachedBestEncoder[codecKey];

    const settings = this.settings || {};
    const hardwareEnabled = opts.forceHardware
      ? true
      : opts.forceSoftware
        ? false
        : settings.useHardwareAcceleration !== false;

    const softwareEncoder = SOFTWARE_ENCODERS[codecKey] || 'libx264';

    if (!hardwareEnabled) {
      logger.info('hardware:software-only', { codec: codecKey, encoder: softwareEncoder });
      this.cachedBestEncoder[codecKey] = softwareEncoder;
      return softwareEncoder;
    }

    const available = await this.listEncoders(ffmpegPath);

    for (const vendor of this._buildVendorOrder(settings.preferredGpuVendor)) {
      const encoder = VENDOR_ENCODERS[vendor] && VENDOR_ENCODERS[vendor][codecKey];
      if (!encoder) continue;
      if (available.size > 0 && !available.has(encoder)) continue;

      if (await this.testEncoder(ffmpegPath, encoder)) {
        logger.info('hardware:encoder-selected', { codec: codecKey, encoder, vendor });
        this.cachedBestEncoder[codecKey] = encoder;
        return encoder;
      }
    }

    logger.info('hardware:encoder-fallback', { codec: codecKey, encoder: softwareEncoder });
    this.cachedBestEncoder[codecKey] = softwareEncoder;
    return softwareEncoder;
  }


// ------------------------------------------------------------------
  // PARÂMETROS DE QUALIDADE
  // ------------------------------------------------------------------

  /**
   * Converte o preset estilo libx264 para o equivalente NVENC (p1..p7).
   */
  _mapNvencPreset(preset) {
    const map = {
      ultrafast: 'p1',
      superfast: 'p2',
      veryfast: 'p3',
      faster: 'p4',
      fast: 'p4',
      medium: 'p5',
      slow: 'p6',
      slower: 'p7',
      veryslow: 'p7',
      placebo: 'p7'
    };
    return map[String(preset || 'medium').toLowerCase()] || 'p5';
  }

  /**
   * Retorna os argumentos de qualidade para um encoder específico.
   * @param {string} encoder - 'libx264', 'hevc_qsv', 'h264_amf', ...
   * @param {string|number} crfValue - Valor de qualidade (CRF/CQ/global_quality/QP)
   * @param {string} [presetName] - Preset (usado para libx264 e NVENC)
   * @returns {string[]}
   */
  getEncoderQualityArgs(encoder, crfValue = '23', presetName = 'medium') {
    const crf = String(crfValue || '23');
    const args = [];

    if (encoder.startsWith('lib')) {
      args.push('-preset', presetName || 'medium', '-crf', crf);
    } else if (encoder.includes('nvenc')) {
      args.push('-preset', this._mapNvencPreset(presetName), '-cq', crf);
    } else if (encoder.includes('qsv')) {
      args.push('-global_quality', crf);
    } else if (encoder.includes('amf')) {
      args.push('-usage', 'transcoding', '-quality', 'quality', '-qp_i', crf, '-qp_p', crf);
    }

    return args;
  }

  /**
   * Argumentos de qualidade por nível (mantém a API pública usada por
   * montageService e silenceService).
   * @param {string} encoder
   * @param {string} [quality] 'Baixa' | 'Média' | 'Alta' | 'Muito Alta'
   * @returns {string[]}
   */
  getQualitySettings(encoder, quality = 'Alta') {
    let crfVal = '23';
    if (quality === 'Baixa') crfVal = '28';
    if (quality === 'Alta') crfVal = '18';
    if (quality === 'Muito Alta') crfVal = '14';
    return this.getEncoderQualityArgs(encoder, crfVal, 'medium');
  }
// ------------------------------------------------------------------
  // DETECÇÃO DA GPU (WMI)
  // ------------------------------------------------------------------

  /**
   * Descobre o fabricante pela PNPDeviceID (VEN_xxxx) do WMI.
   */
  _gpuVendorFromPnp(pnpDeviceId) {
    const id = String(pnpDeviceId || '');
    if (/VEN_10DE/i.test(id)) return 'nvidia';
    if (/VEN_1002|VEN_1022/i.test(id)) return 'amd';
    if (/VEN_8086/i.test(id)) return 'intel';
    return 'other';
  }

  /**
   * Extrai um "modelo" legível do nome completo da GPU vindo do WMI,
   * removendo o nome do fabricante para exibição
   * (ex: "NVIDIA GeForce GTX 1650" → "GeForce GTX 1650";
   *  "Intel(R) UHD Graphics" → "UHD Graphics";
   *  "AMD Radeon RX 7600" → "Radeon RX 7600").
   * Retorna o nome original caso não consiga limpar.
   * @param {string} name
   * @param {string} vendor
   * @returns {string}
   */
  _gpuModelFromName(name, vendor) {
    const raw = String(name || '').trim();
    if (!raw) return raw;

    // Regex do nome do fabricante (com ou sem símbolo de marca registrada,
    // parênteses ou sufixo corporativo tipo "Corporation").
    const brandPrefs = {
      nvidia: /^nvidia(?:®|™|\(r\))?\s*,?\s*/i,
      amd: /^amd(?:®|™|\(r\))?\s*,?\s*/i,
      intel: /^intel(?:®|™|\(r\))?\s*,?\s*/i
    };

    let model = raw;
    const pre = brandPrefs[vendor];
    if (pre) model = model.replace(pre, '');

    // Remove símbolos de marca registrada/TM residuais no meio do nome
    // (ex: "Iris(R) Xe" → "Iris Xe"; "Arc(TM)" → "Arc") e agrupamentos.
    model = model
      .replace(/\(r\)|\(tm\)|\(®\)|\(™\)|®|™/gi, '')
      .replace(/[()]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Se sobrou algo útil, usa-o; senão devolve o nome original.
    return model && model.length > 1 ? model : raw;
  }

  /**
   * Executa um comando PowerShell capturando a saída como texto.
   * @private
   */
  _runPowerShell(command, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true }
      );
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });

      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error('PowerShell timeout'));
      }, timeoutMs);

      child.on('error', () => { clearTimeout(timer); reject(new Error('PowerShell indisponível')); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`PowerShell exit ${code}`));
      });
    });
  }

  /**
   * Executa um executável genérico capturando stdout como texto.
   * (usado para nvidia-smi, que não é PowerShell e é instantâneo)
   * @private
   */
  _runExecutable(bin, args = [], timeoutMs = 6000) {
    return new Promise((resolve) => {
      const child = spawn(bin, args, { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });

      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        resolve('');
      }, timeoutMs);

      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    });
  }

  /**
   * Obtém dados da GPU via `nvidia-smi` (rápido e confiável com drivers
   * NVIDIA instalados; não depende de WMI/PowerShell).
   * @returns {Promise<Array<{name, driverVersion, vramMB, vendor}>>}
   * @private
   */
  async _gpuFromNvidiaSmi() {
    const raw = await this._runExecutable('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total',
      '--format=csv,noheader,nounits'
    ]);
    if (!raw) return [];

    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, driver, memoryMiB] = line.split(',').map((s) => s.trim());
        return {
          name: name || '',
          model: this._gpuModelFromName(name || '', 'nvidia'),
          driverVersion: driver || '',
          vramMB: memoryMiB && Number.isFinite(Number(memoryMiB)) ? Number(memoryMiB) : null,
          vendor: 'nvidia',
          videoMode: '',
          source: 'nvidia-smi'
        };
      });
  }

  /**
   * Obtém a lista de GPUs (Win32_VideoController) via WMI, com cache de 10min.
   * @param {Object} [opts] - { force?: boolean }
   * @returns {Promise<Array<{name, driverVersion, vramMB, vendor, videoMode}>>}
   */
  async getGraphicsInfo({ force = false } = {}) {
    if (this._gpuCache && !force && Date.now() - this._gpuCache.at < 10 * 60 * 1000) {
      return this._gpuCache.gpus;
    }

    const gpus = [];
    if (process.platform === 'win32') {
      const script = [
        'Get-CimInstance Win32_VideoController',
        '| Select-Object Name,DriverVersion,AdapterRAM,VideoModeDescription,PNPDeviceID',
        '| ConvertTo-Json -Compress'
      ].join(' ');

      let wmiOk = false;
      try {
        const raw = await this._runPowerShell(script);
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (_) { data = null; }
        }
        if (!Array.isArray(data)) data = data ? [data] : [];
        if (data.length > 0) wmiOk = true;

        for (const item of data) {
          if (!item || !item.Name) continue;
          const vram = Number(item.AdapterRAM);
          const fullName = String(item.Name).trim();
          const vendor = this._gpuVendorFromPnp(item.PNPDeviceID);
          gpus.push({
            name: fullName,
            // Remove a marca do nome para obter um "modelo" mais limpo
            // (ex: "NVIDIA GeForce GTX 1650" → "GeForce GTX 1650").
            model: this._gpuModelFromName(fullName, vendor),
            driverVersion: item.DriverVersion ? String(item.DriverVersion).trim() : '',
            vramMB: vram > 0 ? Math.round(vram / (1024 * 1024)) : null,
            vendor,
            videoMode: item.VideoModeDescription ? String(item.VideoModeDescription).trim() : '',
            source: 'wmi'
          });
        }
      } catch (err) {
        logger.warn('hardware:wmi-unavailable', { error: err.message });
      }

      // O WMI costuma dar timeout no seu ambiente. Quando ele falha ou não
      // traz nenhum nome (ou só traz GPUs sem dados de NVIDIA), complementamos
      // com o nvidia-smi — que é instantâneo e traz nome real + driver + VRAM.
      const hasNvidia = gpus.some((g) => g.vendor === 'nvidia' && g.name);
      if (!hasNvidia) {
        try {
          const smi = await this._gpuFromNvidiaSmi();
          if (!wmiOk && smi.length > 0) {
            gpus.length = 0;         // o WMI não respondeu: usa só nvidia-smi
            gpus.push(...smi);
          } else if (smi.length > 0) {
            // Mescla com o que o WMI trouxe para não duplicar a NVIDIA.
            for (const s of smi) {
              if (!gpus.some((g) => g.vendor === 'nvidia')) gpus.push(s);
            }
          }
        } catch (_) { /* mantém só o WMI */ }
      }
    }

    this._gpuCache = { at: Date.now(), gpus };
    return gpus;
  }

  // ------------------------------------------------------------------
  // API ÚNICA PARA A INTERFACE (configurações → sistema)
  // ------------------------------------------------------------------

  /**
   * Agrega informações de hardware para exibição na interface.
   * @param {string|null} ffmpegPath - Caminho do ffmpeg (opcional)
   * @returns {Promise<Object>}
   */
  async getSystemHardwareInfo(ffmpegPath = null) {
    const settings = this.settings || {};
    const useHw = settings.useHardwareAcceleration !== false;

    const [gpus, available] = await Promise.all([
      this.getGraphicsInfo(),
      ffmpegPath ? this.listEncoders(ffmpegPath) : Promise.resolve(new Set())
    ]);

    const selected = {};
    if (ffmpegPath) {
      for (const [label, key] of [['H.264', 'h264'], ['H.265', 'hevc'], ['AV1', 'av1']]) {
        if (!useHw) {
          selected[key] = SOFTWARE_ENCODERS[key] || 'libx264';
        } else {
          selected[key] = await this.detectEncoder(ffmpegPath, label);
        }
      }
    }

    // Fallback de exibição: se o WMI não respondeu (ambiente lento/sem WMI),
    // usa o fabricante inferido do encoder realmente funcionando (testado).
    let displayGpus = gpus;
    if (gpus.length === 0 && useHw) {
      const vendorByEncoder = {
        nvidia: ['nvenc'],
        intel: ['qsv'],
        amd: ['amf']
      };
      for (const [vendor, markers] of Object.entries(vendorByEncoder)) {
        const usedEncoder = Object.values(selected).find((enc) =>
          markers.some((m) => enc && enc.includes(m))
        );
        if (usedEncoder) {
          displayGpus = [{
            name: `${vendor[0].toUpperCase()}${vendor.slice(1)} (via ${usedEncoder})`,
            model: usedEncoder,
            vendor,
            vramMB: null,
            driverVersion: '',
            videoMode: '',
            inferred: true
          }];
          break;
        }
      }
    }

    return {
      gpus: displayGpus,
      availableEncoders: [...available].filter((e) => /(nvenc|qsv|amf)/.test(e)).sort(),
      selected,
      useHardwareAcceleration: useHw,
      preferredGpuVendor: settings.preferredGpuVendor || 'auto'
    };
  }
}

module.exports = new HardwareDetectionService();