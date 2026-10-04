'use strict';

/**
 * Ações de BIBLIOTECA e PROJETOS do assistente, todas com confirmação NATIVA no processo principal:
 * add_media_to_project, tag_media, set_favorite e export_project. Só mudam vínculos, etiquetas e favoritos de mídias
 * que JÁ estão na Biblioteca (o modelo só informa ids numéricos); não existe ferramenta que apague, mova ou renomeie.
 * export_project: o DESTINO é escolhido pelo USUÁRIO no diálogo de salvar do sistema (nunca pelo modelo).
 */

const path = require('node:path');
const { ToolError, resolveMediaList, listNames, plural } = require('./common');
const { safeText, HIDDEN_PATH } = require('./results');

const MAX_MEDIA = 50;
const MAX_TAGS = 5;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,29}$/u;   // sem barras, ponto nem dois-pontos: nada que pareça caminho

const idList = (max) => ({ type: 'array', minItems: 1, maxItems: max, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 }, description: `IDs numéricos das mídias (de library_search ou do contexto da tela), de 1 a ${max}.` });
const idSpec = (what) => ({ type: 'integer', minimum: 1, maximum: 2147483647, description: `ID numérico ${what}.` });

/** Avisa as telas (Biblioteca) que as mídias mudaram. Opcional: sem o gancho, as telas atualizam ao serem abertas. */
const notifyChanged = (ctx, ids) => { try { if (typeof ctx.notifyMediaChanged === 'function') ctx.notifyMediaChanged(ids); } catch (_) { /* aviso opcional */ } };

/** Executa `fn` numa transação (mesmo padrão dos handlers de lote da Biblioteca). */
function inTransaction(db, fn) {
  db.exec('BEGIN TRANSACTION');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { try { db.exec('ROLLBACK'); } catch (_) { /* já revertido */ } throw err; }
}

// ============================================================================ add_media_to_project

const add_media_to_project = {
  name: 'add_media_to_project',
  kind: 'action',
  description: `Adiciona mídias que JÁ estão na Biblioteca a um projeto existente, opcionalmente em uma pasta do projeto (por id ou por nome). Até ${MAX_MEDIA} mídias. O app mostra a lista exata e pede confirmação. Não remove nada do projeto.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId', 'ids'],
    properties: {
      projectId: idSpec('do projeto (de projects_list)'),
      ids: idList(MAX_MEDIA),
      pastaId: idSpec('de uma pasta do projeto (de project_get)'),
      pastaNome: { type: 'string', minLength: 1, maxLength: 60, description: 'Nome de uma pasta que já existe no projeto (alternativa ao pastaId; não cria pasta).' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    if (args.pastaId && args.pastaNome) throw new ToolError('Informe a pasta por id OU por nome, não os dois.', 'BAD_ARGS');
    const project = ctx.projects.getProjectById(args.projectId);
    if (!project) throw new ToolError(`O projeto ${args.projectId} não existe.`, 'NOT_FOUND');
    let bin = null;
    if (args.pastaId || args.pastaNome) {
      const bins = ctx.projects.getProjectBins(project.id);
      if (args.pastaId) {
        bin = bins.find((b) => b.id === args.pastaId) || null;
        if (!bin) throw new ToolError(`A pasta ${args.pastaId} não existe neste projeto.`, 'NOT_FOUND');
      } else {
        const wanted = safeText(args.pastaNome, 60).toLowerCase();
        const matches = bins.filter((b) => safeText(b.name, 60).toLowerCase() === wanted);
        if (!matches.length) throw new ToolError(`Não há pasta "${safeText(args.pastaNome, 60)}" neste projeto. O assistente não cria pastas aqui; use create_project ou peça ao usuário.`, 'NOT_FOUND');
        if (matches.length > 1) throw new ToolError(`Há mais de uma pasta "${safeText(args.pastaNome, 60)}" neste projeto; use o pastaId (de project_get).`, 'BAD_ARGS');
        bin = matches[0];
      }
    }
    const items = resolveMediaList(ctx.getDb(), args.ids, { needFile: false });
    const placeholders = items.map(() => '?').join(',');
    const already = ctx.getDb().prepare(`SELECT media_id FROM project_media WHERE project_id = ? AND media_id IN (${placeholders})`).all(project.id, ...items.map((i) => i.row.id)).length;
    const names = items.map((i) => safeText(i.row.filename, 80));
    const parts = [
      `Projeto: ${safeText(project.name, 80)}`,
      bin ? `Pasta do projeto: ${safeText(bin.name, 60)}` : 'Pasta: raiz do projeto',
      `Mídias (${items.length}):\n${listNames(names)}`
    ];
    if (already) parts.push(`${plural(already, 'mídia já está', 'mídias já estão')} no projeto${bin ? ' e será movida para esta pasta' : ' e continua onde está'}.`);
    parts.push('Nada é apagado, movido de lugar no computador nem renomeado.');
    return {
      message: `O assistente quer adicionar ${plural(items.length, 'mídia', 'mídias')} ao projeto "${safeText(project.name, 80)}".`,
      detail: parts.join('\n\n'),
      plan: { projectId: project.id, projectName: safeText(project.name, 80), binId: bin ? bin.id : null, mediaIds: items.map((i) => i.row.id) },
      auditSummary: `${items.length} mídia(s) no projeto ${project.id}`
    };
  },
  run(plan, ctx) {
    const added = ctx.projects.addMediaBulkToProject(plan.projectId, plan.binId, plan.mediaIds);
    if (typeof ctx.onProjectsChanged === 'function') ctx.onProjectsChanged();
    return { projeto: { id: plan.projectId, nome: plan.projectName }, midias_adicionadas: added, ja_estavam_no_projeto: plan.mediaIds.length - added };
  }
};

// ============================================================================ tag_media

const tag_media = {
  name: 'tag_media',
  kind: 'action',
  description: `Adiciona etiquetas (tags) a mídias da Biblioteca, até ${MAX_MEDIA} mídias e ${MAX_TAGS} tags por pedido. Só acrescenta; não remove tags. O app pede confirmação.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ids', 'tags'],
    properties: {
      ids: idList(MAX_MEDIA),
      tags: { type: 'array', minItems: 1, maxItems: MAX_TAGS, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 30 }, description: `De 1 a ${MAX_TAGS} tags curtas (letras, números, espaço, hífen e sublinhado; até 30 caracteres).` }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    const tags = [];
    for (const raw of args.tags) {
      const tag = safeText(raw, 30).toLowerCase();
      if (!TAG_RE.test(tag) || tag.includes(HIDDEN_PATH)) throw new ToolError(`A tag "${safeText(raw, 30)}" é inválida: use só letras, números, espaço, hífen e sublinhado (até 30 caracteres), sem barras nem pontos.`, 'BAD_ARGS');
      if (!tags.includes(tag)) tags.push(tag);
    }
    const items = resolveMediaList(ctx.getDb(), args.ids, { needFile: false });
    const names = items.map((i) => safeText(i.row.filename, 80));
    return {
      message: `O assistente quer etiquetar ${plural(items.length, 'mídia', 'mídias')}.`,
      detail: `Tags a acrescentar (${tags.length}):\n${listNames(tags)}\n\nMídias (${items.length}):\n${listNames(names)}\n\nAs tags já existentes nas mídias são mantidas. Nada é apagado.`,
      plan: { mediaIds: items.map((i) => i.row.id), tags },
      auditSummary: `${tags.length} tag(s) em ${items.length} mídia(s)`
    };
  },
  run(plan, ctx) {
    const db = ctx.getDb();
    inTransaction(db, () => {
      for (const name of plan.tags) {
        let tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
        if (!tag) tag = { id: db.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid };
        for (const id of plan.mediaIds) db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(id, tag.id);
      }
    });
    notifyChanged(ctx, plan.mediaIds);
    return { midias_etiquetadas: plan.mediaIds.length, tags: plan.tags };
  }
};

// ============================================================================ set_favorite

const set_favorite = {
  name: 'set_favorite',
  kind: 'action',
  description: `Marca ou desmarca como favoritas mídias da Biblioteca, até ${MAX_MEDIA} por pedido. O app pede confirmação.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ids', 'favorito'],
    properties: {
      ids: idList(MAX_MEDIA),
      favorito: { type: 'boolean', description: 'true = marcar como favorita; false = desmarcar.' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    const items = resolveMediaList(ctx.getDb(), args.ids, { needFile: false });
    const names = items.map((i) => safeText(i.row.filename, 80));
    return {
      message: `O assistente quer ${args.favorito ? 'marcar como favoritas' : 'tirar dos favoritos'} ${plural(items.length, 'mídia', 'mídias')}.`,
      detail: `Mídias (${items.length}):\n${listNames(names)}\n\nNada é apagado nem alterado nos arquivos.`,
      plan: { mediaIds: items.map((i) => i.row.id), favorite: args.favorito === true },
      auditSummary: `${args.favorito ? 'favoritar' : 'desfavoritar'} ${items.length} mídia(s)`
    };
  },
  run(plan, ctx) {
    const db = ctx.getDb();
    inTransaction(db, () => { for (const id of plan.mediaIds) db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(plan.favorite ? 1 : 0, id); });
    notifyChanged(ctx, plan.mediaIds);
    return { midias_atualizadas: plan.mediaIds.length, favorito: plan.favorite };
  }
};

// ============================================================================ export_project

const EXPORT_FORMATS = {
  premiere: { label: 'XML para Premiere Pro', extension: 'xml', filterName: 'XML do Premiere' },
  bdspro: { label: 'Pacote do projeto (.bdspro)', extension: 'bdspro', filterName: 'Pacote BDS Pro' }
};

const safeFileName = (name) => (String(name || 'projeto').replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'projeto');

const export_project = {
  name: 'export_project',
  kind: 'action',
  description: 'Exporta um projeto para um arquivo (XML para Premiere Pro ou pacote .bdspro). Depois da confirmação, o USUÁRIO escolhe onde salvar numa janela do sistema; você não escolhe pasta nem nome. Não altera o projeto.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId', 'formato'],
    properties: {
      projectId: idSpec('do projeto (de projects_list)'),
      formato: { type: 'string', enum: Object.keys(EXPORT_FORMATS), description: 'premiere = XML para Premiere Pro; bdspro = pacote do projeto.' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    const project = ctx.projects.getProjectById(args.projectId);
    if (!project) throw new ToolError(`O projeto ${args.projectId} não existe.`, 'NOT_FOUND');
    const exporters = ctx.exporters || {};
    const format = EXPORT_FORMATS[args.formato];
    if (!format || !(args.formato === 'premiere' ? exporters.premiere : exporters.bdspro) || typeof ctx.chooseSavePath !== 'function') {
      throw new ToolError('A exportação de projetos não está disponível agora.', 'NO_SERVICE');
    }
    return {
      message: `O assistente quer exportar o projeto "${safeText(project.name, 80)}".`,
      detail: `Formato: ${format.label}\n\nDepois de confirmar, uma janela do sistema pergunta ONDE salvar: você escolhe a pasta e o nome (ou cancela). O projeto não é alterado.`,
      plan: { projectId: project.id, projectName: safeText(project.name, 80), format: args.formato },
      auditSummary: `projeto ${project.id} em ${args.formato}`
    };
  },
  async run(plan, ctx) {
    const format = EXPORT_FORMATS[plan.format];
    ctx.onStatus('Escolha onde salvar…', 'progress');
    const chosen = await ctx.chooseSavePath({ title: `Exportar projeto (${format.label})`, defaultName: `${safeFileName(plan.projectName)}.${format.extension}`, extension: format.extension, filterName: format.filterName });
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });
    if (!chosen) return { resultado: 'O usuário não escolheu onde salvar. Nada foi exportado.' };
    // O caminho veio do diálogo do SISTEMA (escolha do usuário): confere forma, extensão e pasta; nada vem do modelo
    let out = String(chosen);
    if (!path.isAbsolute(out) || out.startsWith('\\\\') || out.includes('\0')) throw new ToolError('O local escolhido não é aceito para exportar.', 'BAD_PATH');
    if (path.extname(out).toLowerCase() !== `.${format.extension}`) out = `${out}.${format.extension}`;
    ctx.onStatus('Exportando…', 'progress');
    try {
      if (plan.format === 'premiere') ctx.exporters.premiere.exportToPremiereXml(plan.projectId, out);
      else await ctx.exporters.bdspro.exportBdspro(plan.projectId, out, ctx.exporters.thumbnailsDir || '');
    } catch (err) {
      throw new ToolError(`Não foi possível exportar: ${safeText(err && err.message, 140)}`, 'EXPORT_FAILED');
    }
    return { exportado: true, projeto: plan.projectName, formato: format.label, arquivo: safeText(path.basename(out), 100) };
  }
};

module.exports = {
  libraryActionTools: [add_media_to_project, tag_media, set_favorite, export_project],
  MAX_MEDIA, MAX_TAGS, TAG_RE, EXPORT_FORMATS
};
