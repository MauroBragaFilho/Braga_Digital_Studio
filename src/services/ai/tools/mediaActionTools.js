'use strict';

/**
 * Ações de MÍDIA do assistente, todas com confirmação NATIVA no processo principal (ver index.js → ToolBox.execute):
 * add_download, convert_media e remove_silence. Reaproveitam os serviços que as telas já usam (fila de Downloads,
 * fila do Conversor, Remover Silêncio): nenhuma regra de download/conversão/corte é duplicada aqui.
 *
 * Regras comuns:
 *  - o modelo só informa url (http/https), ids numéricos e valores de LISTAS FIXAS; nunca um caminho. Pastas de
 *    destino vêm das Configurações do usuário (as mesmas das telas) e aparecem no diálogo de confirmação;
 *  - prepare() não escreve nada: valida e monta o texto EXATO do diálogo; run() só roda depois do "Confirmar";
 *  - tarefa longa: linhas de status discretas (ctx.onStatus) e resumo curto ao fim; o botão de parar do chat
 *    (ctx.signal) cancela o que for cancelável SEM deixar saída parcial.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ToolError, resolveMediaList, listNames, plural, requireModule, requireService } = require('./common');
const { safeText } = require('./results');
const { parseHttpUrl, redactUrl } = require('../../urlValidator');

const MAX_BATCH = 20;
const POLL_MS = 700;

const idList = (what, max) => ({ type: 'array', minItems: 1, maxItems: max, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 }, description: `IDs numéricos ${what} (de library_search ou do contexto da tela), de 1 a ${max}.` });
const cancelled = () => Object.assign(new Error('Cancelado.'), { code: 'CANCELLED' });

/** Espera `isDone()` ficando verdadeiro, avisando o progresso; rejeita com CANCELLED quando o sinal aborta. */
function pollUntil(isDone, { signal = null, tick = () => {}, intervalMs = POLL_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const end = (fn) => { clearInterval(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => end(() => reject(cancelled()));
    const check = () => { try { if (isDone()) end(resolve); else tick(); } catch (err) { end(() => reject(err)); } };
    if (signal) { if (signal.aborted) { reject(cancelled()); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    timer = setInterval(check, intervalMs);
    check();
  });
}

// ============================================================================ add_download

const DL_QUALITIES = {
  melhor: { label: 'a melhor disponível', value: 'best', kinds: ['video', 'audio'] },
  '1080p': { label: '1080p', value: '1080p', kinds: ['video'] },
  '720p': { label: '720p', value: '720p', kinds: ['video'] },
  '480p': { label: '480p', value: '480p', kinds: ['video'] },
  '320kbps': { label: '320 kbps', value: '320kbps', kinds: ['audio'] },
  '192kbps': { label: '192 kbps', value: '192kbps', kinds: ['audio'] },
  '128kbps': { label: '128 kbps', value: '128kbps', kinds: ['audio'] }
};
const PARTIAL_NAME = /\.(part|ytdl|temp)$|\.f\d+\.[a-z0-9]+$|\.part-frag\d+$/i;

const listFolder = (dir) => { try { return new Set(fs.readdirSync(dir)); } catch (_) { return new Set(); } };

/**
 * Apaga SÓ o que este download criou ou reescreveu e ficou pela metade (arquivo com cara de parcial que é NOVO ou que
 * foi modificado depois de `since`; um parcial antigo que ninguém tocou não é mexido) ao ser parado. No Windows o arquivo pode continuar travado por alguns instantes depois que o processo morre: tenta de novo até
 * ficar livre (até ~3 s). Devolve quantos parciais ainda não puderam ser apagados.
 */
async function removeNewPartials(dir, before, { since = Date.now(), tries = 15, delayMs = 200 } = {}) {
  let left = 0;
  for (let i = 0; i < tries; i++) {
    left = 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return 0; } // pasta inexistente: nada a limpar
    for (const name of names) {
      if (!PARTIAL_NAME.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile()) continue;
        if (before.has(name) && st.mtimeMs < since) continue; // já existia e este download não mexeu nele
        fs.unlinkSync(file);
      } catch (_) { left += 1; }
    }
    if (!left) return 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return left;
}

const add_download = {
  name: 'add_download',
  kind: 'action',
  description: 'Baixa um vídeo (MP4) ou uma música (MP3) de um link http/https e salva na pasta de downloads do usuário. O app mostra o link completo e o destino e pede confirmação antes de começar.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'formato'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 2000, description: 'Link http ou https completo.' },
      formato: { type: 'string', enum: ['video', 'audio'], description: 'video = MP4; audio = MP3.' },
      qualidade: { type: 'string', enum: Object.keys(DL_QUALITIES), default: 'melhor', description: 'Vídeo: melhor, 1080p, 720p ou 480p. Áudio: melhor, 320kbps, 192kbps ou 128kbps.' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    const downloads = requireService(ctx, 'downloads', 'Downloads');
    const parsed = parseHttpUrl(args.url);
    if (!parsed) throw new ToolError('O link precisa ser um endereço http ou https válido, sem usuário nem senha.', 'BAD_ARGS');
    const quality = DL_QUALITIES[args.qualidade || 'melhor'];
    if (!quality.kinds.includes(args.formato)) {
      throw new ToolError(`A qualidade "${args.qualidade}" não existe para ${args.formato === 'audio' ? 'áudio (use melhor, 320kbps, 192kbps ou 128kbps)' : 'vídeo (use melhor, 1080p, 720p ou 480p)'}.`, 'BAD_ARGS');
    }
    const settings = ctx.settings && typeof ctx.settings.load === 'function' ? ctx.settings.load() : {};
    const isAudio = args.formato === 'audio';
    const folder = String((isAudio ? settings.mp3Folder : settings.mp4Folder) || '');
    if (!folder) throw new ToolError('A pasta de destino dos downloads não está configurada.', 'NO_FOLDER');
    const waiting = (downloads.getQueue() || []).filter((i) => i.status === 'queued' || i.status === 'downloading').length;
    const url = parsed.toString();
    const parts = [
      `Link:\n${url}`,
      `Formato: ${isAudio ? 'áudio (MP3)' : 'vídeo (MP4)'}\nQualidade: ${quality.label}`,
      `Destino: ${folder}`
    ];
    if (waiting) parts.push(`Já há ${plural(waiting, 'item', 'itens')} na fila de Downloads; ${waiting === 1 ? 'ele também será iniciado' : 'eles também serão iniciados'}.`);
    parts.push('O arquivo entra na fila de Downloads e, ao terminar, na Biblioteca. Nada é apagado.');
    return {
      message: `O assistente quer baixar ${isAudio ? 'uma música (MP3)' : 'um vídeo (MP4)'}.`,
      detail: parts.join('\n\n'),
      plan: { url, format: isAudio ? 'MP3' : 'MP4', quality: quality.value, folder },
      auditSummary: `${isAudio ? 'áudio' : 'vídeo'} de ${redactUrl(url)}`
    };
  },
  async run(plan, ctx) {
    const downloads = requireService(ctx, 'downloads', 'Downloads');
    const before = listFolder(plan.folder);
    const startedAt = Date.now() - 2000;
    let item = null;
    try {
      item = downloads.add({ url: plan.url, format: plan.format, quality: plan.quality });
      ctx.onStatus('Iniciando o download…', 'progress');
      await downloads.start();
      await pollUntil(() => !downloads.getQueue().includes(item) || ['completed', 'failed', 'cancelled'].includes(item.status), {
        signal: ctx.signal,
        tick: () => {
          if (item.status === 'downloading') ctx.onStatus(`Baixando… ${Math.round(Number(item.progress) || 0)}%`, 'progress');
          else if (item.status === 'queued') ctx.onStatus('Na fila de downloads…', 'progress');
          else if (item.status === 'paused') ctx.onStatus('Download pausado na tela Downloads…', 'progress');
        }
      });
    } catch (err) {
      if (item && err && err.code === 'CANCELLED') {
        // Parou pelo chat: cancela, tira da fila e limpa o que ficou pela metade (só o que este download criou)
        try { await downloads.cancel(item.id); } catch (_) { /* já parado */ }
        try { downloads.remove(item.id); } catch (_) { /* já removido */ }
        await removeNewPartials(plan.folder, before, { since: startedAt });
        throw cancelled();
      }
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Não foi possível iniciar o download: ${safeText(err && err.message, 140)}`, 'DOWNLOAD_FAILED');
    }
    if (item.status === 'completed') {
      const file = item.outputPath ? path.basename(item.outputPath) : '';
      return { situacao: 'concluído', arquivo: safeText(file || item.title, 100), formato: plan.format === 'MP3' ? 'áudio (MP3)' : 'vídeo (MP4)', observacao: item.error ? safeText(item.error, 100) : undefined };
    }
    if (item.status === 'failed') return { situacao: 'falhou', motivo: safeText(item.error, 160) };
    return { situacao: 'cancelado', observacao: 'O download foi cancelado ou removido pela tela Downloads.' };
  }
};

// ============================================================================ convert_media

const VIDEO_PRESETS = {
  original: { label: 'Original (mantém a resolução)', resolution: null, bitrate: '10M' },
  '1080p': { label: 'Full HD (1080p)', resolution: 1080, bitrate: '8M' },
  '2160p': { label: '4K (2160p)', resolution: 2160, bitrate: '35M' },
  '1440p': { label: '2K (1440p)', resolution: 1440, bitrate: '16M' },
  '720p': { label: 'HD (720p)', resolution: 720, bitrate: '5M' },
  '480p': { label: 'SD (480p)', resolution: 480, bitrate: '2500k' }
};
const AUDIO_PRESETS = {
  '128k': { label: '128 kbps', bitrate: '128k' },
  '192k': { label: '192 kbps', bitrate: '192k' },
  '256k': { label: '256 kbps', bitrate: '256k' },
  '320k': { label: '320 kbps', bitrate: '320k' }
};

/** Predefinição padrão = o que o usuário escolheu em Configurações > Conversor. */
function defaultPresetKey(settings, isMp3) {
  if (isMp3) {
    const k = String(settings.converterDefaultAudioBitrate || '192k');
    return AUDIO_PRESETS[k] ? k : '192k';
  }
  const r = String(settings.converterDefaultResolution || 'original');
  const k = r === 'original' ? 'original' : `${r}p`;
  return VIDEO_PRESETS[k] ? k : 'original';
}
function userVideoBitrate(settings) {
  const n = Number(settings.converterDefaultVideoBitrate);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : 10;
}
function userVideoCodec(settings) {
  return settings.converterDefaultCodec === 'libx265' ? 'libx265' : 'libx264';
}

const convert_media = {
  name: 'convert_media',
  kind: 'action',
  description: `Converte mídias da Biblioteca para MP4 (vídeo) ou MP3 (áudio), até ${MAX_BATCH} por pedido, usando a fila do Conversor. Os arquivos novos vão para a pasta do Conversor; os originais não são alterados. O app pede confirmação antes de começar.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ids', 'formato'],
    properties: {
      ids: idList('das mídias', MAX_BATCH),
      formato: { type: 'string', enum: ['mp4', 'mp3'], description: 'mp4 = vídeo; mp3 = só o áudio.' },
      predefinicao: { type: 'string', enum: [...Object.keys(VIDEO_PRESETS), ...Object.keys(AUDIO_PRESETS)], description: 'mp4: original, 2160p, 1440p, 1080p, 720p ou 480p. mp3: 128k, 192k, 256k ou 320k. Se não informar, vale o padrão que o usuário escolheu em Configurações > Conversor.' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    const converter = requireService(ctx, 'converter', 'Conversor');
    if (converter.isRunning && converter.isRunning()) throw new ToolError('O Conversor já está convertendo outros arquivos. Tente de novo quando terminar.', 'BUSY');
    const isMp3 = args.formato === 'mp3';
    const settings = ctx.settings && typeof ctx.settings.load === 'function' ? ctx.settings.load() : {};
    const presetKey = args.predefinicao || defaultPresetKey(settings, isMp3);
    const basePreset = isMp3 ? AUDIO_PRESETS[presetKey] : VIDEO_PRESETS[presetKey];
    if (!basePreset) throw new ToolError(`A predefinição "${presetKey}" não existe para ${isMp3 ? 'mp3 (use 128k, 192k, 256k ou 320k)' : 'mp4 (use original, 2160p, 1440p, 1080p, 720p ou 480p)'}.`, 'BAD_ARGS');
    // "Original" mantém a qualidade que o usuário definiu nas configurações do Conversor
    const preset = !isMp3 && presetKey === 'original' ? { ...basePreset, bitrate: `${userVideoBitrate(settings)}M` } : basePreset;
    const videoCodec = userVideoCodec(settings);
    const items = resolveMediaList(ctx.getDb(), args.ids, { types: isMp3 ? ['video', 'audio'] : ['video'] });
    const outFolder = String(settings.converterFolder || '');
    if (!outFolder) throw new ToolError('A pasta de destino do Conversor não está configurada.', 'NO_FOLDER');
    const names = items.map((i) => safeText(i.row.filename, 80));
    const pending = (converter.getQueue() || []).filter((q) => q.status !== 'Concluído').length;
    const parts = [
      `Mídias (${items.length}):\n${listNames(names)}`,
      `Formato: ${isMp3 ? 'MP3 (só o áudio)' : 'MP4 (vídeo)'}\nPredefinição: ${preset.label}${args.predefinicao ? '' : ' (seu padrão do Conversor)'}${isMp3 ? '' : `\nCodec: ${videoCodec === 'libx265' ? 'H.265' : 'H.264'}`}`,
      `Destino: ${outFolder}`
    ];
    if (pending) parts.push(`Já há ${plural(pending, 'arquivo', 'arquivos')} esperando na fila do Conversor; ${pending === 1 ? 'ele também será convertido' : 'eles também serão convertidos'}.`);
    parts.push('Os originais não são alterados nem apagados. Os arquivos novos nunca substituem outros.');
    return {
      message: `O assistente quer converter ${plural(items.length, 'mídia', 'mídias')} para ${isMp3 ? 'MP3' : 'MP4'}.`,
      detail: parts.join('\n\n'),
      plan: {
        ids: items.map((i) => i.row.id),
        files: items.map((i) => ({ path: i.filepath, duration: i.row.duration })),
        isMp3,
        preset,
        videoCodec,
        outFolder
      },
      auditSummary: `${items.length} mídia(s) para ${isMp3 ? 'mp3' : 'mp4'}`
    };
  },
  async run(plan, ctx) {
    const converter = requireService(ctx, 'converter', 'Conversor');
    const added = converter.addFiles(plan.files);
    const mine = Array.isArray(added && added.items) ? added.items : [];
    const dropQueued = () => { for (const it of mine) { try { if (it.status !== 'Concluído') converter.removeFile(String(it.id)); } catch (_) { /* em uso: fica na fila */ } } };
    if (mine.length !== plan.files.length) {
      dropQueued();
      throw new ToolError('Algum arquivo não é aceito pelo Conversor (formato não suportado ou arquivo ausente). Nada foi convertido.', 'BAD_MEDIA');
    }
    const config = {
      format: plan.isMp3 ? 'mp3' : 'mp4',
      videoCodec: plan.videoCodec || 'libx264',
      videoResolution: plan.isMp3 ? null : plan.preset.resolution,
      videoBitrate: plan.isMp3 ? null : plan.preset.bitrate,
      preset: 'medium',
      audioCodec: plan.isMp3 ? 'libmp3lame' : 'aac',
      audioBitrate: plan.isMp3 ? plan.preset.bitrate : '192k',
      outFolder: plan.outFolder
    };
    const onAbort = () => { Promise.resolve(converter.cancelCurrent()).catch(() => {}); };
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setInterval(() => {
      const cur = mine.find((it) => it.status === 'Convertendo');
      const done = mine.filter((it) => it.status === 'Concluído').length;
      if (cur) ctx.onStatus(`Convertendo ${Math.min(done + 1, mine.length)}/${mine.length}… ${Math.round(Number(cur.progress) || 0)}%`, 'progress');
    }, POLL_MS);
    try {
      ctx.onStatus(`Convertendo 1/${mine.length}…`, 'progress');
      await converter.start(config);
    } catch (err) {
      dropQueued();
      if (ctx.signal && ctx.signal.aborted) throw cancelled();
      throw new ToolError(`A conversão não pôde começar: ${safeText(err && err.message, 140)}`, 'CONVERT_FAILED');
    } finally {
      clearInterval(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
    const ok = mine.filter((it) => it.status === 'Concluído');
    const failed = mine.filter((it) => it.status === 'Erro');
    if (ctx.signal && ctx.signal.aborted) { dropQueued(); throw cancelled(); }
    dropQueued();
    return {
      convertidas: ok.length,
      com_erro: failed.length,
      canceladas: mine.length - ok.length - failed.length,
      arquivos_gerados: ok.slice(0, 10).map((it) => safeText(path.basename(String(it.output || '')), 100)),
      erros: failed.slice(0, 3).map((it) => safeText(it.error, 120))
    };
  }
};

// ============================================================================ remove_silence

const SILENCE_MODES = {
  remover: { value: 'remove', label: 'remover o silêncio por completo' },
  reduzir_05: { value: 'reduce05', label: 'reduzir cada silêncio para 0,5 s' },
  reduzir_10: { value: 'reduce10', label: 'reduzir cada silêncio para 1,0 s' }
};
const SILENCE_THRESHOLD_DB = -30;   // mesmos padrões da tela Remover Silêncio
const SILENCE_MIN_SECONDS = 0.5;

const remove_silence = {
  name: 'remove_silence',
  kind: 'action',
  description: `Remove ou encurta os trechos de silêncio de vídeos e áudios da Biblioteca, até ${MAX_BATCH} por pedido. Cria arquivos novos na pasta de Remover Silêncio; os originais não são alterados. O app pede confirmação antes de começar.`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['ids'],
    properties: {
      ids: idList('das mídias', MAX_BATCH),
      modo: { type: 'string', enum: Object.keys(SILENCE_MODES), default: 'remover', description: 'remover = tira o silêncio; reduzir_05 / reduzir_10 = deixa 0,5 s / 1 s.' },
      sensibilidade_db: { type: 'integer', minimum: -60, maximum: -10, default: SILENCE_THRESHOLD_DB, description: 'Abaixo de quantos dB conta como silêncio (padrão -30; mais perto de -10 corta mais, mais perto de -60 corta só o silêncio absoluto).' },
      duracao_minima_ms: { type: 'integer', minimum: 200, maximum: 5000, default: SILENCE_MIN_SECONDS * 1000, description: 'Duração mínima do silêncio, em milissegundos (padrão 500).' }
    }
  },
  status: () => 'Aguardando sua confirmação…',
  prepare(args, ctx) {
    requireModule(ctx, 'silence', 'Remover Silêncio');
    const silence = requireService(ctx, 'silence', 'Remover Silêncio');
    if (silence.running) throw new ToolError('Já existe uma remoção de silêncio em andamento. Tente de novo quando terminar.', 'BUSY');
    const mode = SILENCE_MODES[args.modo || 'remover'];
    const threshold = Number.isInteger(args.sensibilidade_db) ? args.sensibilidade_db : SILENCE_THRESHOLD_DB;
    const minDuration = (Number.isInteger(args.duracao_minima_ms) ? args.duracao_minima_ms : SILENCE_MIN_SECONDS * 1000) / 1000;
    const items = resolveMediaList(ctx.getDb(), args.ids, { types: ['video', 'audio'] });
    const videos = ctx.paths && ctx.paths.videosDir;
    if (!videos) throw new ToolError('A pasta de destino não está disponível.', 'NO_FOLDER');
    const outFolder = path.join(videos, 'RemoverSilencio');
    const names = items.map((i) => safeText(i.row.filename, 80));
    return {
      message: `O assistente quer ${mode.label} de ${plural(items.length, 'mídia', 'mídias')}.`,
      detail: [
        `Mídias (${items.length}):\n${listNames(names)}`,
        `Modo: ${mode.label}\nSensibilidade: ${threshold} dB; silêncios a partir de ${String(minDuration).replace('.', ',')} s.`,
        `Destino: ${outFolder}`,
        'Os originais não são alterados nem apagados. Os arquivos novos nunca substituem outros.'
      ].join('\n\n'),
      plan: { files: items.map((i) => i.filepath), mode: mode.value, threshold, minDuration, outFolder },
      auditSummary: `${items.length} mídia(s), modo ${mode.value}`
    };
  },
  async run(plan, ctx) {
    const silence = requireService(ctx, 'silence', 'Remover Silêncio');
    let finished = null;
    const onFinished = (payload) => { finished = payload; };
    const onProgress = (p) => {
      if (!p || !p.total) return;
      const pct = Number.isFinite(p.percent) && p.percent > 0 ? ` ${Math.round(p.percent)}%` : '';
      ctx.onStatus(`Removendo silêncio ${Math.min(p.index, p.total)}/${p.total}…${pct}`, 'progress');
    };
    const onAbort = () => { Promise.resolve(silence.cancel()).catch(() => {}); };
    silence.on('finished', onFinished);
    silence.on('progress', onProgress);
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      ctx.onStatus(`Removendo silêncio 1/${plan.files.length}…`, 'progress');
      await silence.processQueue({ files: plan.files, mode: plan.mode, threshold: plan.threshold, minDuration: plan.minDuration, outFolder: plan.outFolder });
    } catch (err) {
      if (ctx.signal && ctx.signal.aborted) throw cancelled();
      throw new ToolError(`A remoção de silêncio não pôde começar: ${safeText(err && err.message, 140)}`, 'SILENCE_FAILED');
    } finally {
      silence.off('finished', onFinished);
      silence.off('progress', onProgress);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
    if (ctx.signal && ctx.signal.aborted) throw cancelled();
    const f = finished || {};
    if (f.status === 'canceled') throw cancelled();
    if (f.status === 'error') return { situacao: 'falhou', motivo: safeText(f.error, 160) };
    return {
      situacao: f.status === 'partial' ? 'concluído com avisos' : 'concluído',
      arquivos_novos: (f.processedCount || 0) + (f.copiedCount || 0),
      sem_silencio_copiados: f.copiedCount || 0,
      ignorados: (f.skipped || []).length,
      com_erro: (f.failed || []).length,
      motivos: [...(f.skipped || []).map((s) => s.reason), ...(f.failed || []).map((x) => x.error)].slice(0, 3).map((t) => safeText(t, 120))
    };
  }
};

module.exports = {
  mediaActionTools: [add_download, convert_media, remove_silence],
  MAX_BATCH, DL_QUALITIES, VIDEO_PRESETS, AUDIO_PRESETS, SILENCE_MODES, pollUntil, removeNewPartials
};
