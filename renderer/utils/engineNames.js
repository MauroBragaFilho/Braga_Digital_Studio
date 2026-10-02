/**
 * Nomes dos motores internos nunca aparecem para o usuário: textos exibidos (status, avisos,
 * erros vindos dos processos) passam por aqui e trocam o nome da ferramenta por um termo genérico.
 * Uso só em TEXTO DE EXIBIÇÃO — identificadores, chaves de configuração e logs não são alterados.
 * Espelho de src/services/engineNames.js (processo principal): mantenha as duas tabelas iguais.
 */

const ENGINE_NAME_RULES = [
  [/youtube-dl|yt[-_]?dlp/gi, 'motor de download'],
  [/spot(?:ify)?[-_]?dlp?/gi, 'motor de download'],
  [/ffprobe/gi, 'analisador de mídia'],
  [/ffplay|ffmpeg/gi, 'motor de mídia'],
  [/untrunc|RawRecoveryEngine/gi, 'motor de recuperação'],
  [/\bdeno\b/gi, 'componente de apoio'],
];

/**
 * @param {unknown} text
 * @returns {unknown} o mesmo valor se não for texto; senão o texto sem os nomes dos motores
 */
export function maskEngineNames(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, generic] of ENGINE_NAME_RULES) {
    out = out.replace(pattern, (match, offset, whole) => {
      // Início de frase: mantém a maiúscula ("FFmpeg falhou" -> "Motor de mídia falhou")
      const startsSentence = offset === 0 || /[.!?:]\s$/.test(whole.slice(Math.max(0, offset - 2), offset));
      return startsSentence ? generic.charAt(0).toUpperCase() + generic.slice(1) : generic;
    });
  }
  return out;
}
