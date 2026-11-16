'use strict';

/**
 * llmMemory.js — quanto da placa de vídeo o modelo local pode usar sem passar do que está LIVRE.
 *
 * Medido neste projeto (GTX 1650 de 4 GB, Qwen3-VL 2B com imagens, contexto 8192, llama.cpp b12322 em Vulkan):
 *  - placa livre: modelo inteiro na placa, ~76 tokens/s e ~2,8 GB usados;
 *  - com OUTRO programa usando ~2 GB: com tudo na placa (-ngl 99), ou com o `--fit` do servidor sozinho, o modelo continua
 *    "subindo", mas a memória estoura e a geração cai para 4 a 5 tokens/s (pior que a CPU, 21). O `--fit` não percebe porque a
 *    "memória livre" que o servidor enxerga (Vulkan) não desconta o que os outros programas usam (3561 MiB com a placa vazia e
 *    com ela pela metade);
 *  - com a margem do `--fit` = (livre segundo o servidor − livre de verdade) + folga, e o projetor de imagem na CPU: parte das
 *    camadas na placa, 40 tokens/s e ~570 MiB de folga.
 * Então: lê a memória livre de verdade (nvidia-smi nas placas NVIDIA; nas demais, o que o servidor informa), calcula quanto o
 * modelo pede, diz na lista o que cabe e sobe o servidor com a margem certa.
 */

const MIB = 1024 * 1024;
const MIN_GPU_PERCENT = 15;     // menos que isto das camadas na placa não compensa: roda tudo no processador
const MIN_SAFETY_MB = 512;      // folga que fica para os outros programas (e para o próprio Windows)
const DEFAULT_CTX = 8192;

/** Placa que divide a memória com o computador (não vale como "memória de vídeo"): Intel Iris/UHD, AMD com gráficos integrados... */
const INTEGRATED = /\b(iris|uhd|hd graphics|radeon\(tm\) graphics|radeon graphics|radeon vega|radeon [678]\d0m|apple m\d|adreno|mali)\b/i;
const isIntegratedGpu = (name) => INTEGRATED.test(String(name || ''));

/** `llama-server --list-devices`: "  Vulkan1: NVIDIA GeForce GTX 1650 (4152 MiB, 3561 MiB free)". */
function parseListDevices(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+\d*):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/.exec(line);
    if (m) out.push({ id: m[1], name: m[2], totalMB: Number(m[3]), freeMB: Number(m[4]) });
  }
  return out;
}

/** `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`. */
function parseNvidiaSmi(csv) {
  const out = [];
  for (const raw of String(csv || '').split(/\r?\n/)) {
    const parts = raw.split(',').map((s) => s.trim());
    if (parts.length < 3) continue;
    const totalMB = Number(parts[parts.length - 2]);
    const freeMB = Number(parts[parts.length - 1]);
    const name = parts.slice(0, -2).join(', ');
    if (name && Number.isFinite(totalMB) && Number.isFinite(freeMB) && totalMB > 0) out.push({ name, totalMB, freeMB });
  }
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\(r\)|\(tm\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A linha do nvidia-smi e a do servidor são a mesma placa? (mesmo nome, ou NVIDIA com a memória quase igual) */
function sameGpu(smi, dev) {
  const a = norm(smi.name);
  const b = norm(dev.name);
  if (a && b && (a === b || a.includes(b) || b.includes(a))) return true;
  return /nvidia/.test(b) && Math.abs(smi.totalMB - dev.totalMB) / Math.max(smi.totalMB, dev.totalMB) < 0.05;
}

/** Folga que fica para os outros programas: 512 MiB, ou 8% da placa quando ela é grande. */
const safetyFor = (totalMB) => Math.max(MIN_SAFETY_MB, Math.round((Number(totalMB) || 0) * 0.08));

/**
 * A placa de vídeo que o modelo vai usar: a DEDICADA de maior memória (a integrada divide a memória do computador e, medido,
 * gera mais devagar que a CPU). `vulkan` = o que o servidor enxerga; `nvidia` = o nvidia-smi.
 *   freeMB        memória livre de verdade (nvidia-smi quando existe; senão o que o servidor informa)
 *   serverFreeMB  o que o `--fit` do servidor acha que está livre (null se o servidor ainda não foi consultado)
 * @returns {{id:string|null, name:string, totalMB:number, freeMB:number, serverFreeMB:number|null, source:string}|null}
 */
function pickGpu({ vulkan = [], nvidia = [] } = {}) {
  const dedicated = vulkan.filter((d) => !isIntegratedGpu(d.name)).sort((a, b) => b.totalMB - a.totalMB);
  const dev = dedicated[0] || null;
  if (dev) {
    const smi = nvidia.find((g) => sameGpu(g, dev)) || null;
    return {
      id: dev.id, name: dev.name, totalMB: smi ? smi.totalMB : dev.totalMB, freeMB: smi ? smi.freeMB : dev.freeMB,
      serverFreeMB: dev.freeMB, source: smi ? 'nvidia-smi' : 'servidor'
    };
  }
  if (!vulkan.length && nvidia.length) {
    // O servidor ainda não está instalado: só dá para falar da placa NVIDIA
    const g = nvidia.slice().sort((a, b) => b.totalMB - a.totalMB)[0];
    return { id: null, name: g.name, totalMB: g.totalMB, freeMB: g.freeMB, serverFreeMB: null, source: 'nvidia-smi' };
  }
  return null;
}

/**
 * O que o modelo pede na placa (MiB): pesos + projetor de imagem + cache do contexto + buffers de cálculo.
 * Cache por token = 2 (K e V) × camadas × cabeças KV × tamanho da cabeça × 2 bytes (do config.json oficial de cada modelo).
 * Conferido: o Qwen3-VL 2B no contexto 8192 usa 2823 a 2889 MiB medidos; esta conta dá 2954 (um pouco a mais, de propósito).
 */
function estimateMB({ weightsBytes, projectorBytes = 0, kvBytesPerToken = 147456, ctx = DEFAULT_CTX }) {
  const weightsMB = weightsBytes / MIB;
  const projectorMB = projectorBytes / MIB;
  const kvMB = (kvBytesPerToken * ctx) / MIB;
  const overheadMB = 512 + weightsMB / 16;
  return { weightsMB, projectorMB, kvMB, overheadMB, totalMB: weightsMB + projectorMB + kvMB + overheadMB };
}

/**
 * Como o modelo se sai na placa AGORA:
 *   fits     todas as camadas na placa, com folga (o projetor de imagem também, se couber; senão ele fica no processador,
 *            o que só atrasa a leitura das imagens, não a conversa)
 *   tight    caberia na placa vazia, mas outros programas usam parte dela agora (parte vai para o processador)
 *   partial  maior que a placa: pelo menos metade das camadas nela, o resto no processador (mais lento)
 *   slow     pouco cabe na placa: quase tudo no processador (lento)
 *   cpu      sem placa dedicada
 * gpuPercent = parte das camadas que ficam na placa; projectorOnGpu = o projetor de imagem também vai para a placa.
 */
function fitFor(est, gpu, safetyMB = MIN_SAFETY_MB) {
  const needMB = Math.round(est.totalMB);
  if (!gpu) return { state: 'cpu', gpuPercent: 0, projectorOnGpu: false, needMB };
  const scalable = Math.max(1, est.weightsMB + est.kvMB);
  const percentOf = (usable) => Math.round(Math.max(0, Math.min(1, (usable - est.overheadMB) / scalable)) * 100);
  const usableNow = gpu.freeMB - safetyMB;
  const usableTotal = gpu.totalMB - safetyMB;
  if (est.totalMB <= usableNow) return { state: 'fits', gpuPercent: 100, projectorOnGpu: true, needMB };
  const gpuPercent = percentOf(usableNow);
  if (gpuPercent >= 100) return { state: 'fits', gpuPercent: 100, projectorOnGpu: false, needMB };
  let state;
  if (est.totalMB <= usableTotal) state = 'tight';
  else state = percentOf(usableTotal) >= 50 ? 'partial' : 'slow';
  return { state, gpuPercent, projectorOnGpu: false, needMB };
}

/**
 * O modelo recomendado: entre os que enxergam imagens, o MAIOR que cabe inteiro na placa agora; se nenhum cabe, o menor.
 * @param {Array<{id:string, vision:boolean, weightsMB:number, fit:{state:string}|null}>} entries
 */
function recommendId(entries) {
  if (!entries.length) return '';
  const vision = entries.filter((e) => e.vision);
  const pool = vision.length ? vision : entries;
  const fits = pool.filter((e) => e.fit && e.fit.state === 'fits').sort((a, b) => b.weightsMB - a.weightsMB);
  if (fits.length) return fits[0].id;
  return pool.slice().sort((a, b) => a.weightsMB - b.weightsMB)[0].id;
}

/**
 * Argumentos de memória do servidor para ESTE modelo e a memória livre de agora.
 *  - cabe inteiro: tudo na placa (projetor de imagem incluído, se couber);
 *  - não cabe inteiro: camadas na placa só até onde há memória livre de verdade, projetor de imagem na CPU;
 *  - quase nada cabe: tudo no processador (sem brigar pela placa).
 * `--fit-target` é a margem que o servidor deixa livre; somamos o que ele ENXERGA a mais do que há de verdade (outros programas).
 * @returns {{mode:'gpu'|'partial'|'cpu', args:string[], fitTargetMB:number, gpuPercent:number}}
 */
function planLaunch({ gpu, est, safetyMB = MIN_SAFETY_MB }) {
  const fit = fitFor(est, gpu, safetyMB);
  if (fit.state !== 'fits' && fit.gpuPercent < MIN_GPU_PERCENT) {
    return { mode: 'cpu', args: ['--device', 'none', '-ngl', '0'], fitTargetMB: 0, gpuPercent: 0 };
  }
  const hidden = gpu.serverFreeMB != null ? Math.max(0, gpu.serverFreeMB - gpu.freeMB) : 0;
  const fitTargetMB = Math.round(hidden + safetyMB + (fit.projectorOnGpu ? est.projectorMB : 0));
  const args = ['--fit', 'on', '--fit-target', String(fitTargetMB)];
  if (!fit.projectorOnGpu && est.projectorMB > 0) args.push('--no-mmproj-offload');
  return { mode: fit.state === 'fits' ? 'gpu' : 'partial', args, fitTargetMB, gpuPercent: fit.gpuPercent };
}

module.exports = {
  MIB, MIN_GPU_PERCENT, MIN_SAFETY_MB, DEFAULT_CTX,
  isIntegratedGpu, parseListDevices, parseNvidiaSmi, sameGpu, safetyFor, pickGpu, estimateMB, fitFor, recommendId, planLaunch
};
