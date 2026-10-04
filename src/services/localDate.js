'use strict';

/**
 * Datas de calendário ('YYYY-MM-DD', como o prazo e o início de um projeto) são DIAS, não instantes:
 * `new Date('2026-10-05')` as interpreta como meia-noite UTC, o que no Brasil (UTC-3) vira o dia
 * anterior às 21h. Este módulo as interpreta como meia-noite LOCAL.
 * Espelho de renderer/utils/localDate.js: mantenha os dois arquivos iguais.
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_MIDNIGHT_RE = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?Z?$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Converte a entrada em Date. 'YYYY-MM-DD' (opcionalmente seguido de 'T...' com a hora zerada,
 * como alguns registros antigos) vira meia-noite local; qualquer outro texto/Date segue o parse
 * padrão (timestamps completos continuam sendo instantes).
 * @param {string|Date|number|null|undefined} value
 * @returns {Date|null} null se vazio ou inválido
 */
function parseLocalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());

  if (typeof value === 'string') {
    const text = value.trim();
    const m = DATE_ONLY_RE.exec(text) || DATE_MIDNIGHT_RE.exec(text);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const date = new Date(y, mo - 1, d);
      // Rejeita datas inexistentes (ex.: 2026-02-31 viraria 3 de março)
      if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
      return date;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Dias inteiros de `now` até a data (ambos normalizados para a meia-noite local).
 * Negativo = atrasado, 0 = hoje. Arredonda para tolerar a mudança de horário de verão.
 * @returns {number|null} null se a data for inválida
 */
function daysUntilLocal(value, now = new Date()) {
  const target = parseLocalDate(value);
  if (!target) return null;
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * Formata como data local pt-BR (ex.: 05/10/2026); '-' se vazio/inválido.
 */
function formatLocalDate(value, locale = 'pt-BR') {
  const d = parseLocalDate(value);
  return d ? d.toLocaleDateString(locale) : '-';
}

module.exports = { parseLocalDate, daysUntilLocal, formatLocalDate };
