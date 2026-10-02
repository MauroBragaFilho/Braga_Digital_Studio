'use strict';

/**
 * WhisperCatalog — modelos do Whisper que o usuário pode escolher, com informações para decidir.
 *
 * Os modelos são os convertidos para o faster-whisper (CTranslate2). Tamanho exato e SHA-256 vêm
 * do Hugging Face no momento do download; `sizeBytes` aqui é só a estimativa exibida antes.
 *
 * Referência de velocidade e memória: tabela do projeto Whisper (OpenAI), em GPU. São valores
 * comparativos entre os modelos, não medições deste computador; no faster-whisper (int8) o uso
 * de memória costuma ser menor. Todos os modelos abaixo são multilíngues (incluem português).
 */

const WHISPER_MODELS = [
  {
    id: 'tiny', label: 'Tiny', repo: 'Systran/faster-whisper-tiny',
    sizeBytes: 75538270, speed: '~10x', speedLevel: 5, quality: 2, vramGb: 1,
    description: 'O mais rápido e leve. Serve para testar; erra bastante em áudio com ruído, sotaque forte ou termos técnicos.'
  },
  {
    id: 'base', label: 'Base', repo: 'Systran/faster-whisper-base',
    sizeBytes: 145217532, speed: '~7x', speedLevel: 4, quality: 2, vramGb: 1,
    description: 'Um pouco mais preciso que o Tiny e ainda muito leve. Bom para áudio limpo e computadores modestos.'
  },
  {
    id: 'small', label: 'Small', repo: 'Systran/faster-whisper-small',
    sizeBytes: 483546902, speed: '~4x', speedLevel: 3, quality: 3, vramGb: 2, recommendedFor: 'cpu',
    description: 'Bom equilíbrio para quem não tem placa NVIDIA: qualidade razoável em português com tempo aceitável na CPU.'
  },
  {
    id: 'medium', label: 'Medium', repo: 'Systran/faster-whisper-medium',
    sizeBytes: 1527906378, speed: '~2x', speedLevel: 2, quality: 4, vramGb: 5,
    description: 'Boa precisão. Fica lento na CPU; compensa mais com placa NVIDIA.'
  },
  {
    id: 'large-v3-turbo', label: 'Large V3 Turbo', repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    sizeBytes: 1617884929, speed: '~8x', speedLevel: 4, quality: 5, vramGb: 6, recommendedFor: 'gpu',
    description: 'Qualidade próxima à do Large V3 com velocidade bem maior. É o recomendado quando há placa NVIDIA (com o CUDA instalado).'
  },
  {
    id: 'large-v3', label: 'Large V3', repo: 'Systran/faster-whisper-large-v3',
    sizeBytes: 3087284237, speed: '1x', speedLevel: 1, quality: 5, vramGb: 10,
    description: 'A máxima precisão disponível, porém o mais pesado e lento. Use em áudio difícil, com placa NVIDIA potente.'
  }
];

const DEFAULT_MODEL_ID = 'large-v3-turbo';

function getModel(id) {
  return WHISPER_MODELS.find((m) => m.id === id) || null;
}

const REFERENCE_NOTE =
  'Velocidade e memória são valores de referência dos modelos, comparáveis entre si; ' +
  'no seu computador variam, e o motor costuma usar menos memória.';

module.exports = { WHISPER_MODELS, DEFAULT_MODEL_ID, REFERENCE_NOTE, getModel };
