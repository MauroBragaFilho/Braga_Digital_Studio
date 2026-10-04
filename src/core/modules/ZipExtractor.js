'use strict';

/**
 * ZipExtractor — extrai .zip grandes sem carregá-los na memória (usa o tar do sistema).
 *
 * No Windows 10+ o "tar.exe" (bsdtar) lê .zip e processa arquivos de vários GB em fluxo,
 * ao contrário de bibliotecas em JS que carregam o arquivo inteiro (o zip do cuDNN tem ~2 GB).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PathGuard } = require('../../infrastructure/filesystem/PathGuard');
const { processRunner } = require('../../infrastructure/external-tools/ProcessRunner');

function tarExecutable() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const system = path.join(root, 'System32', 'tar.exe');
    return fs.existsSync(system) ? system : 'tar.exe';
  }
  return null; // outras plataformas usam "unzip"
}

/** Executa um comando e devolve a saída (stdout) — usado para listar as entradas do zip. */
function runCapture(command, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { windowsHide: true }); } catch (err) { return reject(err); }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { processRunner.cancel(child); reject(new Error('Tempo esgotado ao listar o conteúdo do arquivo.')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 4000) err = err.slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error(`Falha ao listar o arquivo (código ${code}). ${err.trim().split('\n').pop() || ''}`.trim()));
    });
  });
}

/**
 * Proteção contra zip-slip: toda entrada precisa resolver para dentro de destDir
 * (sem "..", sem caminho absoluto, sem letra de unidade).
 * @param {string[]} entries nomes das entradas do arquivo
 * @param {string} destDir
 * @throws {Error} se alguma entrada escapar do destino
 */
function assertSafeEntries(entries, destDir) {
  for (const raw of entries) {
    const name = String(raw).replace(/\r$/, '');
    if (!name) continue;
    const normalized = name.replace(/\\/g, '/');
    if (/^([a-zA-Z]:|\/)/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Arquivo compactado inseguro: a entrada '${name}' tenta escapar da pasta de destino.`);
    }
    PathGuard.assertWithin(destDir, path.join(destDir, normalized));
  }
}

/**
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ include?: string[], signal?: AbortSignal, timeoutMs?: number }} [opts]
 *   include: padrões (ex.: "*.dll"); timeoutMs: limite total da extração (padrão 30 min)
 */
async function extractZip(zipPath, destDir, { include = [], signal = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = tarExecutable();
  const command = tar || 'unzip';

  // Validação prévia (zip-slip): lista as entradas antes de extrair qualquer coisa.
  try {
    const listing = tar
      ? await runCapture(tar, ['-tf', zipPath])
      : await runCapture('unzip', ['-Z1', zipPath]);
    assertSafeEntries(listing.split('\n'), destDir);
  } catch (err) {
    if (/inseguro/.test(err.message)) throw err;
    throw new Error(`Não foi possível validar o arquivo compactado: ${err.message}`);
  }

  const args = tar
    ? ['-xf', zipPath, '-C', destDir, ...include.flatMap((p) => ['--include', p])]
    : ['-o', zipPath, ...include, '-d', destDir];

  return runExtract(command, args, { signal, timeoutMs });
}

/** Executa o descompactador (cancelável, com limite de tempo). */
function runExtract(command, args, { signal = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      return reject(new Error(`Não foi possível iniciar o descompactador (${err.message}).`));
    }
    let settled = false;
    let stderr = '';
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', (err) => finish(reject, new Error(`Descompactador indisponível: ${err.message}`)));

    const onAbort = () => { processRunner.cancel(child).then(() => finish(reject, new Error('Extração cancelada.'))); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      processRunner.cancel(child).then(() => finish(reject, new Error('Tempo esgotado ao extrair o arquivo.')));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.on('close', (code) => {
      if (code === 0) return finish(resolve);
      finish(reject, new Error(`Falha ao extrair o arquivo (código ${code}). ${stderr.trim().split('\n').pop() || ''}`.trim()));
    });
  });
}

/**
 * Extrai um .tar.gz/.tgz (ex.: motores oficiais para Linux) com o tar do sistema, com a mesma validação
 * anti zip-slip e o mesmo cancelamento/limite de tempo de extractZip.
 */
async function extractTarball(tarPath, destDir, { signal = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = tarExecutable() || 'tar';
  try {
    assertSafeEntries((await runCapture(tar, ['-tzf', tarPath])).split('\n'), destDir);
  } catch (err) {
    if (/inseguro/.test(err.message)) throw err;
    throw new Error(`Não foi possível validar o arquivo compactado: ${err.message}`);
  }
  return runExtract(tar, ['-xzf', tarPath, '-C', destDir], { signal, timeoutMs });
}

/** Lista recursivamente os arquivos de uma pasta (caminhos completos). */
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full); else out.push(full);
    }
  }
  return out;
}

module.exports = { extractZip, extractTarball, walkFiles, assertSafeEntries, captureOutput: runCapture };
