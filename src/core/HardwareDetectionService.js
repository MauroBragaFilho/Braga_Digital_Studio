'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const logger = require('../services/logService');
const FailureCooldown = require('./FailureCooldown');

/** Tempo máximo da consulta WMI via PowerShell (nesta classe de máquina ela costuma estourar). */
const WMI_TIMEOUT_MS = 4000;
/** Depois de uma falha do WMI, não repete a consulta por este período (cache negativo). */
const WMI_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
/** Validade dos resultados de mini-encode persistidos em disco. */
const ENCODER_TEST_TTL_OK_MS = 30 * 24 * 60 * 60 * 1000;
const ENCODER_TEST_TTL_FAIL_MS = 24 * 60 * 60 * 1000;

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

    /** Cache negativo do WMI: sobrevive a invalidateCache() (é uma característica da máquina). */
    this._wmiCooldown = new FailureCooldown(WMI_FAILURE_COOLDOWN_MS);

    /** Resultados dos mini-encodes de teste: chave "<ffmpeg>|<tamanho>|<mtime>|<encoder>" -> { ok, at }. */
    this._testResults = new Map();
    this._testStoreLoaded = false;
    /** Diretório de cache em disco (dataDir/cache); definido por setCacheDir() ou resolvido sob demanda. */
    this._cacheDir = null;
  }

  /** Define o diretório de cache em disco (opcional; por padrão usa dataDir/cache do AppPaths). */
  setCacheDir(dir) {
    this._cacheDir = dir || null;
    this._testStoreLoaded = false;
    this._testResults.clear();
  }

  /** Arquivo JSON com os resultados persistidos dos testes de encoder, ou null se indisponível. */
  _testStorePath() {
    try {
      let dir = this._cacheDir;
      if (!dir) {
        const { appPaths } = require('../infrastructure/filesystem/AppPaths');
        dir = path.join(appPaths.dataDir, 'cache');
      }
      return path.join(dir, 'hw-encoder-tests.json');
    } catch (_) {
      return null;
    }
  }

  /** Identifica a versão do ffmpeg pelo caminho + tamanho + data de modificação do binário. */
  _ffmpegKey(ffmpegPath) {
    try {
      const st = fs.statSync(ffmpegPath);
      return `${ffmpegPath}|${st.size}|${Math.floor(st.mtimeMs)}`;
    } catch (_) {
      return ffmpegPath;
    }
  }

  _loadTestStore() {
    if (this._testStoreLoaded) return;
    this._testStoreLoaded = true;
    const file = this._testStorePath();
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(data || {})) {
        if (v && typeof v.ok === 'boolean' && Number.isFinite(v.at)) this._testResults.set(k, v);
      }
    } catch (_) { /* sem cache em disco ainda */ }
  }

  _saveTestStore() {
    const file = this._testStorePath();
    if (!file) return;
    const obj = Object.fromEntries(this._testResults);
    fs.promises.mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.writeFile(file, JSON.stringify(obj), 'utf8'))
      .catch(() => { /* cache é só otimização */ });
  }

  /** Resultado do teste em cache (memória/disco) ainda válido, ou undefined. */
  _getCachedTest(key, now = Date.now()) {
    this._loadTestStore();
    const entry = this._testResults.get(key);
    if (!entry) return undefined;
    const ttl = entry.ok ? ENCODER_TEST_TTL_OK_MS : ENCODER_TEST_TTL_FAIL_MS;
    return (now - entry.at) < ttl ? entry.ok : undefined;
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

    // [PERF] O mini-encode só é refeito se a versão do ffmpeg mudou ou o resultado expirou.
    const cacheKey = `${this._ffmpegKey(ffmpegPath)}|${encoder}`;
    const cached = this._getCachedTest(cacheKey);
    if (cached !== undefined) return cached;

    const ok = await this._runEncoderTest(ffmpegPath, encoder);
    this._testResults.set(cacheKey, { ok, at: Date.now() });
    this._saveTestStore();
    return ok;
  }

  /** Executa o mini-encode de teste (sem cache). @private */
  _runEncoderTest(ffmpegPath, encoder) {
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
  _runPowerShell(command, timeoutMs = WMI_TIMEOUT_MS) {
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
   * Lê as placas de vídeo do registro do Windows (classe "Display adapters"), sem WMI.
   * Rápido (dezenas de ms) e não trava com drivers de vídeo virtuais (ex.: spacedesk), que podem
   * fazer o Win32_VideoController estourar o tempo limite. Só entram adaptadores com ID PCI real
   * (descarta Microsoft Basic Display e adaptadores virtuais).
   * @returns {Promise<Array<{name, model, driverVersion, vramMB, vendor, videoMode, source}>>}
   * @private
   */
  async _gpusFromRegistry() {
    if (process.platform !== 'win32') return [];
    const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    // Só as subchaves (sem /s: a árvore inteira tem centenas de KB e é lenta).
    const listing = await this._runExecutable('reg', ['query', KEY], 3000);
    const subkeys = [...listing.matchAll(/\\(\d{4})\s*$/gm)].map((m) => m[1]).slice(0, 12);
    // Pede só os valores necessários (/v): a subchave inteira de alguns drivers tem >100 KB e leva segundos.
    const query = (sk, valueName) => this._runExecutable('reg', ['query', `${KEY}\\${sk}`, '/v', valueName], 3000);
    const parsed = await Promise.all(subkeys.map(async (sk) => {
      const head = (await Promise.all([query(sk, 'DriverDesc'), query(sk, 'MatchingDeviceId')])).join('\n');
      if (!/DriverDesc/.test(head) || !/PCI\\VEN_/i.test(head)) return null; // sem ID PCI: virtual/básico
      const rest = await Promise.all([
        query(sk, 'DriverVersion'),
        query(sk, 'HardwareInformation.qwMemorySize'),
        query(sk, 'HardwareInformation.MemorySize')
      ]);
      return this._parseRegistryAdapter([head, ...rest].join('\n'));
    }));
    return parsed.filter(Boolean);
  }

  /**
   * Interpreta a saída de `reg query <subchave do adaptador>`.
   * @param {string} raw
   * @returns {{name, model, driverVersion, vramMB, vendor, videoMode, source}|null}
   * @private
   */
  _parseRegistryAdapter(raw) {
    if (!raw) return null;
    const val = (name) => {
      const m = raw.match(new RegExp('^\\s+' + name.replace(/\./g, '\\.') + '\\s+REG_\\w+\\s+(.*)$', 'm'));
      return m ? m[1].trim() : null;
    };
    const name = val('DriverDesc');
    const pnp = val('MatchingDeviceId') || '';
    if (!name || !/PCI\\VEN_/i.test(pnp)) return null;

    let vramMB = null;
    const qword = val('HardwareInformation.qwMemorySize'); // REG_QWORD: 0x...
    const binary = val('HardwareInformation.MemorySize');  // REG_BINARY: 4 bytes little-endian
    if (qword && /^0x[0-9a-f]+$/i.test(qword)) {
      vramMB = Math.round(Number(BigInt(qword)) / (1024 * 1024));
    } else if (binary && /^[0-9a-f]{8}$/i.test(binary)) {
      const bigEndian = binary.match(/../g).reverse().join('');
      vramMB = Math.round(parseInt(bigEndian, 16) / (1024 * 1024));
    }
    if (!(vramMB > 0)) vramMB = null;

    const vendor = this._gpuVendorFromPnp(pnp);
    return {
      name,
      model: this._gpuModelFromName(name, vendor),
      driverVersion: val('DriverVersion') || '',
      vramMB,
      vendor,
      videoMode: '',
      source: 'registry'
    };
  }

  /**
   * Junta as fontes rápidas: o nvidia-smi traz nome, driver e VRAM reais da NVIDIA (e vem primeiro);
   * o registro completa com as demais (Intel/AMD) e só traz a NVIDIA se o nvidia-smi não respondeu.
   * @private
   */
  _mergeGpuSources(smi = [], registry = []) {
    const gpus = [...smi];
    for (const r of registry) {
      if (r.vendor === 'nvidia' && smi.length > 0) continue;
      if (gpus.some((g) => g.name === r.name)) continue;
      gpus.push(r);
    }
    return gpus;
  }

  /**
   * Obtém a lista de GPUs com cache de 10 min. Usa o nvidia-smi e o registro do Windows (rápidos, sem
   * WMI); o WMI (Win32_VideoController) só é consultado se nenhuma das duas fontes trouxer nada.
   * @param {Object} [opts] - { force?: boolean }
   * @returns {Promise<Array<{name, driverVersion, vramMB, vendor, videoMode}>>}
   */
  async getGraphicsInfo({ force = false } = {}) {
    if (this._gpuCache && !force && Date.now() - this._gpuCache.at < 10 * 60 * 1000) {
      return this._gpuCache.gpus;
    }

    if (process.platform === 'win32') {
      const [smi, registry] = await Promise.all([
        this._gpuFromNvidiaSmi().catch(() => []),
        this._gpusFromRegistry().catch(() => [])
      ]);
      const gpus = this._mergeGpuSources(smi, registry);
      if (gpus.length > 0) {
        this._gpuCache = { at: Date.now(), gpus };
        return gpus;
      }
    }
    return this._getGraphicsInfoViaWmi();
  }

  /**
   * Último recurso: Win32_VideoController via PowerShell (timeout curto e cache negativo).
   * @private
   */
  async _getGraphicsInfoViaWmi() {
    const gpus = [];
    if (process.platform === 'win32') {
      const script = [
        `Get-CimInstance Win32_VideoController -OperationTimeoutSec ${Math.ceil(WMI_TIMEOUT_MS / 1000)}`,
        '| Select-Object Name,DriverVersion,AdapterRAM,VideoModeDescription,PNPDeviceID',
        '| ConvertTo-Json -Compress'
      ].join(' ');

      // nvidia-smi (instantâneo) roda em paralelo ao WMI para não somar as esperas.
      const smiPromise = this._gpuFromNvidiaSmi().catch(() => []);

      let wmiOk = false;
      if (this._wmiCooldown.shouldSkip()) {
        // Cache negativo: o WMI falhou há pouco; não repete a consulta lenta.
        logger.debug('hardware:wmi-skipped-cooldown');
      } else {
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
          if (wmiOk) this._wmiCooldown.reset();
          else this._wmiCooldown.markFailure();
        } catch (err) {
          this._wmiCooldown.markFailure();
          logger.warn('hardware:wmi-unavailable', { error: err.message });
        }
      }

      // O WMI costuma dar timeout no seu ambiente. Quando ele falha ou não
      // traz nenhum nome (ou só traz GPUs sem dados de NVIDIA), complementamos
      // com o nvidia-smi — que é instantâneo e traz nome real + driver + VRAM.
      const smi = await smiPromise;
      const hasNvidia = gpus.some((g) => g.vendor === 'nvidia' && g.name);
      if (!hasNvidia && smi.length > 0) {
        if (!wmiOk) {
          gpus.length = 0;         // o WMI não respondeu: usa só nvidia-smi
          gpus.push(...smi);
        } else {
          // Mescla com o que o WMI trouxe para não duplicar a NVIDIA.
          for (const s of smi) {
            if (!gpus.some((g) => g.vendor === 'nvidia')) gpus.push(s);
          }
        }
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