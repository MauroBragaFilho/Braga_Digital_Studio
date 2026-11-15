'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

/**
 * Qual FFmpeg baixar para ESTE computador (Windows x64).
 *
 * A versão de desenvolvimento ("master") é a padrão, mas ela exige uma interface NVENC nova (13.1, driver NVIDIA 610 ou mais):
 * em placa NVIDIA com driver mais antigo o NVENC falha ("Driver does not support the required nvenc API version") e o app cai
 * para o processador. Só esses computadores (placa NVIDIA com driver abaixo do mínimo) baixam a versão estável; os demais
 * (Intel, AMD, NVIDIA com driver novo, sem placa dedicada) continuam com a de desenvolvimento.
 *
 * Fonte: os mesmos builds da BtbN/FFmpeg-Builds que o BDS já usa (ver ToolSources.js).
 */
const MASTER_MIN_NVIDIA_DRIVER = 610;
const MASTER = 'ffmpeg-master-latest-win64-gpl.zip';
const STABLE = ['ffmpeg-n8.1-latest-win64-gpl-8.1.zip', 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip'];

/** Placa NVIDIA com driver abaixo do exigido pela versão de desenvolvimento? (`driver` = número principal; null = não sei/sem NVIDIA) */
const oldNvidiaDriver = (driver) => Number.isFinite(driver) && driver > 0 && driver < MASTER_MIN_NVIDIA_DRIVER;

/**
 * Pacotes (Windows x64) na ordem de preferência para este computador: o 1º que a BtbN publicar vale.
 * `preferStable`: o app já viu o NVENC falhar por versão de driver aqui.
 */
const candidatesFor = (driver, preferStable = false) => (preferStable || oldNvidiaDriver(driver) ? [...STABLE, MASTER] : [MASTER, ...STABLE]);

const defaultRun = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))));
});

/** Número principal do driver NVIDIA ("597.06" → 597) lido do nvidia-smi; null se não houver placa NVIDIA/driver ou não der para ler. */
async function nvidiaDriverMajor({ env = process.env, run = defaultRun, platform = process.platform } = {}) {
  const candidates = platform === 'win32'
    ? [path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'nvidia-smi.exe'), path.join(env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')]
    : ['nvidia-smi'];
  for (const exe of candidates) {
    try {
      const out = await run(exe, ['--query-gpu=driver_version', '--format=csv,noheader'], 4000);
      const majors = out.split(/\r?\n/).map((l) => parseInt(l.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
      if (majors.length) return Math.min(...majors); // várias placas: vale a mais restritiva
    } catch (_) { /* nvidia-smi não está aqui: tenta o próximo */ }
  }
  return null;
}

module.exports = { MASTER_MIN_NVIDIA_DRIVER, MASTER, STABLE, oldNvidiaDriver, candidatesFor, nvidiaDriverMajor };
