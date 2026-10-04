'use strict';

/**
 * CONTEXTO DA TELA (requisito C): a cada mensagem o renderer envia um objeto pequeno
 *   { screen, selectedIds?, projectId? }
 * como argumento OPCIONAL de ai:chatStart. O main valida tudo (tipos, limites, telas conhecidas) e o acrescenta ao
 * prompt de sistema como DADO NÃO CONFIÁVEL. O contexto serve para o modelo entender "este vídeo", "o que está
 * selecionado", "este projeto"; ele NUNCA autoriza uma ação: toda ação continua pedindo a confirmação nativa.
 *
 * Nada vindo do renderer entra no prompt como texto livre: a tela vira o nome fixo da lista (screens.js) e os ids
 * viram nomes lidos do BANCO (curtos, sem caminhos, com safeText).
 */

const { screenById } = require('./screens');
const { safeText } = require('./tools/results');

const MAX_SELECTED = 50;
const MAX_NAMED = 8;       // só estes ganham o nome no prompt (os demais entram só como id)
const MAX_ID = 2147483647;

class ContextError extends Error {
  constructor(message) { super(message); this.name = 'ContextError'; this.code = 'BAD_CONTEXT'; }
}

const isId = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ID;

/**
 * Valida o contexto vindo do renderer. `undefined`/`null` = sem contexto. Qualquer coisa fora do esquema é recusada
 * (nada é "consertado" em silêncio). Devolve uma cópia limpa.
 * @returns {{screen:string, selectedIds:number[], projectId:number|null}|null}
 */
function validateContext(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ContextError('Contexto da tela inválido.');
  const allowed = new Set(['screen', 'selectedIds', 'projectId']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ContextError(`Contexto da tela: campo não permitido "${String(key).slice(0, 30)}".`);
  }
  if (typeof raw.screen !== 'string' || !screenById(raw.screen)) throw new ContextError('Contexto da tela: tela desconhecida.');
  let selectedIds = [];
  if (raw.selectedIds !== undefined && raw.selectedIds !== null) {
    if (!Array.isArray(raw.selectedIds)) throw new ContextError('Contexto da tela: a seleção deve ser uma lista.');
    if (raw.selectedIds.length > MAX_SELECTED) throw new ContextError(`Contexto da tela: no máximo ${MAX_SELECTED} itens selecionados.`);
    if (!raw.selectedIds.every(isId)) throw new ContextError('Contexto da tela: a seleção só aceita ids numéricos.');
    selectedIds = [...new Set(raw.selectedIds)];
  }
  let projectId = null;
  if (raw.projectId !== undefined && raw.projectId !== null) {
    if (!isId(raw.projectId)) throw new ContextError('Contexto da tela: projeto inválido.');
    projectId = raw.projectId;
  }
  return { screen: raw.screen, selectedIds, projectId };
}

/**
 * Bloco de texto do prompt de sistema. Mostra a tela, a seleção (ids; nomes dos primeiros, lidos do banco) e o
 * projeto aberto. Falha de banco nunca derruba o chat: o bloco sai só com o que for seguro.
 * @param {ReturnType<typeof validateContext>} ctx
 * @param {{ getDb?: Function, projects?: object }} [deps]
 * @returns {string} '' se não há contexto
 */
function buildContextBlock(ctx, { getDb = null, projects = null } = {}) {
  if (!ctx) return '';
  const lines = [`Tela atual: ${screenById(ctx.screen).label}.`];
  if (ctx.selectedIds.length) {
    let names = new Map();
    try {
      const db = getDb ? getDb() : null;
      if (db) {
        const head = ctx.selectedIds.slice(0, MAX_NAMED);
        const rows = db.prepare(`SELECT id, filename FROM media WHERE id IN (${head.map(() => '?').join(',')})`).all(...head);
        names = new Map(rows.map((r) => [r.id, safeText(r.filename, 60)]));
      }
    } catch (_) { names = new Map(); }
    const shown = ctx.selectedIds.slice(0, MAX_NAMED).map((id) => (names.has(id) ? `${id} ("${names.get(id)}")` : String(id)));
    const rest = ctx.selectedIds.length - shown.length;
    lines.push(`Mídias selecionadas na Biblioteca (${ctx.selectedIds.length}): ids ${shown.join(', ')}${rest > 0 ? ` e mais ${rest} (ids: ${ctx.selectedIds.slice(MAX_NAMED).join(', ')})` : ''}.`);
  } else if (ctx.screen === 'library') {
    lines.push('Nenhuma mídia selecionada.');
  }
  if (ctx.projectId) {
    let name = '';
    try { const p = projects && projects.getProjectById ? projects.getProjectById(ctx.projectId) : null; name = p ? safeText(p.name, 60) : ''; } catch (_) { name = ''; }
    lines.push(`Projeto em foco: id ${ctx.projectId}${name ? ` ("${name}")` : ''}.`);
  }
  return lines.join(' ');
}

module.exports = { validateContext, buildContextBlock, ContextError, MAX_SELECTED };
