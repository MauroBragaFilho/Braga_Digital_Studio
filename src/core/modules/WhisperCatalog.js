'use strict';

/**
 * WhisperCatalog — modelos do Whisper que o usuário pode escolher, com informações para decidir.
 *
 * Os modelos são os do whisper.cpp (formato ggml), publicados no Hugging Face em ggerganov/whisper.cpp.
 * Usamos as versões quantizadas (q5): ocupam cerca de 3 a 4 vezes menos que as originais, com perda de
 * qualidade pequena. Tamanho exato e SHA-256 vêm do Hugging Face no momento do download; `sizeBytes`
 * aqui é só a estimativa exibida antes.
 *
 * `dtw` é o nome do modelo para o alinhamento de palavras do whisper.cpp (`--dtw`), que dá o tempo
 * de cada palavra das legendas.
 *
 * Velocidade e memória: valores de referência da tabela do projeto Whisper (OpenAI), comparativos entre os
 * modelos, não medições deste computador. Todos os modelos abaixo são multilíngues (incluem português).
 */

const REPO = 'ggerganov/whisper.cpp';

const WHISPER_MODELS = [
  {
    id: 'tiny', label: 'Tiny', repo: REPO, file: 'ggml-tiny-q5_1.bin', dtw: 'tiny',
    sizeBytes: 32152673, speed: '~10x', speedLevel: 5, quality: 2, vramGb: 1,
    description: 'O mais rápido e leve. Serve para testar; erra bastante em áudio com ruído, sotaque forte ou termos técnicos.'
  },
  {
    id: 'base', label: 'Base', repo: REPO, file: 'ggml-base-q5_1.bin', dtw: 'base',
    sizeBytes: 59707625, speed: '~7x', speedLevel: 4, quality: 2, vramGb: 1,
    description: 'Um pouco mais preciso que o Tiny e ainda muito leve. Bom para áudio limpo e computadores modestos.'
  },
  {
    id: 'small', label: 'Small', repo: REPO, file: 'ggml-small-q5_1.bin', dtw: 'small',
    sizeBytes: 190085487, speed: '~4x', speedLevel: 3, quality: 3, vramGb: 1, recommendedFor: 'cpu',
    description: 'Bom equilíbrio para quem não tem placa NVIDIA: qualidade razoável em português com tempo aceitável na CPU.'
  },
  {
    id: 'medium', label: 'Medium', repo: REPO, file: 'ggml-medium-q5_0.bin', dtw: 'medium',
    sizeBytes: 539212467, speed: '~2x', speedLevel: 2, quality: 4, vramGb: 2,
    description: 'Boa precisão. Fica muito lento na CPU; compensa mais com placa NVIDIA.'
  },
  {
    id: 'large-v3-turbo', label: 'Large V3 Turbo', repo: REPO, file: 'ggml-large-v3-turbo-q5_0.bin', dtw: 'large.v3.turbo',
    sizeBytes: 574041195, speed: '~8x', speedLevel: 4, quality: 5, vramGb: 2, recommendedFor: 'gpu',
    description: 'Qualidade próxima à do Large V3 com velocidade bem maior. É o recomendado quando há placa NVIDIA (com a aceleração instalada); na CPU fica muito lento.'
  },
  {
    id: 'large-v3', label: 'Large V3', repo: REPO, file: 'ggml-large-v3-q5_0.bin', dtw: 'large.v3',
    sizeBytes: 1081140203, speed: '1x', speedLevel: 1, quality: 5, vramGb: 3,
    description: 'A máxima precisão disponível, porém o mais pesado e lento. Use em áudio difícil, com placa NVIDIA potente.'
  }
];

const DEFAULT_MODEL_ID = 'large-v3-turbo';

function getModel(id) {
  return WHISPER_MODELS.find((m) => m.id === id) || null;
}

const REFERENCE_NOTE =
  'Velocidade e memória são valores de referência dos modelos, comparáveis entre si; ' +
  'no seu computador variam. Versões quantizadas (q5): menores que as originais, com qualidade quase igual.';

module.exports = { WHISPER_MODELS, DEFAULT_MODEL_ID, REFERENCE_NOTE, getModel };
