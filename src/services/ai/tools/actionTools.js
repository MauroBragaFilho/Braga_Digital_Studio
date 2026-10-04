'use strict';

/**
 * Ferramentas de AÇÃO do assistente. TODA ação passa por uma confirmação nativa no processo principal (ver
 * index.js → ToolBox.execute): o modelo apenas PROPÕE. Contrato: { name, description, parameters, kind:'action',
 * status(args), prepare(args, ctx) → { message, detail, plan }, run(plan, ctx) }.
 *   - prepare: valida contra o banco (ids existentes, arquivo comum presente, recurso instalado) e monta o texto EXATO do
 *     diálogo. Não escreve nada. Lança ToolError se algo estiver errado (a mensagem volta ao modelo).
 *   - run: só é chamado depois do "Confirmar" do usuário. Recebe o plano que o usuário viu (os mesmos ids).
 * Sem apagar, mover nem renomear nada: só cria projeto/pastas/vínculos e gera arquivos de transcrição ao lado da mídia.
 */

const path = require('node:path');
const { ToolError, resolveMediaList } = require('./common');
const { safeText, HIDDEN_PATH } = require('./results');

const MAX_TRANSCRIBE = 5;
const MAX_PROJECT_MEDIA = 50;
const MAX_FOLDERS = 10;
const NAME_LIST_LIMIT = 12;

const listNames = (items, limit = NAME_LIST_LIMIT) => {
  const lines = items.slice(0, limit).map((n) => `  • ${n}`);
  if (items.length > limit) lines.push(`  … e mais ${items.length - limit}`);
  return lines.join('\n');
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const transcribe_media = {
  name: 'transcribe_media',
  kind: 'action',
  description: `Transcreve (gera legenda e texto) mídias de vídeo ou áudio que JÁ estão na Biblioteca, até ${MAX_TRANSCRIBE} por pedido. O app pede a confirmação do usuário antes de começar. Os arquivos de transcrição ficam ao lado da mídia. Não instala nada: se o recurso de transcrição não estiver pronto, a ferramenta avisa.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ids'],
    properties: {
      ids: { type: 'array', minItems: 1, maxItems: MAX_TRANSCRIBE, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 }, description: `IDs numéricos das mídias (de library_search), de 1 a ${MAX_TRANSCRIBE}.` }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  async prepare(args, ctx) {
    const items = resolveMediaList(ctx.getDb(), args.ids, { types: ['video', 'audio'] });
    const manager = ctx.getModuleManager();
    if (!manager) throw new ToolError('O recurso de transcrição não está disponível agora.', 'NO_ENGINE');
    const status = await manager.getStatus();
    const w = (status && status.whisper) || {};
    if (status && status.busy) throw new ToolError('Já há outra operação em andamento no app. Tente de novo quando terminar.', 'BUSY');
    if (!w.ready) {
      throw new ToolError('O recurso de transcrição não está pronto (instale-o e escolha um modelo em Configurações → Transcrição). Nada foi feito; o assistente não instala nada sozinho.', 'NO_ENGINE');
    }
    const active = (w.models || []).find((m) => m.active);
    const names = items.map((i) => safeText(i.row.filename, 80));
    return {
      message: `O assistente quer transcrever ${plural(items.length, 'mídia', 'mídias')}.`,
      detail: `${listNames(names)}\n\nModelo de transcrição: ${active ? safeText(active.label, 40) : 'o modelo ativo'}.\nOs arquivos de legenda e texto serão criados ao lado de cada mídia. Nada é apagado nem alterado.`,
      plan: { ids: items.map((i) => i.row.id), files: items.map((i) => i.filepath), names, model: active ? safeText(active.label, 40) : null },
      auditSummary: `${items.length} mídia(s)`
    };
  },
  async run(plan, ctx) {
    const manager = ctx.getModuleManager();
    if (!manager) throw new ToolError('O recurso de transcrição não está disponível agora.', 'NO_ENGINE');
    const onProgress = (p) => {
      if (!p || p.kind !== 'transcribe' || p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error') return;
      if (Number.isFinite(p.percent)) ctx.onStatus(`Transcrevendo… ${Math.round(p.percent)}%`);
    };
    const onAbort = () => { try { manager.cancel(); } catch (_) { /* nada em andamento */ } };
    manager.on('progress', onProgress);
    if (ctx.signal) {
      if (ctx.signal.aborted) throw new ToolError('Cancelado.', 'CANCELLED');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    ctx.onStatus('Transcrevendo…');
    try {
      const result = await manager.transcribe({
        files: plan.files, srt: true, md: true, txt: false, maxWords: 0, lines: 2, outDir: null, forceCpu: false, skipSilence: true
      });
      return {
        transcritas: result.ok,
        com_falha: result.failed,
        arquivos_gerados: (result.outputs || []).map((o) => path.basename(o.path)),
        erros: (result.errors || []).slice(0, 5)
      };
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) throw new ToolError('Cancelado.', 'CANCELLED'); // o usuário parou o chat
      if (err && err.code === 'CANCELLED') throw new ToolError('A transcrição foi cancelada por outra tela do app.', 'TRANSCRIBE_CANCELLED');
      throw new ToolError(`A transcrição não terminou: ${safeText(err && err.message, 160)}`, 'TRANSCRIBE_FAILED');
    } finally {
      manager.off('progress', onProgress);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
  }
};

const create_project = {
  name: 'create_project',
  kind: 'action',
  description: `Cria um projeto novo no app, com pastas (opcional) e mídias JÁ existentes na Biblioteca (opcional, até ${MAX_PROJECT_MEDIA}). O app mostra ao usuário a lista exata e pede confirmação antes de criar. Não apaga, move nem renomeia nada.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['nome'],
    properties: {
      nome: { type: 'string', minLength: 1, maxLength: 80, description: 'Nome do projeto.' },
      descricao: { type: 'string', maxLength: 300, description: 'Descrição curta (opcional).' },
      pastas: { type: 'array', maxItems: MAX_FOLDERS, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 60 }, description: `Nomes das pastas a criar dentro do projeto (até ${MAX_FOLDERS}).` },
      mediaIds: { type: 'array', maxItems: MAX_PROJECT_MEDIA, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 }, description: `IDs numéricos das mídias (de library_search) a adicionar, até ${MAX_PROJECT_MEDIA}.` },
      pastaDasMidias: { type: 'string', minLength: 1, maxLength: 60, description: 'Opcional: uma das pastas informadas, onde as mídias serão colocadas. Sem isso, ficam na raiz do projeto.' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(rawArgs, ctx) {
    // O texto mostrado no diálogo é EXATAMENTE o que será gravado: normaliza (espaços) e recusa o que pareça caminho.
    const norm = (text, max, label) => {
      const clean = safeText(text, max);
      if (clean.includes(HIDDEN_PATH)) throw new ToolError(`${label} não pode conter um caminho de arquivo.`, 'BAD_ARGS');
      if (!clean) throw new ToolError(`${label} está vazio.`, 'BAD_ARGS');
      return clean;
    };
    const args = {
      ...rawArgs,
      nome: norm(rawArgs.nome, 80, 'O nome do projeto'),
      descricao: rawArgs.descricao ? norm(rawArgs.descricao, 300, 'A descrição') : '',
      pastas: (rawArgs.pastas || []).map((f) => norm(f, 60, 'O nome da pasta')),
      pastaDasMidias: rawArgs.pastaDasMidias ? norm(rawArgs.pastaDasMidias, 60, 'O nome da pasta') : ''
    };
    const folders = args.pastas;
    const mediaIds = args.mediaIds || [];
    let mediaFolder = null;
    if (args.pastaDasMidias) {
      mediaFolder = folders.find((f) => f.toLowerCase() === args.pastaDasMidias.toLowerCase());
      if (!mediaFolder) throw new ToolError('"pastaDasMidias" precisa ser uma das pastas informadas em "pastas".', 'BAD_ARGS');
      if (!mediaIds.length) throw new ToolError('"pastaDasMidias" só faz sentido com mídias.', 'BAD_ARGS');
    }
    const items = mediaIds.length ? resolveMediaList(ctx.getDb(), mediaIds, {}) : [];
    const names = items.map((i) => safeText(i.row.filename, 80));
    const parts = [`Nome: ${args.nome}`];
    if (args.descricao) parts.push(`Descrição: ${safeText(args.descricao, 300)}`);
    parts.push(folders.length ? `Pastas (${folders.length}):\n${listNames(folders.map((f) => safeText(f, 60)))}` : 'Pastas: nenhuma');
    parts.push(items.length
      ? `Mídias (${items.length})${mediaFolder ? ` na pasta "${safeText(mediaFolder, 60)}"` : ''}:\n${listNames(names)}`
      : 'Mídias: nenhuma');
    parts.push('Nada é apagado, movido nem renomeado.');
    return {
      message: `O assistente quer criar o projeto "${safeText(args.nome, 80)}".`,
      detail: parts.join('\n\n'),
      plan: { name: args.nome, description: args.descricao || '', folders, mediaIds: items.map((i) => i.row.id), mediaFolder },
      auditSummary: `projeto com ${folders.length} pasta(s) e ${items.length} mídia(s)`
    };
  },
  run(plan, ctx) {
    const svc = ctx.projects;
    const projectId = svc.createProject({ name: plan.name, description: plan.description });
    try {
      const binIds = new Map();
      for (const folder of plan.folders) binIds.set(folder, svc.createBin(projectId, null, folder));
      const added = plan.mediaIds.length
        ? svc.addMediaBulkToProject(projectId, plan.mediaFolder ? binIds.get(plan.mediaFolder) : null, plan.mediaIds)
        : 0;
      if (typeof ctx.onProjectsChanged === 'function') ctx.onProjectsChanged();
      return { projeto_criado: { id: projectId, nome: safeText(plan.name, 80) }, pastas_criadas: plan.folders.length, midias_adicionadas: added };
    } catch (err) {
      // Desfaz SÓ o que esta ação acabou de criar (o projeto novo e o que está dentro dele); nada do usuário é tocado.
      try { svc.deleteProject(projectId); } catch (_) { /* melhor esforço */ }
      throw new ToolError(`Não foi possível terminar de criar o projeto (nada ficou criado): ${safeText(err && err.message, 160)}`, 'CREATE_FAILED');
    }
  }
};

module.exports = { actionTools: [transcribe_media, create_project], MAX_TRANSCRIBE, MAX_PROJECT_MEDIA };
