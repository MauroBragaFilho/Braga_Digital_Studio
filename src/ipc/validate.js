'use strict';

/**
 * validate.js — Validação centralizada de entradas IPC.
 *
 * Regra 4 do roadmap (seções 24 e 51):
 *   Operações que recebem caminhos do renderer devem validar esses caminhos
 *   antes de executar qualquer operação de filesystem.
 *
 * Uso:
 *   const { assertSafePath, assertSafeFileName, assertExists } = require('./validate');
 *   assertSafePath(allowedDir, userInputPath);
 */

const path = require('node:path');
const fs = require('node:fs');

const IS_WIN = process.platform === 'win32';

/** Nomes de dispositivo reservados no Windows (com ou sem extensão). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Normaliza para comparação (case-insensitive no Windows). */
function cmpForm(p) {
  return IS_WIN ? p.toLowerCase() : p;
}

/**
 * realpath tolerante: resolve links simbólicos do trecho existente do caminho e
 * concatena o restante (que ainda não existe). Evita escapar da base por symlink/junction.
 */
function realpathLoose(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(base, target) {
  const b = cmpForm(base);
  const t = cmpForm(target);
  if (t === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return t.startsWith(prefix);
}

/**
 * Lança se targetPath não for absoluto ou estiver fora de baseDir (após resolver
 * links simbólicos). A comparação ignora maiúsculas/minúsculas no Windows.
 *
 * @param {string} baseDir - Diretório base permitido
 * @param {string} targetPath - Caminho a ser verificado
 * @returns {string} Caminho absoluto normalizado (path.resolve) do alvo
 * @throws {Error}
 */
function assertSafePath(baseDir, targetPath) {
  if (!baseDir || typeof baseDir !== 'string' || !targetPath || typeof targetPath !== 'string') {
    throw new Error('Parâmetros obrigatórios faltando para validação de caminho.');
  }
  if (targetPath.includes('\0') || baseDir.includes('\0')) {
    throw new Error('Caminho inválido.');
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Caminho deve ser absoluto: '${targetPath}'`);
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  // Primeiro o teste lexical; depois o teste com links simbólicos resolvidos.
  if (!isInside(resolvedBase, resolvedTarget)) {
    throw new Error(`Acesso negado: caminho '${targetPath}' está fora do diretório permitido.`);
  }
  if (!isInside(realpathLoose(resolvedBase), realpathLoose(resolvedTarget))) {
    throw new Error(`Acesso negado: caminho '${targetPath}' resolve para fora do diretório permitido.`);
  }

  return resolvedTarget;
}

/**
 * Lança se o nome de arquivo contiver caracteres perigosos ou for um nome reservado.
 *
 * @param {string} name - Nome do arquivo
 * @returns {string} Nome validado
 * @throws {Error}
 */
function assertSafeFileName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Nome de arquivo é obrigatório.');
  }
  if (name.length > 255) {
    throw new Error('Nome de arquivo muito longo.');
  }

  // Bloqueia path separators, null bytes, caracteres de controle
  const forbidden = /[\/\\:*?"<>|\x00-\x1f]/;
  if (forbidden.test(name)) {
    throw new Error(`Nome de arquivo contém caracteres inválidos: '${name}'`);
  }

  // Bloqueia nomes que são apenas pontos ou espaços
  if (/^[\s.]+$/.test(name)) {
    throw new Error(`Nome de arquivo inválido: '${name}'`);
  }

  // O Windows remove ponto/espaço finais silenciosamente — evita nomes ambíguos
  if (/[. ]$/.test(name)) {
    throw new Error(`Nome de arquivo não pode terminar com ponto ou espaço: '${name}'`);
  }

  // Nomes reservados (CON, NUL, COM1...), com ou sem extensão ("con.txt" também é reservado)
  const stem = name.split('.')[0].trim();
  if (WINDOWS_RESERVED.test(stem)) {
    throw new Error(`Nome de arquivo reservado pelo sistema: '${name}'`);
  }

  return name;
}

/**
 * Verifica se um arquivo/pasta existe. Lança se não existir.
 *
 * @param {string} filePath
 * @throws {Error}
 */
function assertExists(filePath) {
  if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
    throw new Error(`Caminho não encontrado: '${filePath}'`);
  }
}

/**
 * Valida que o valor é uma string não vazia.
 *
 * @param {*} value
 * @param {string} fieldName
 * @returns {string}
 * @throws {Error}
 */
function assertNonEmpty(value, fieldName = 'valor') {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} é obrigatório e não pode ser vazio.`);
  }
  return value;
}

/**
 * Valida que o valor é um número inteiro positivo.
 *
 * @param {*} value
 * @param {string} fieldName
 * @returns {number}
 * @throws {Error}
 */
function assertPositiveInt(value, fieldName = 'valor') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${fieldName} deve ser um número inteiro positivo.`);
  }
  return num;
}

/** true se p for a raiz de um drive/filesystem (C:\, /). */
function isDriveRoot(p) {
  const resolved = path.resolve(p);
  return path.parse(resolved).root === resolved || path.parse(resolved).root === resolved + path.sep;
}

/**
 * Valida um caminho absoluto vindo do renderer (sem restringir a uma base).
 * Rejeita não-string, bytes nulos e caminhos relativos.
 * @returns {string} caminho resolvido
 */
function assertAbsolutePath(p, label = 'Caminho') {
  if (!p || typeof p !== 'string' || p.includes('\0') || p.length > 4096) {
    throw new Error(`${label} inválido.`);
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`${label} deve ser um caminho absoluto.`);
  }
  return path.resolve(p);
}

/**
 * Valida uma pasta escolhida pelo usuário: absoluta, existente, diretório e que
 * não seja a raiz de um drive. @returns {string} caminho resolvido
 */
function assertUserDirectory(p, label = 'Pasta') {
  const resolved = assertAbsolutePath(p, label);
  if (isDriveRoot(resolved)) {
    throw new Error(`${label} não pode ser a raiz de um drive.`);
  }
  let st;
  try { st = fs.statSync(resolved); } catch (_) { throw new Error(`${label} não encontrada: '${p}'`); }
  if (!st.isDirectory()) throw new Error(`${label} não é uma pasta: '${p}'`);
  return resolved;
}

/**
 * Valida um arquivo existente informado pelo renderer. @returns {string} caminho resolvido
 */
function assertUserFile(p, label = 'Arquivo') {
  const resolved = assertAbsolutePath(p, label);
  let st;
  try { st = fs.statSync(resolved); } catch (_) { throw new Error(`${label} não encontrado: '${p}'`); }
  if (!st.isFile()) throw new Error(`${label} não é um arquivo: '${p}'`);
  return resolved;
}

/**
 * Valida uma lista de ids (inteiros positivos, sem repetição) com limite máximo.
 * @returns {number[]}
 */
function assertIdArray(ids, { max = 50000, label = 'ids' } = {}) {
  if (!Array.isArray(ids)) throw new Error(`${label} deve ser uma lista.`);
  if (ids.length > max) throw new Error(`${label}: máximo de ${max} itens por operação.`);
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`ID inválido: ${raw}`);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/** Divide um array em lotes (o SQLite limita o número de variáveis por consulta). */
function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Gera "?,?,?" para n parâmetros (n deve ser inteiro de 1 a 999). */
function sqlPlaceholders(n) {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error('Quantidade de parâmetros inválida.');
  return new Array(n).fill('?').join(',');
}

/** Valida porta TCP (1-65535). @returns {number} */
function assertPort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Porta inválida.');
  return n;
}

/**
 * true se ip for um IP literal (v4/v6) privado, loopback ou link-local.
 * Dispositivos BDSM só existem na rede local — impede SSRF para hosts externos.
 */
function isPrivateIp(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return false;
    if (o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    return false;
  }
  const lower = s.toLowerCase().split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(lower) || !lower.includes(':')) return false;
  if (lower === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;      // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;      // fe80::/10 (link-local)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

function assertPrivateIp(ip) {
  if (!isPrivateIp(ip)) throw new Error('Endereço IP inválido: apenas IPs da rede local são permitidos.');
  const bare = String(ip).trim().replace(/^\[|\]$/g, '');
  // IPv6 precisa de colchetes para compor uma URL (http://[fe80::1]:8080)
  return bare.includes(':') ? `[${bare}]` : bare;
}

/**
 * Valida URL para abrir externamente: apenas https: (e mailto:).
 * @returns {string} URL normalizada
 */
function assertExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) throw new Error('URL inválida.');
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('URL inválida.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'mailto:') {
    throw new Error('Protocolo não permitido (apenas https e mailto).');
  }
  if (u.protocol === 'https:' && (!u.hostname || u.username || u.password)) throw new Error('URL inválida.');
  return u.toString();
}

module.exports = {
  assertSafePath,
  assertSafeFileName,
  assertExists,
  assertNonEmpty,
  assertPositiveInt,
  assertAbsolutePath,
  assertUserDirectory,
  assertUserFile,
  assertIdArray,
  assertPort,
  assertPrivateIp,
  assertExternalUrl,
  isPrivateIp,
  isDriveRoot,
  realpathLoose,
  sqlPlaceholders,
  chunk,
  // Auxiliares de baixo nível reaproveitados por thumbProtocol.js
  __internal: { isInside, cmpForm }
};
