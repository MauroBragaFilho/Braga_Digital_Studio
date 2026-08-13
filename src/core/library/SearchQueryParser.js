/**
 * Utilitário para interpretar buscas em linguagem natural
 * Converte frases como "imagem de prédio", "fotos de pessoas", "vídeo 1080p"
 * em parâmetros de busca para o SQLite.
 */
class SearchQueryParser {
  static parse(rawQuery = '') {
    const text = rawQuery.trim().toLowerCase();
    if (!text) {
      return { query: '', types: [], synonyms: [] };
    }

    const detectedTypes = new Set();
    let cleanText = text;

    // 1. Detecção de Tipo de Mídia por Palavras-chave
    const photoKeywords = ['imagem', 'imagens', 'foto', 'fotos', 'picture', 'pictures', 'fotografia', 'fotografias', 'img'];
    const videoKeywords = ['vídeo', 'video', 'vídeos', 'videos', 'filme', 'filmes', 'clipe', 'clipes', 'gravação', 'gravacao'];
    const audioKeywords = ['áudio', 'audio', 'áudios', 'audios', 'som', 'sons', 'música', 'musica', 'faixa', 'faixas', 'voz'];

    const words = cleanText.split(/\s+/);
    const filteredWords = [];

    for (const word of words) {
      if (photoKeywords.includes(word)) {
        detectedTypes.add('photo');
      } else if (videoKeywords.includes(word)) {
        detectedTypes.add('video');
      } else if (audioKeywords.includes(word)) {
        detectedTypes.add('audio');
      } else if (!['de', 'da', 'do', 'das', 'dos', 'com', 'em', 'para', 'por', 'um', 'uma'].includes(word)) {
        filteredWords.push(word);
      }
    }

    const baseTerm = filteredWords.join(' ').trim();

    // 2. Dicionário de Sinônimos e Mapeamento Semântico
    const synonymMap = {
      'predio': ['predio', 'prédio', 'edificio', 'edifício', 'arranha-ceu', 'building', 'arquitetura', 'construcao', 'construção', 'torre'],
      'prédio': ['predio', 'prédio', 'edificio', 'edifício', 'arranha-ceu', 'building', 'arquitetura', 'construcao', 'construção', 'torre'],
      'edificio': ['predio', 'prédio', 'edificio', 'edifício', 'building', 'arquitetura'],
      'edifício': ['predio', 'prédio', 'edificio', 'edifício', 'building', 'arquitetura'],
      'pessoa': ['pessoa', 'pessoas', 'gente', 'homem', 'mulher', 'humano', 'retrato', 'portrait', 'face', 'rosto'],
      'pessoas': ['pessoa', 'pessoas', 'gente', 'homem', 'mulher', 'humano', 'retrato', 'portrait', 'face', 'rosto'],
      'homem': ['homem', 'homens', 'pessoa', 'pessoas', 'cara'],
      'mulher': ['mulher', 'mulheres', 'pessoa', 'pessoas', 'garota'],
      'carro': ['carro', 'carros', 'veiculo', 'veículo', 'automovel', 'automóvel', 'auto', 'drive'],
      'natureza': ['natureza', 'floresta', 'arvore', 'árvore', 'planta', 'paisagem', 'folha', 'verde'],
      'praia': ['praia', 'mar', 'oceano', 'areia', 'sol', 'costa', 'surf']
    };

    const synonyms = new Set();
    if (baseTerm) {
      synonyms.add(baseTerm);
      if (synonymMap[baseTerm]) {
        synonymMap[baseTerm].forEach(s => synonyms.add(s));
      }
      filteredWords.forEach(w => {
        if (synonymMap[w]) {
          synonymMap[w].forEach(s => synonyms.add(s));
        }
      });
    }

    return {
      rawQuery,
      cleanQuery: baseTerm || text,
      types: Array.from(detectedTypes),
      synonyms: Array.from(synonyms)
    };
  }
}

module.exports = SearchQueryParser;
