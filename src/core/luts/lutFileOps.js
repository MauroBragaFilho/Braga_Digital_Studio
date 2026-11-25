'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LUT_EXT, MAX_FILE_BYTES, MAX_SEGMENTS } = require('./lutConstants');

/** Caracteres que não podem aparecer no nome de um arquivo (Windows) nem como separador de caminho. */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const MAX_NAME_ATTEMPTS = 50;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** SHA-256 (hex) do conteúdo de um arquivo. */
function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/** Nome de arquivo simples (sem pasta, sem caracteres proibidos, sem ser "." ou ".."). */
function assertPlainFileName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || path.basename(name) !== name || INVALID_NAME_CHARS.test(name)) {
    throw new Error('Nome de arquivo inválido.');
  }
}

/** "Nome.cube" → "Nome (2).cube" → "Nome (3).cube"… */
function candidateName(fileName, attempt) {
  if (attempt <= 1) return fileName;
  const ext = path.extname(fileName);
  return `${path.basename(fileName, ext)} (${attempt})${ext}`;
}

/**
 * Publica `tempPath` em `destPath` sem nunca sobrescrever. Tenta um vínculo físico (instantâneo e atômico);
 * em volumes que não o aceitam (FAT/exFAT, rede) cai para uma cópia exclusiva, conferida depois.
 * @returns {'created'|'exists'}
 */
function publishExclusive(tempPath, destPath, expectedHash) {
  try {
    fs.linkSync(tempPath, destPath);
    return 'created';
  } catch (err) {
    if (err.code === 'EEXIST') return 'exists';
    // sem suporte a vínculo físico neste volume: segue para a cópia exclusiva
  }
  try {
    fs.copyFileSync(tempPath, destPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code === 'EEXIST') return 'exists';
    throw err;
  }
  // O destino foi criado por nós: se a cópia não bate com o original, é removido para não deixar uma LUT corrompida.
  let ok = false;
  try { ok = hashFile(destPath) === expectedHash; } catch { ok = false; }
  if (!ok) {
    try { fs.unlinkSync(destPath); } catch { /* já ausente */ }
    throw new Error('A cópia ficou diferente do original e foi descartada.');
  }
  return 'created';
}

/**
 * Copia um arquivo de LUT (ou o conteúdo já lido em um Buffer) para `destDir` sem sobrescrever nada e sem nunca
 * deixar um arquivo pela metade no destino: grava em `.<nome>.<aleatório>.part`, confere tamanho e SHA-256
 * contra a origem e só então publica.
 *
 * - sem `exact`: nome ocupado gera "Nome (2).cube", "Nome (3).cube"… (até 50 tentativas);
 * - com `exact: true`: nunca cria sufixo; nome ocupado devolve `exists` (usado pelas LUTs embutidas).
 *
 * Com um caminho, a origem precisa ser um arquivo comum (link simbólico é recusado). Com um Buffer, o MESMO conteúdo
 * que o chamador já leu, validou e calculou o hash é o que se grava (a origem não é lida de novo). Lança erro em
 * qualquer falha; o `.part` é removido em todos os casos.
 * @param {string|Buffer} source
 * @param {string} destDir - pasta que já existe
 * @param {string} preferredName - nome simples do arquivo (sem pastas)
 * @param {{ exact?: boolean }} [options]
 * @returns {{ status: 'copied'|'exists', name: string|null, path: string|null, sha256: string }}
 */
function copyFileExclusive(source, destDir, preferredName, { exact = false } = {}) {
  assertPlainFileName(preferredName);
  let data;
  if (Buffer.isBuffer(source)) {
    data = source;
  } else {
    const info = fs.lstatSync(source);
    if (!info.isFile()) throw new Error('A origem não é um arquivo comum.');
    if (info.size > MAX_FILE_BYTES) throw new Error('O arquivo é maior que o limite aceito.');
    data = fs.readFileSync(source);
  }
  if (data.length > MAX_FILE_BYTES) throw new Error('O arquivo é maior que o limite aceito.');
  const hash = sha256(data);
  const tempPath = path.join(destDir, `.${preferredName}.${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    fs.writeFileSync(tempPath, data, { flag: 'wx' });
    const written = fs.readFileSync(tempPath);
    if (written.length !== data.length || sha256(written) !== hash) throw new Error('A gravação ficou diferente do original.');

    const attempts = exact ? 1 : MAX_NAME_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const name = candidateName(preferredName, attempt);
      const destPath = path.join(destDir, name);
      if (publishExclusive(tempPath, destPath, hash) === 'created') return { status: 'copied', name, path: destPath, sha256: hash };
    }
    if (exact) return { status: 'exists', name: null, path: null, sha256: hash };
    throw new Error('Não foi possível encontrar um nome livre para o arquivo.');
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* já ausente */ }
  }
}

/**
 * Mapeia SHA-256 → caminho relativo dos arquivos .cube da coleção (em qualquer subpasta, até MAX_SEGMENTS níveis).
 * Só lê (e calcula o hash de) arquivos cujo tamanho esteja em `sizes`: quem tem tamanho diferente nunca é idêntico.
 * Não segue links simbólicos nem entra em pastas ou arquivos ocultos (nome começando com ponto). Erros por
 * entrada são ignorados.
 * @param {string} rootDir
 * @param {Set<number>} sizes
 * @returns {Map<string, string>}
 */
function indexByHash(rootDir, sizes) {
  const index = new Map();
  const walk = (dir, segments) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (segments + 1 < MAX_SEGMENTS) walk(full, segments + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(LUT_EXT)) {
        try {
          if (!sizes.has(fs.statSync(full).size)) continue;
          const hash = hashFile(full);
          if (!index.has(hash)) index.set(hash, path.relative(rootDir, full));
        } catch { /* arquivo sumiu ou ilegível: fora do índice */ }
      }
    }
  };
  walk(rootDir, 0);
  return index;
}

const PART_NAME = /^..+.[0-9a-f]{12}.part$/;
const STALE_PART_MS = 60 * 60 * 1000;

/**
 * Apaga os arquivos temporários ".part" que uma cópia interrompida deixou na coleção (mais velhos que `olderThanMs`,
 * uma hora por padrão). Percorre as pastas até MAX_SEGMENTS níveis, sem seguir links nem junções, sem bloquear o
 * processo. Erros por entrada são ignorados.
 * @param {string} rootDir
 * @param {{ olderThanMs?: number, now?: number }} [options]
 * @returns {Promise<number>} quantos arquivos foram apagados
 */
async function sweepPartials(rootDir, { olderThanMs = STALE_PART_MS, now = Date.now() } = {}) {
  let removed = 0;
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && depth + 1 < MAX_SEGMENTS) await walk(full, depth + 1);
      } else if (entry.isFile() && PART_NAME.test(entry.name)) {
        try {
          const stats = await fs.promises.lstat(full);
          if (stats.isFile() && now - stats.mtimeMs > olderThanMs) { await fs.promises.unlink(full); removed++; }
        } catch { /* sumiu ou em uso */ }
      }
    }
  };
  await walk(rootDir, 0);
  return removed;
}

module.exports = { hashFile, sha256, copyFileExclusive, indexByHash, sweepPartials };
