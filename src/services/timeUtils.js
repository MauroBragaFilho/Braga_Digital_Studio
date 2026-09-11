'use strict';

/**
 * Utilidades de tempo local — Curitiba/Brasil (America/Sao_Paulo, GMT-3).
 *
 * Usadas para LOGS e relatórios (legibilidade humana). As datas persistidas
 * no banco continuam em UTC (ISO 8601), conforme os parsers da UI já esperam.
 */

const LOCAL_TIME_ZONE = 'America/Sao_Paulo';

function _parts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const m = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  return m;
}

/**
 * Chave YYYY-MM-DD no fuso local (nomeia os arquivos de log do dia,
 * ex.: 2026-09-09.log para eventos das 21h de Curitiba).
 */
function localDateKey(date = new Date()) {
  const m = _parts(date);
  return `${m.year}-${m.month}-${m.day}`;
}

/**
 * ISO 8601 com offset no fuso local: 2026-09-09T21:47:19.075-03:00.
 * Continua parsável por new Date() e mostra o horário de Curitiba.
 */
function zonedISO(date = new Date()) {
  const m = _parts(date);
  const utcMs = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  const offsetMin = Math.round((utcMs - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}.${ms}${off}`;
}

module.exports = { LOCAL_TIME_ZONE, localDateKey, zonedISO };