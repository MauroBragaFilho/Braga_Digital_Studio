'use strict';

/**
 * Peças comuns das ferramentas do assistente: erro "para o modelo", resolução SEGURA de mídia a partir do ID do
 * banco (o modelo nunca informa caminho) e resumo enxuto de mídia (sem caminho completo).
 */

const fs = require('node:fs');
const path = require('node:path');
const { safeText } = require('./results');

/** Erro esperado de uma ferramenta: a mensagem (curta, em português) volta ao modelo como texto. */
class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') { super(message); this.name = 'ToolError'; this.code = code; }
}

const TYPE_LABEL = { video: 'video', audio: 'audio', photo: 'foto', raw: 'foto' };
const TYPE_TO_DB = { video: 'video', audio: 'audio', foto: 'photo' };

/** Mídia pronta e presente (mesma regra da Biblioteca): status READY e não marcada como ausente. */
const READY_SQL = "(status = 'READY' OR status IS NULL) AND (missing = 0 OR missing IS NULL)";

const round = (n, d = 1) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 10 ** d) / 10 ** d : null);

/** Resumo enxuto de uma linha da tabela media: nada de caminho completo. */
function summarizeMedia(row) {
  const out = {
    id: row.id,
    nome: safeText(row.filename, 120),
    tipo: TYPE_LABEL[row.media_type] || 'outro'
  };
  if (row.duration) out.duracao_s = round(row.duration, 1);
  if (row.width && row.height) out.resolucao = `${row.width}x${row.height}`;
  if (row.project_name) out.projeto = safeText(row.project_name, 80);
  const date = String(row.recorded_at || row.imported_at || '').slice(0, 10);
  if (date) out.data = date;
  return out;
}

/**
 * Resolve um ID do banco para a mídia e seu arquivo REAL. O main é quem conhece o caminho; confere que a mídia
 * está na Biblioteca (linha pronta e não ausente), que o arquivo existe e que é arquivo comum (não pasta nem link).
 * @param {object} db
 * @param {number} id
 * @param {{types?:string[], needFile?:boolean}} [opts]  types: restringe media_type (ex.: ['video','audio'])
 * @returns {{ row:object, filepath:string }}
 */
function resolveMedia(db, id, { types = null, needFile = true } = {}) {
  const row = db.prepare(`SELECT m.*, p.name AS project_name FROM media m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ? AND ${READY_SQL.replace(/\b(status|missing)\b/g, 'm.$1')}`).get(id);
  if (!row) throw new ToolError(`A mídia ${id} não existe na Biblioteca.`, 'NOT_FOUND');
  if (types && !types.includes(row.media_type)) {
    throw new ToolError(`A mídia ${id} (${safeText(row.filename, 60)}) é do tipo ${TYPE_LABEL[row.media_type] || 'outro'}; esta ação só aceita ${types.map((t) => TYPE_LABEL[t]).join(' ou ')}.`, 'BAD_TYPE');
  }
  const filepath = String(row.filepath || '');
  if (needFile) {
    let st = null;
    try { st = fs.lstatSync(filepath); } catch (_) { st = null; }
    if (!path.isAbsolute(filepath) || !st || !st.isFile()) {
      throw new ToolError(`O arquivo da mídia ${id} (${safeText(row.filename, 60)}) não foi encontrado no computador.`, 'FILE_MISSING');
    }
  }
  return { row, filepath };
}

/** Resolve vários IDs (todos ou nenhum): devolve a lista na mesma ordem. */
function resolveMediaList(db, ids, opts) {
  const problems = [];
  const items = [];
  for (const id of ids) {
    try { items.push(resolveMedia(db, id, opts)); } catch (err) {
      if (err instanceof ToolError) problems.push(err.message); else throw err;
    }
  }
  if (problems.length) throw new ToolError(`Nada foi feito. ${problems.slice(0, 4).join(' ')}${problems.length > 4 ? ` (e mais ${problems.length - 4} problema(s))` : ''}`, 'BAD_MEDIA');
  return items;
}

const NAME_LIST_LIMIT = 12;

/** Lista com marcadores para o texto dos diálogos de confirmação (mostra os primeiros e conta o resto). */
const listNames = (items, limit = NAME_LIST_LIMIT) => {
  const lines = items.slice(0, limit).map((n) => `  • ${n}`);
  if (items.length > limit) lines.push(`  … e mais ${items.length - limit}`);
  return lines.join('\n');
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Módulos ligados agora ({ id: boolean }); vazio se o app não informou. */
const enabledModules = (ctx) => {
  try { return (ctx && typeof ctx.getEnabledModules === 'function' ? ctx.getEnabledModules() : null) || {}; } catch (_) { return {}; }
};

/** Exige que um módulo esteja ligado em Configurações → Módulos (se o app informou o estado dos módulos). */
function requireModule(ctx, id, label) {
  const mods = enabledModules(ctx);
  if (Object.keys(mods).length && mods[id] !== true) {
    throw new ToolError(`O recurso "${label}" está desligado. O usuário pode ligá-lo em Configurações → Módulos.`, 'MODULE_OFF');
  }
}

/** Serviço opcional do app (downloads, conversor...): erro curto para o modelo se não estiver disponível. */
function requireService(ctx, name, label) {
  const svc = ctx && ctx.services ? ctx.services[name] : null;
  if (!svc) throw new ToolError(`O recurso "${label}" não está disponível agora.`, 'NO_SERVICE');
  return svc;
}

module.exports = {
  ToolError, summarizeMedia, resolveMedia, resolveMediaList, READY_SQL, TYPE_TO_DB, TYPE_LABEL, round,
  listNames, plural, enabledModules, requireModule, requireService, NAME_LIST_LIMIT
};
