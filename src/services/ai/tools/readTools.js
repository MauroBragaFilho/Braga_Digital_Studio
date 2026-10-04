'use strict';

/**
 * Ferramentas de LEITURA do assistente (executam sem pedir confirmação): só consultam, nunca escrevem.
 * Devolvem resumos curtos, sem caminhos completos. Contrato (ver index.js): { name, description, parameters,
 * kind:'read', status(args), run(args, ctx) }.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ToolError, summarizeMedia, resolveMedia, READY_SQL, TYPE_TO_DB, TYPE_LABEL } = require('./common');
const { safeText } = require('./results');

const MAX_SEARCH = 20;
const MAX_PROJECTS = 30;
const MAX_PROJECT_MEDIA = 40;
const MAX_BINS = 40;

const idSpec = (what) => ({ type: 'integer', minimum: 1, maximum: 2147483647, description: `ID numérico ${what}, vindo de outra ferramenta (nunca invente).` });

const library_search = {
  name: 'library_search',
  kind: 'read',
  description: 'Busca mídias na Biblioteca do app (por texto no nome/notas/tags, tipo, favoritos ou projeto). Devolve uma lista curta com id, nome, tipo, duração, resolução, projeto e data. Use os ids devolvidos nas outras ferramentas.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      texto: { type: 'string', maxLength: 100, description: 'Texto a procurar (nome do arquivo, notas, tags, projeto). Vazio = tudo.' },
      tipo: { type: 'string', enum: ['video', 'audio', 'foto'], description: 'Filtra por tipo de mídia.' },
      favoritos: { type: 'boolean', description: 'true = só favoritos.' },
      projetoId: idSpec('do projeto'),
      limite: { type: 'integer', minimum: 1, maximum: MAX_SEARCH, default: 10, description: `Quantos resultados (1 a ${MAX_SEARCH}).` }
    }
  },
  status: () => 'Consultando a Biblioteca…',
  run(args, ctx) {
    const options = {
      query: args.texto || '',
      types: args.tipo ? [TYPE_TO_DB[args.tipo]] : [],
      favorites: args.favoritos === true,
      projects: args.projetoId ? [args.projetoId] : [],
      limit: args.limite || 10,
      offset: 0
    };
    const r = ctx.library.searchMedia(options);
    return {
      total_encontrado: r.totalCount,
      mostrando: r.items.length,
      midias: r.items.map(summarizeMedia)
    };
  }
};

const media_get = {
  name: 'media_get',
  kind: 'read',
  description: 'Detalhes de UMA mídia da Biblioteca pelo id: nome, tipo, duração, resolução, tags, projetos vinculados e se já existe uma transcrição ao lado do arquivo.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: idSpec('da mídia') }
  },
  status: () => 'Consultando a Biblioteca…',
  run(args, ctx) {
    const db = ctx.getDb();
    const { row, filepath } = resolveMedia(db, args.id, { needFile: false });
    const tags = db.prepare('SELECT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ? ORDER BY t.name LIMIT 30').all(row.id).map((t) => safeText(t.name, 40));
    const links = db.prepare('SELECT p.id, p.name FROM project_media pm JOIN projects p ON p.id = pm.project_id WHERE pm.media_id = ? GROUP BY p.id ORDER BY p.name LIMIT 20').all(row.id)
      .map((p) => ({ id: p.id, nome: safeText(p.name, 80) }));
    const stem = path.join(path.dirname(filepath), path.basename(filepath, path.extname(filepath)));
    const sidecars = ['srt', 'md', 'txt', 'vtt'].filter((ext) => { try { return fs.lstatSync(`${stem}.${ext}`).isFile(); } catch (_) { return false; } });
    const out = {
      ...summarizeMedia(row),
      favorito: row.favorite === 1,
      tags,
      projetos_vinculados: links,
      tem_transcricao_ao_lado: sidecars.length > 0,
      formatos_de_transcricao: sidecars,
      arquivo_existe: (() => { try { return fs.lstatSync(filepath).isFile(); } catch (_) { return false; } })()
    };
    if (row.fps) out.fps = Math.round(row.fps * 100) / 100;
    if (row.video_codec) out.codec_video = safeText(row.video_codec, 20);
    if (row.audio_codec) out.codec_audio = safeText(row.audio_codec, 20);
    if (row.notes) out.notas_nao_confiaveis = safeText(row.notes, 200);
    return out;
  }
};

const projects_list = {
  name: 'projects_list',
  kind: 'read',
  description: 'Lista os projetos do app (id, nome, situação, quantidade de mídias e data de criação).',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  status: () => 'Consultando os Projetos…',
  run(_args, ctx) {
    const all = ctx.projects.getAllProjects();
    return {
      total: all.length,
      projetos: all.slice(0, MAX_PROJECTS).map((p) => ({
        id: p.id,
        nome: safeText(p.name, 80),
        situacao: safeText(p.status, 20),
        midias: p.media_count || 0,
        criado: String(p.created_at || '').slice(0, 10)
      }))
    };
  }
};

const project_get = {
  name: 'project_get',
  kind: 'read',
  description: 'Conteúdo de UM projeto pelo id: descrição, pastas, mídias (com a pasta de cada uma), sequências (com contagem de trilhas, clipes e marcadores) e marcadores em resumo.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: idSpec('do projeto') }
  },
  status: () => 'Consultando os Projetos…',
  run(args, ctx) {
    const project = ctx.projects.getProjectById(args.id);
    if (!project) throw new ToolError(`O projeto ${args.id} não existe.`, 'NOT_FOUND');
    const bins = ctx.projects.getProjectBins(args.id);
    const binName = new Map(bins.map((b) => [b.id, safeText(b.name, 60)]));
    const media = ctx.projects.getProjectMedia(args.id);
    const sequences = ctx.projects.getSequences(args.id);
    const markers = typeof ctx.projects.getMarkers === 'function' ? ctx.projects.getMarkers(args.id) : [];
    // Sequências em resumo: trilhas e clipes (só contagens; nada da linha do tempo sai daqui)
    const sequenceSummary = (s) => {
      let tracks = [];
      let clips = 0;
      try {
        tracks = ctx.projects.getTracks(s.id);
        const byTrack = ctx.projects.getClipsByTrackIds(tracks.map((t) => t.id));
        for (const list of byTrack.values()) clips += list.length;
      } catch (_) { /* resumo parcial: contagens ficam em 0 */ }
      return {
        id: s.id,
        nome: safeText(s.name, 60),
        largura: s.width || null,
        altura: s.height || null,
        trilhas: tracks.length,
        clipes: clips,
        marcadores: markers.filter((m) => m.sequence_id === s.id).length
      };
    };
    return {
      id: project.id,
      nome: safeText(project.name, 80),
      descricao: safeText(project.description, 300),
      situacao: safeText(project.status, 20),
      pastas: bins.slice(0, MAX_BINS).map((b) => ({ id: b.id, nome: binName.get(b.id), pasta_pai: b.parent_id ? (binName.get(b.parent_id) || null) : null })),
      total_de_midias: media.length,
      midias: media.slice(0, MAX_PROJECT_MEDIA).map((m) => ({
        id: m.id,
        nome: safeText(m.custom_name || m.filename, 120),
        tipo: TYPE_LABEL[m.media_type] || 'outro',
        ...(m.duration ? { duracao_s: Math.round(m.duration * 10) / 10 } : {}),
        pasta: m.bin_id ? (binName.get(m.bin_id) || null) : null
      })),
      sequencias: sequences.slice(0, 10).map(sequenceSummary),
      total_de_marcadores: markers.length,
      marcadores: markers.slice(0, 5).map((m) => ({ tempo_s: Math.round((Number(m.time) || 0) * 10) / 10, rotulo: safeText(m.label || m.comment, 60) }))
    };
  }
};

const transcription_status = {
  name: 'transcription_status',
  kind: 'read',
  description: 'Informa se o recurso de transcrição está instalado e pronto, qual modelo está ativo e se há uma transcrição em andamento. Consulte antes de propor transcrever.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  status: () => 'Consultando o estado da transcrição…',
  async run(_args, ctx) {
    const manager = ctx.getModuleManager();
    if (!manager) return { disponivel: false, motivo: 'O recurso de transcrição não está disponível agora.' };
    const st = await manager.getStatus();
    const w = (st && st.whisper) || {};
    const active = (w.models || []).find((m) => m.active) || null;
    const busy = st && st.busy ? st.busy : null;
    return {
      suportado_neste_computador: w.engine ? w.engine.available !== false : false,
      instalado: Boolean(w.engine && w.engine.installed),
      pronto_para_transcrever: Boolean(w.ready),
      modelo_ativo: active ? safeText(active.label, 40) : null,
      aceleracao_por_placa_de_video: Boolean(w.cuda && w.cuda.installed),
      transcricao_em_andamento: Boolean(busy && busy.kind === 'transcribe'),
      outra_operacao_em_andamento: Boolean(busy && busy.kind !== 'transcribe'),
      observacao: w.ready ? undefined : 'Para transcrever é preciso instalar o recurso e escolher um modelo em Configurações → Transcrição. O assistente não instala nada sozinho.'
    };
  }
};

module.exports = { readTools: [library_search, media_get, projects_list, project_get, transcription_status], MAX_SEARCH, MAX_PROJECT_MEDIA, READY_SQL, TYPE_TO_DB };
