'use strict';

/**
 * Validação ESTRITA dos argumentos que o modelo manda para as ferramentas do assistente.
 *
 * O mesmo esquema (um subconjunto de JSON Schema) serve para DUAS coisas: ser enviado ao modelo (`parameters` de
 * cada ferramenta) e validar o que ele devolve. Os argumentos vêm de um modelo de linguagem e, portanto, são
 * entrada NÃO CONFIÁVEL: nada é "consertado" em silêncio, e o que não confere é recusado com uma mensagem curta
 * (que volta ao modelo como texto, para ele tentar de novo).
 *
 * Suportado: type (object, string, integer, boolean, array), properties, required, additionalProperties (sempre
 * recusado quando false), enum, minimum/maximum, minLength/maxLength, items, minItems/maxItems, uniqueItems,
 * default (só preenchido quando o campo falta), noControlChars (padrão: strings recusam caracteres de controle).
 */

// Caracteres de controle (inclui quebra de linha e tabulação), DEL e separadores Unicode de linha/parágrafo.
const CONTROL_CHARS = /[\0-\x1F\x7F-\x9F\u{2028}\u{2029}]/u;

class ArgError extends Error {
  constructor(message) { super(message); this.name = 'ArgError'; this.code = 'BAD_ARGS'; }
}

function typeName(v) {
  if (v === null) return 'nulo';
  if (Array.isArray(v)) return 'lista';
  return typeof v === 'object' ? 'objeto' : typeof v;
}

function check(spec, value, where) {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ArgError(`${where}: deve ser texto (recebido: ${typeName(value)}).`);
      const text = value.trim();
      if (spec.noControlChars !== false && CONTROL_CHARS.test(text)) throw new ArgError(`${where}: contém caracteres de controle.`);
      if (spec.minLength !== undefined && text.length < spec.minLength) throw new ArgError(`${where}: texto curto demais (mínimo ${spec.minLength}).`);
      if (spec.maxLength !== undefined && text.length > spec.maxLength) throw new ArgError(`${where}: texto longo demais (máximo ${spec.maxLength} caracteres).`);
      if (spec.enum && !spec.enum.includes(text)) throw new ArgError(`${where}: valor inválido (use um de: ${spec.enum.join(', ')}).`);
      return text;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArgError(`${where}: deve ser um número inteiro.`);
      if (spec.minimum !== undefined && value < spec.minimum) throw new ArgError(`${where}: mínimo ${spec.minimum}.`);
      if (spec.maximum !== undefined && value > spec.maximum) throw new ArgError(`${where}: máximo ${spec.maximum}.`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new ArgError(`${where}: deve ser verdadeiro ou falso.`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new ArgError(`${where}: deve ser uma lista.`);
      if (spec.minItems !== undefined && value.length < spec.minItems) throw new ArgError(`${where}: informe pelo menos ${spec.minItems} item(ns).`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) throw new ArgError(`${where}: no máximo ${spec.maxItems} itens.`);
      const out = value.map((item, i) => check(spec.items || {}, item, `${where}[${i + 1}]`));
      if (spec.uniqueItems && new Set(out.map((x) => (typeof x === 'string' ? x.toLowerCase() : x))).size !== out.length) {
        throw new ArgError(`${where}: não pode ter itens repetidos.`);
      }
      return out;
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ArgError(`${where}: deve ser um objeto.`);
      const props = spec.properties || {};
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) throw new ArgError(`${where === 'argumentos' ? '' : `${where}: `}argumento não permitido "${String(key).slice(0, 40)}".`);
      }
      const out = {};
      for (const [key, sub] of Object.entries(props)) {
        if (value[key] === undefined || value[key] === null) {
          if ((spec.required || []).includes(key)) throw new ArgError(`Falta o argumento "${key}".`);
          if (sub.default !== undefined) out[key] = sub.default;
          continue;
        }
        out[key] = check(sub, value[key], key);
      }
      return out;
    }
    default:
      throw new ArgError(`${where}: tipo de esquema desconhecido.`);
  }
}

/**
 * Valida `value` contra `spec` e devolve uma cópia limpa (textos aparados, padrões preenchidos).
 * @throws {ArgError}
 */
function validateArgs(spec, value) {
  return check(spec, value === undefined ? {} : value, 'argumentos');
}

/** Interpreta o texto JSON dos argumentos (vazio = {}). */
function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.length > 20000) throw new ArgError('Argumentos inválidos (JSON grande demais ou ilegível).');
  try { return JSON.parse(raw); } catch (_) { throw new ArgError('Argumentos inválidos: o JSON está malformado.'); }
}

module.exports = { validateArgs, parseArgs, ArgError, CONTROL_CHARS };
