'use strict';

/**
 * schema.js — Descrição declarativa dos argumentos de um canal IPC e o validador (sem dependências).
 *
 * Um esquema de canal é uma LISTA de especificações, uma por argumento posicional (o que o preload passa
 * a `ipcRenderer.invoke(canal, ...args)`). Cada especificação nasce de um construtor de `t`:
 *
 *   t.string({ max, min, pattern, enum })       texto (limite padrão 4096)
 *   t.number({ int, min, max })                 número finito (aceita só `number`)
 *   t.id()                                      inteiro positivo (também aceita "12", como assertPositiveInt)
 *   t.boolean()
 *   t.object(shape, { maxKeys })                objeto simples (não nulo, não lista); `shape` tipa chaves conhecidas,
 *                                               chaves extras passam (o serviço decide) a menos que `strict: true`
 *   t.array(item, { max, min })                 lista (limite padrão 50000)
 *   t.oneOf([specs])                            qualquer uma das especificações
 *   t.absPath()                                 caminho absoluto (assertAbsolutePath; devolve o caminho resolvido)
 *   t.file() / t.dir() / t.searchDir()          arquivo existente / pasta existente (sem raiz de drive) / pasta
 *                                               existente (raiz permitida)  — via src/ipc/validate.js
 *   t.cube()                                    caminho absoluto de um arquivo .cube
 *   t.any(motivo)                               SEM validação de tipo; o motivo é obrigatório e fica na tabela
 *
 * Modificadores comuns: { optional: true } aceita undefined/null; { label: 'Rótulo' } entra na mensagem;
 * { name: 'x' } nome do argumento (usado pelo preload gerado e pela documentação);
 * { allowEmpty: true } aceita "" como "não informado"; texto: { nonBlank: true } recusa só espaços.
 *
 * `validateArgs(schema, args)` devolve a lista de argumentos (caminhos viram o caminho resolvido) ou lança
 * um SchemaError com mensagem em português e SEM detalhes internos.
 */

const path = require('node:path');
const validate = require('./validate');

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
    this.code = 'EINVALID';
  }
}

const DEFAULT_STRING_MAX = 4096;
const DEFAULT_ARRAY_MAX = 50000;
const DEFAULT_OBJECT_KEYS = 200;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function make(kind, base, opts = {}) {
  return { kind, ...base, ...opts };
}

const t = {
  string: (opts) => make('string', {}, opts),
  number: (opts) => make('number', {}, opts),
  int: (opts) => make('number', { int: true }, opts),
  id: (opts) => make('id', {}, opts),
  boolean: (opts) => make('boolean', {}, opts),
  object: (shape = {}, opts) => make('object', { shape }, opts),
  array: (item, opts) => make('array', { item }, opts),
  oneOf: (options, opts) => make('oneOf', { options }, opts),
  absPath: (opts) => make('absPath', {}, opts),
  file: (opts) => make('file', {}, opts),
  dir: (opts) => make('dir', {}, opts),
  searchDir: (opts) => make('searchDir', {}, opts),
  cube: (opts) => make('cube', {}, opts),
  any: (reason, opts) => {
    if (typeof reason !== 'string' || reason.trim().length < 8) {
      throw new Error('t.any exige um motivo (texto) que justifique a ausência de validação.');
    }
    return make('any', { reason }, opts);
  }
};

const LABELS = { default: 'Valor' };
const labelOf = (spec, fallback) => spec.label || spec.name || fallback || LABELS.default;

function fail(spec, message, fallback) {
  throw new SchemaError(message || `${labelOf(spec, fallback)} inválido.`);
}

/** Valida UM valor contra a especificação; devolve o valor (normalizado para caminhos). */
function validateValue(spec, value, fallbackLabel) {
  if (value === undefined || value === null) {
    if (spec.optional) return value;
    if (spec.kind === 'any') return value; // `any` explícito: a decisão fica com o handler
    return fail(spec, `${labelOf(spec, fallbackLabel)} é obrigatório.`);
  }
  const label = labelOf(spec, fallbackLabel);
  if (value === '' && spec.allowEmpty) return value; // "" = não informado (o handler trata como ausente)
  switch (spec.kind) {
    case 'any':
      return value;
    case 'string': {
      if (typeof value !== 'string') return fail(spec, `${label} deve ser um texto.`);
      if (value.includes('\0')) return fail(spec);
      const max = spec.max == null ? DEFAULT_STRING_MAX : spec.max;
      if (value.length > max) return fail(spec, `${label} muito longo (máximo de ${max} caracteres).`);
      if (spec.min != null && value.length < spec.min) return fail(spec, `${label} é obrigatório.`);
      if (spec.nonBlank && value.trim().length === 0) return fail(spec, `${label} é obrigatório e não pode ser vazio.`);
      if (spec.enum && !spec.enum.includes(value)) return fail(spec, `${label} não é uma opção válida.`);
      if (spec.pattern && !spec.pattern.test(value)) return fail(spec);
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(spec, `${label} deve ser um número.`);
      if (spec.int && !Number.isInteger(value)) return fail(spec, `${label} deve ser um número inteiro.`);
      if (spec.min != null && value < spec.min) return fail(spec, `${label} abaixo do mínimo permitido.`);
      if (spec.max != null && value > spec.max) return fail(spec, `${label} acima do máximo permitido.`);
      return value;
    }
    case 'id': {
      const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN);
      if (!Number.isSafeInteger(n) || n <= 0) return fail(spec, `${label} deve ser um número inteiro positivo.`);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return fail(spec, `${label} deve ser verdadeiro ou falso.`);
      return value;
    case 'object': {
      if (!isPlainObject(value)) return fail(spec, `${label} deve ser um objeto.`);
      const keys = Object.keys(value);
      if (keys.length > (spec.maxKeys || DEFAULT_OBJECT_KEYS)) return fail(spec, `${label} tem campos demais.`);
      if (spec.strict) {
        const extra = keys.find((k) => !(k in spec.shape));
        if (extra !== undefined) return fail(spec, `${label} contém campos não permitidos.`);
      }
      const out = spec.normalize === false ? value : { ...value };
      for (const [key, sub] of Object.entries(spec.shape)) {
        const r = validateValue(sub, value[key], `${label}.${key}`);
        if (r !== undefined && spec.normalize !== false && key in value) out[key] = r;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail(spec, `${label} deve ser uma lista.`);
      const max = spec.max == null ? DEFAULT_ARRAY_MAX : spec.max;
      if (value.length > max) return fail(spec, `${label}: máximo de ${max} itens.`);
      if (spec.min != null && value.length < spec.min) return fail(spec, `${label}: informe ao menos ${spec.min} item(ns).`);
      if (!spec.item) return value;
      return value.map((v) => validateValue({ ...spec.item, label: spec.item.label || `Item de ${label}` }, v));
    }
    case 'oneOf': {
      for (const option of spec.options) {
        try { return validateValue(option, value, fallbackLabel); } catch (_) { /* tenta a próxima */ }
      }
      return fail(spec);
    }
    case 'absPath':
      try { return validate.assertAbsolutePath(value, label); } catch (e) { return fail(spec, e.message); }
    case 'file':
      try { return validate.assertUserFile(value, label); } catch (e) { return fail(spec, e.message); }
    case 'dir':
      try { return validate.assertUserDirectory(value, label); } catch (e) { return fail(spec, e.message); }
    case 'searchDir': {
      let resolved;
      try { resolved = validate.assertAbsolutePath(value, label); } catch (e) { return fail(spec, e.message); }
      let st;
      try { st = require('node:fs').statSync(resolved); } catch (_) { return fail(spec, `${label} não encontrada.`); }
      if (!st.isDirectory()) return fail(spec, `${label}: o caminho informado não é uma pasta.`);
      return resolved;
    }
    case 'cube': {
      if (typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.cube') {
        return fail(spec, 'Caminho de LUT inválido (esperado um arquivo .cube absoluto).');
      }
      return value;
    }
    default:
      throw new Error(`Esquema com tipo desconhecido: ${spec.kind}`);
  }
}

/**
 * Valida a lista de argumentos recebida pelo canal. Recusa argumentos além dos declarados
 * (a menos que `maxArgs` autorize, ex.: canais variádicos). Devolve a lista normalizada.
 */
function validateArgs(schema, args, { maxArgs } = {}) {
  const limit = maxArgs == null ? schema.length : maxArgs;
  if (args.length > limit) throw new SchemaError('Argumentos demais na chamada.');
  const out = [];
  for (let i = 0; i < schema.length; i++) {
    const spec = schema[i];
    out.push(validateValue(spec, args[i], spec.name || `Argumento ${i + 1}`));
  }
  // preserva argumentos extras permitidos por maxArgs
  for (let i = schema.length; i < args.length; i++) out.push(args[i]);
  return out;
}

/** Resumo legível de uma especificação (tabela e documentação). */
function describeSpec(spec) {
  let s;
  switch (spec.kind) {
    case 'string': s = spec.enum ? spec.enum.map((v) => `'${v}'`).join('|') : `string≤${spec.max == null ? DEFAULT_STRING_MAX : spec.max}`; break;
    case 'number': s = spec.int ? 'int' : 'number'; break;
    case 'id': s = 'id'; break;
    case 'boolean': s = 'boolean'; break;
    case 'object': s = `{${Object.keys(spec.shape).join(', ')}}`; break;
    case 'array': s = `${spec.item ? describeSpec(spec.item) : 'any'}[]≤${spec.max == null ? DEFAULT_ARRAY_MAX : spec.max}`; break;
    case 'oneOf': s = spec.options.map(describeSpec).join('|'); break;
    case 'any': s = `any(${spec.reason})`; break;
    default: s = spec.kind;
  }
  return `${spec.name ? `${spec.name}: ` : ''}${s}${spec.optional ? '?' : ''}`;
}

module.exports = { t, SchemaError, validateArgs, validateValue, describeSpec, isPlainObject };
