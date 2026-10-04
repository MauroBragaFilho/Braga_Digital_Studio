'use strict';

/**
 * Quais definições de ferramentas enviar em cada rodada (custo de contexto para modelos pequenos).
 *
 * DECISÃO: as 22 definições juntas pesam vários milhares de tokens; modelos pequenos (locais) se perdem e ficam
 * lentos com tudo isso. Então cada rodada leva um SUBCONJUNTO:
 *   - sempre o NÚCLEO (buscar mídia, detalhes, projetos, visão geral do app, abrir tela);
 *   - mais os GRUPOS que combinam com o que o usuário escreveu (esta mensagem e as 2 anteriores dele), com a tela
 *     aberta e com as ferramentas que o modelo já usou nesta pergunta (assim uma resposta curta como "sim, pode
 *     converter" não perde a ferramenta);
 *   - se NADA combinar, o núcleo mais as consultas de estado (somente leitura, sem argumentos, baratas). Ações só
 *     aparecem quando o pedido tem a ver com elas.
 *
 * SEGURANÇA: isto só decide o que é OFERECIDO ao modelo. O ToolBox continua aceitando e validando QUALQUER nome da
 * lista fixa (esquema estrito + confirmação nativa nas ações); nada fora da lista fixa é executado. Escolher mal
 * o subconjunto nunca libera uma ação sem confirmação.
 */

const CORE = ['library_search', 'media_get', 'projects_list', 'project_get', 'app_overview', 'open_screen'];
const STATUS_READS = ['library_stats', 'downloads_status', 'converter_status', 'devices_list', 'settings_summary', 'transcription_status'];

const GROUPS = Object.freeze([
  { id: 'downloads', tools: ['add_download', 'downloads_status'], screens: ['download'], words: /baix|download|\blink\b|\burl\b|https?:|youtu|\bmp3\b|m[uú]sica|playlist/i },
  { id: 'convert', tools: ['convert_media', 'converter_status'], screens: ['converter'], words: /convert|\bmp4\b|\bmp3\b|formato|comprim|resolu[cç]|1080|720|480|bitrate/i },
  { id: 'silence', tools: ['remove_silence'], screens: ['silence'], words: /sil[eê]nc|pausas?\b|cortar? (as )?pausas|tirar (as )?pausas/i },
  { id: 'transcription', tools: ['transcribe_media', 'transcription_status', 'get_transcript'], screens: ['transcription'], words: /transcr[ei]|legenda|\bfal[ao]u?\b|resum|o que (ele|ela|o v[ií]deo|a aula) (diz|fala)|\bdiz\b|texto d[oa]/i },
  { id: 'projects', tools: ['create_project', 'add_media_to_project', 'export_project'], screens: ['projects'], words: /projeto|pasta|export|premiere|bdspro|mont|organiz/i },
  { id: 'tags', tools: ['tag_media', 'set_favorite'], screens: [], words: /\btags?\b|etiquet|favorit|estrela|marcar|desmarcar/i },
  { id: 'devices', tools: ['devices_list'], screens: ['devices'], words: /celular|dispositiv|aparelho|c[aâ]mera|telefone|conectad/i },
  { id: 'library', tools: ['library_stats'], screens: ['library'], words: /quantos|quantas|total|estat[ií]stic|espa[cç]o|tamanho|biblioteca/i },
  { id: 'settings', tools: ['settings_summary'], screens: ['settings'], words: /configura|\btema\b|\bcor\b|m[oó]dulo|ajuste|prefer[eê]ncia/i }
]);

/**
 * @param {{ texts?: string[], screen?: string|null, used?: string[] }} [hints]  textos recentes do usuário, tela aberta
 *        e nomes de ferramentas já chamadas nesta pergunta
 * @returns {Set<string>} nomes das ferramentas a oferecer
 */
function selectToolNames({ texts = [], screen = null, used = [] } = {}) {
  const text = texts.filter((t) => typeof t === 'string').join(' \n ').slice(-4000);
  const usedSet = new Set(used);
  const chosen = new Set(CORE);
  let matched = false;
  for (const g of GROUPS) {
    const hit = g.words.test(text) || (screen && g.screens.includes(screen)) || g.tools.some((t) => usedSet.has(t));
    if (!hit) continue;
    matched = true;
    g.tools.forEach((t) => chosen.add(t));
  }
  if (!matched) STATUS_READS.forEach((t) => chosen.add(t));
  used.forEach((t) => chosen.add(t));
  return chosen;
}

module.exports = { selectToolNames, CORE, STATUS_READS, GROUPS };
