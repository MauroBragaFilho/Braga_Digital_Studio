'use strict';

/**
 * COMANDOS DIRETOS do assistente: pedidos simples e previsíveis ("baixa este link", "transcreve o selecionado",
 * "converte para mp3", "tira o silêncio", "como estão os downloads?") são entendidos por REGRAS, sem consultar nenhum
 * modelo de IA. Vantagens: instantâneo, funciona offline e sem servidor configurado, não gasta cota e não erra a
 * interpretação. O que as regras não entendem (match = null) segue para o modelo de IA, como sempre.
 *
 * SEGURANÇA: as regras só montam a chamada de UMA ferramenta da lista fixa (tools/index.js) e a executam pelo mesmo
 * ToolBox: os argumentos passam pelo mesmo esquema estrito e toda ação continua pedindo a confirmação do app.
 * Os ids vêm do banco (busca por nome) ou do contexto da tela, nunca do texto digitado. O texto de resposta é fixo.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const MAX_IDS = 5;

/** Minúsculas e sem acentos, para as regras. */
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const RE = {
  download: /\b(baix\w*|download\w*|salv\w*|pega\w*)\b/,
  transcribe: /\b(transcrev\w*|transcrever|transcricao|transcricoes|legend\w*)\b/,
  convert: /\b(convert\w*|transform\w*)\b/,
  silence: /\bsilenc\w*/,
  status: /\b(status|andamento|como (esta|estao|anda|andam)|em que pe)\b/,
  downloadsWord: /\b(downloads?|baixand\w*|fila)\b/,
  selection: /\b(selecionad\w*|disso|desse|deste|nisso|dele|dela|isto|isso|esse|essa|este|esta|aquele|aquela|estes|esses)\b/,
  audio: /\b(mp3|audio|musica|som)\b/,
  mp4: /\b(mp4|video)\b/
};

/** Pedido de transcrição junto de um link: o app só transcreve o que já está na Biblioteca. */
const wantsTranscription = (f) => RE.transcribe.test(f);

/**
 * Entende `text` e devolve o plano, ou null (deixa para a IA).
 * @param {string} text
 * @returns {null | { intent:'download'|'transcribe'|'convert'|'silence'|'status', url?:string, format?:string,
 *                    quality?:string, mp3?:boolean, preset?:string, mode?:string, query?:string, usesSelection:boolean, alsoTranscribe?:boolean }}
 */
function matchCommand(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 600) return null;
  const f = fold(raw);

  // 1) Link: só link, ou link com verbo de baixar (um link com outra pergunta vai para a IA)
  const url = URL_RE.exec(raw);
  if (url) {
    const rest = f.replace(fold(url[0]), ' ').replace(/[\s.,;:!?()[\]-]+/g, ' ').trim();
    const onlyLink = rest === '';
    const talksDownload = RE.download.test(rest);
    if (!onlyLink && !talksDownload) return null;
    const audio = RE.audio.test(rest);
    let quality = 'melhor';
    if (audio) {
      const k = /\b(320|192|128)\s?k/.exec(rest);
      if (k) quality = `${k[1]}kbps`;
    } else {
      const q = /\b(1080|720|480)\s?p?\b/.exec(rest);
      if (q) quality = `${q[1]}p`;
    }
    return { intent: 'download', url: url[0].replace(/[.,;:!?)]+$/, ''), format: audio ? 'audio' : 'video', quality, usesSelection: false, alsoTranscribe: wantsTranscription(rest) };
  }

  // 2) Status dos downloads
  if (RE.downloadsWord.test(f) && RE.status.test(f) && !RE.transcribe.test(f) && !RE.convert.test(f)) {
    return { intent: 'status', usesSelection: false };
  }

  // 3) Transcrever
  if (RE.transcribe.test(f) && !RE.convert.test(f) && !RE.silence.test(f)) {
    return { intent: 'transcribe', ...target(f, /\b(transcrev\w*|transcrever|transcricao|transcricoes|legend\w*)\b/) };
  }

  // 4) Converter
  if (RE.convert.test(f) && (RE.audio.test(f) || RE.mp4.test(f)) && !RE.silence.test(f)) {
    const mp3 = RE.audio.test(f) && !/\bmp4\b/.test(f);
    let preset = null;
    if (mp3) { const k = /\b(128|192|256|320)\s?k/.exec(f); if (k) preset = `${k[1]}k`; } else { const q = /\b(2160|1440|1080|720|480)\s?p\b/.exec(f); if (q) preset = `${q[1]}p`; }
    return { intent: 'convert', mp3, preset, ...target(f, /\b(convert\w*|transform\w*)\b/) };
  }

  // 5) Tirar silêncio
  if (RE.silence.test(f) && /\b(tir\w*|remov\w*|cort\w*|apag\w*|reduz\w*|diminu\w*|encurt\w*|limp\w*)\b/.test(f)) {
    let mode = 'remover';
    if (/\breduz\w*|\bdiminu\w*|\bencurt\w*/.test(f)) mode = /\b(1 ?s|1 segundo|um segundo)\b/.test(f) ? 'reduzir_10' : 'reduzir_05';
    return { intent: 'silence', mode, ...target(f, /\bsilenc\w*/) };
  }
  return null;
}

/** Alvo do pedido: a seleção atual (se disser "isto", "o selecionado") ou um nome de arquivo depois do verbo. */
function target(f, verbRe) {
  const m = verbRe.exec(f);
  const after = m ? f.slice(m.index + m[0].length) : f;
  // Palavras de ligação só saem das PONTAS ("o", "para"...): no meio fazem parte do nome ("fim da rua")
  const STOP = new Set(['para', 'pra', 'em', 'a', 'o', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'arquivo', 'midia', 'video', 'videos', 'audio', 'silencio', 'por', 'favor', 'pf', 'pfv', 'aqui', 'ai', 'agora', 'tudo', 'tira', 'tirar', 'remove', 'remover', 'corta', 'cortar', 'ao', 'ate', 'com', 'e', 'mp3', 'mp4']);
  const hadSelection = RE.selection.test(after);
  const tokens = after
    .replace(new RegExp(RE.selection.source, 'g'), ' ')
    .replace(/\d{3,4} ?[pk]/g, ' ')
    .replace(/[^a-z0-9 ._-]+/g, ' ')
    .split(/\s+/).filter(Boolean);
  while (tokens.length && STOP.has(tokens[0])) tokens.shift();
  while (tokens.length && STOP.has(tokens[tokens.length - 1])) tokens.pop();
  const query = tokens.join(' ');
  const usesSelection = hadSelection || query === '';
  return { usesSelection: usesSelection && query === '', query: query.slice(0, 100) };
}

// ---------------------------------------------------------------------------------------------- execução

const parse = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Texto curto para o resultado de uma ação (o JSON vem do ToolBox: sem caminhos). */
function describeResult(json, doneText) {
  if (!json) return 'Não consegui concluir agora.';
  if (json.erro) return `Não deu para fazer isso: ${json.erro}`;
  if (typeof json.resultado === 'string' && /recusou/i.test(json.resultado)) return 'Tudo bem, não fiz nada.';
  if (json.situacao === 'falhou') return `Não deu certo${json.motivo ? `: ${json.motivo}` : '.'}`;
  if (json.situacao === 'concluído com avisos') return `${doneText} (com avisos).`;
  return doneText;
}

/**
 * Tenta atender `text` por regras. Devolve o texto da resposta, ou null se não for um comando (o chat segue para a IA).
 * @param {{ text:string, context:{selectedIds:number[]}|null, toolbox:object, signal?:AbortSignal, onStatus?:Function }} p
 * @returns {Promise<string|null>}
 */
async function runCommand({ text, context, toolbox, signal = null, onStatus = () => {} }) {
  const cmd = matchCommand(text);
  if (!cmd || !toolbox) return null;
  const exec = async (name, args) => parse(await toolbox.execute(name, args, { signal, onStatus }));

  if (cmd.intent === 'status') {
    const r = await exec('downloads_status', {});
    if (!r || r.erro) return describeResult(r, '');
    const parts = [];
    if (r.baixando) parts.push(`${plural(r.baixando, 'baixando', 'baixando')}`);
    if (r.na_fila) parts.push(`${r.na_fila} na fila`);
    if (r.pausados) parts.push(`${plural(r.pausados, 'pausado', 'pausados')}`);
    if (r.concluidos) parts.push(`${plural(r.concluidos, 'concluído', 'concluídos')}`);
    if (r.com_erro) parts.push(`${plural(r.com_erro, 'com erro', 'com erro')}`);
    return parts.length ? `Downloads: ${parts.join(', ')}.` : 'Nenhum download por enquanto.';
  }

  if (cmd.intent === 'download') {
    const r = await exec('add_download', { url: cmd.url, formato: cmd.format, qualidade: cmd.quality });
    const done = describeResult(r, `Pronto, baixei ${cmd.format === 'audio' ? 'o áudio (MP3)' : 'o vídeo (MP4)'}.`);
    return cmd.alsoTranscribe && r && !r.erro && !/não fiz nada/.test(done)
      ? `${done} Para transcrever, peça "transcreve" e o nome do vídeo quando ele aparecer na Biblioteca.`
      : done;
  }

  // Comandos sobre mídias: descobre os ids
  let ids = [];
  if (cmd.usesSelection) {
    ids = (context && context.selectedIds ? context.selectedIds : []).slice(0, MAX_IDS);
    if (!ids.length) return 'Selecione a mídia na Biblioteca ou me diga o nome do arquivo.';
  } else {
    const r = await exec('library_search', { texto: cmd.query, limite: 6 });
    const items = r && Array.isArray(r.midias) ? r.midias.filter((m) => m.tipo === 'video' || m.tipo === 'audio') : [];
    if (!items.length) return `Não achei nenhuma mídia com "${cmd.query}" na Biblioteca.`;
    if (items.length > 1) {
      const exact = items.filter((m) => fold(m.nome).includes(cmd.query));
      if (exact.length !== 1) return `Achei ${items.length} mídias parecidas: ${items.slice(0, 4).map((m) => `"${m.nome}"`).join(', ')}${items.length > 4 ? '…' : ''}. Diga o nome completo ou selecione uma na Biblioteca.`;
      ids = [exact[0].id];
    } else {
      ids = [items[0].id];
    }
  }

  const many = (n, one, plr) => (n === 1 ? one : plr);
  if (cmd.intent === 'transcribe') {
    const r = await exec('transcribe_media', { ids });
    return describeResult(r, `Pronto, ${many(ids.length, 'transcrevi a mídia', `transcrevi as ${ids.length} mídias`)}. Peça "lê a transcrição" para ver o texto.`);
  }
  if (cmd.intent === 'convert') {
    const r = await exec('convert_media', { ids, formato: cmd.mp3 ? 'mp3' : 'mp4', ...(cmd.preset ? { predefinicao: cmd.preset } : {}) });
    return describeResult(r, `Pronto, ${many(ids.length, 'converti a mídia', `converti as ${ids.length} mídias`)} para ${cmd.mp3 ? 'MP3' : 'MP4'}.`);
  }
  if (cmd.intent === 'silence') {
    const r = await exec('remove_silence', { ids, modo: cmd.mode });
    return describeResult(r, `Pronto, ${many(ids.length, 'tirei o silêncio da mídia', `tirei o silêncio de ${ids.length} mídias`)}.`);
  }
  return null;
}

module.exports = { matchCommand, runCommand, describeResult, fold };
