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

/**
 * Lança se targetPath estiver fora de baseDir ou contiver traversal.
 *
 * @param {string} baseDir - Diretório base permitido
 * @param {string} targetPath - Caminho a ser verificado
 * @returns {string} Caminho absoluto normalizado
 * @throws {Error}
 */
function assertSafePath(baseDir, targetPath) {
  if (!baseDir || !targetPath || typeof targetPath !== 'string') {
    throw new Error('Parâmetros obrigatórios faltando para validação de caminho.');
  }

  // Normaliza e resolve
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  // Verifica se está dentro do diretório permitido
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Acesso negado: caminho '${targetPath}' está fora do diretório permitido.`);
  }

  // Bloqueia componentes suspeitos
  const suspicious = ['..', '~'];
  const parts = resolvedTarget.split(path.sep);
  for (const part of parts) {
    if (suspicious.includes(part)) {
      throw new Error(`Acesso negado: caminho contém componente suspeito '${part}'.`);
    }
  }

  return resolvedTarget;
}

/**
 * Lança se o nome de arquivo contiver caracteres perigosos.
 *
 * @param {string} name - Nome do arquivo
 * @returns {string} Nome normalizado
 * @throws {Error}
 */
function assertSafeFileName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Nome de arquivo é obrigatório.');
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

  return name;
}

/**
 * Verifica se um arquivo/pasta existe. Lança se não existir.
 *
 * @param {string} filePath
 * @throws {Error}
 */
function assertExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
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

module.exports = {
  assertSafePath,
  assertSafeFileName,
  assertExists,
  assertNonEmpty,
  assertPositiveInt
};
