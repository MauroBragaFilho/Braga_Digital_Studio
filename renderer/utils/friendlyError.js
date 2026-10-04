/**
 * Mensagens de erro para o usuário leigo: remove nomes de motores internos e traduz as falhas
 * mais comuns para frases humanas com a próxima ação. Só para TEXTO DE EXIBIÇÃO (logs ficam crus).
 */
import { maskEngineNames } from './engineNames.js';

// Nomes que o mascaramento padrão não cobre.
const EXTRA_RULES = [
  [/faster[-_ ]?whisper|whisper(?:\.cpp)?|ggml[-\w.]*/gi, 'motor de transcrição'],
  [/exiftool/gi, 'leitor de metadados'],
  [/libraw|rawpy/gi, 'leitor de fotos RAW'],
  [/sql\.?js|sqlite3?/gi, 'banco de dados do app'],
  [/cublas\w*|cuda\w*/gi, 'aceleração NVIDIA'],
  [/spotify/gi, 'música'],
  [/direct stream copy|stream copy/gi, 'cópia sem recompressão'],
  [/\b(?:electron|chromium)\b/gi, 'aplicativo'],
  [/Error invoking remote method '[^']+':\s*(?:Error:\s*)?/gi, ''],
  [/^\s*(?:Error|TypeError|RangeError):\s*/i, ''],
];

// [padrão, frase humana]. A primeira que casar vence.
const FRIENDLY_RULES = [
  [/ENOSPC|no space left|espa[cç]o insuficiente|disk full/i, 'Não há espaço livre suficiente no disco. Libere espaço ou escolha outra pasta de destino e tente de novo.'],
  [/EBUSY|EPERM|EACCES|being used by another process|resource busy|em uso|permission denied|acesso negado/i, 'O arquivo está em uso por outro programa ou sem permissão de acesso. Feche o programa que o usa (ou escolha outra pasta) e tente de novo.'],
  [/ENOENT|no such file|n[aã]o encontrado|not found.*(?:file|arquivo)|arquivo.*n[aã]o (?:existe|encontrado)/i, 'Não encontrei o arquivo. Ele pode ter sido movido, renomeado ou apagado. Adicione-o de novo.'],
  [/moov atom|invalid data found|corrupt|corromp|truncated|end of file|could not find codec|error while decoding|invalid argument.*input/i, 'O arquivo parece corrompido ou incompleto e não pôde ser lido. Tente outro arquivo ou uma cópia dele.'],
  [/erro ao ler (?:os |o |a )?(?:metadados|arquivo)|could not read|cannot read/i, 'Não foi possível ler este arquivo. Ele pode estar corrompido, incompleto ou em um formato incompatível. Tente outro arquivo.'],
  [/unsupported|n[aã]o suportado|unknown format|no suitable|unable to find a suitable|formato.*inv[aá]lido|does not contain any stream/i, 'Este formato de arquivo não é compatível. Tente converter o arquivo para MP4 ou MP3 antes.'],
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo|unable to download|timed out|sem internet|sem conex/i, 'Sem conexão com a internet (ou o servidor não respondeu). Verifique sua rede e tente novamente.'],
  [/unsupported url|is not a valid url|url inv[aá]lida|no video formats|unable to extract|n[aã]o foi poss[ií]vel (?:extrair|analisar) o link/i, 'Este link não parece ser de um vídeo ou música que eu consiga baixar. Confira o endereço e tente de novo.'],
  [/private video|sign in|login required|confirm you.re not a bot|members-only|cookies/i, 'Este conteúdo exige login. Entre na sua conta pela aba Envio e tente novamente.'],
  [/video unavailable|v[ií]deo indispon[ií]vel|has been removed|geo.?restrict|not available in your country/i, 'Este vídeo não está disponível (foi removido, é privado ou bloqueado na sua região).'],
  [/m[oó]dulo.*(?:n[aã]o instalado|desligado|desativado)|not installed|engine.*missing|n[aã]o (?:est[aá] )?instalad/i, 'Este recurso ainda não está instalado ou está desligado. Ative-o em Configurações → Módulos.'],
  [/cancel/i, 'Operação cancelada.'],
];

/** Só tira nomes de motores e prefixos técnicos. */
export function cleanText(text) {
  if (typeof text !== 'string') return text == null ? '' : String(text);
  let out = maskEngineNames(text);
  for (const [re, rep] of EXTRA_RULES) out = out.replace(re, rep);
  return out.trim();
}

/**
 * Traduz um erro (Error, string ou objeto com message) para uma frase humana.
 * Se nada casar, devolve o texto limpo (sem nomes de motores) e curto.
 */
export function friendlyError(err, fallback = 'Algo deu errado. Tente novamente.') {
  const raw = typeof err === 'string' ? err : (err && (err.message || err.error)) || '';
  const text = String(raw || '').trim();
  if (!text) return fallback;
  const batch = text.match(/^(Nenhum arquivo foi processado)[.:]\s*(.+)$/is);
  if (batch) return `${batch[1]}. ${friendlyError(batch[2], '')}`.trim();
  for (const [re, human] of FRIENDLY_RULES) {
    if (re.test(text)) return human;
  }
  const clean = cleanText(text).replace(/\s+/g, ' ');
  // Mensagens muito técnicas (códigos, caminhos de pilha) viram o texto padrão
  if (/^[A-Z_]{4,}\b/.test(clean) || /\bat \S+:\d+|0x[0-9a-f]{4,}|exit code|código de sa[ií]da/i.test(clean)) return fallback;
  return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
}
