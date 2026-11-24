'use strict';

/**
 * Registro dos módulos do BDS: recursos que o usuário liga/desliga em Configurações → Módulos.
 * Todas as telas, exceto Home e Configurações, são módulos. Módulo desligado some do menu lateral, dos cartões da Home e dos atalhos. NÃO se baixa código de
 * telas: o módulo controla visibilidade/registro e, quando há (`hasEngine`), o motor pesado.
 *
 * Campos: id, title, description, screens[] (data-view das telas; vazio = o módulo não tem tela, como o Assistente de IA, que é um botão flutuante), devOnly (só aparece em
 * desenvolvimento e fica desligado fora dele), defaultEnabled (false em todos, EXCETO o Assistente de IA, que
 * vem ligado: instalação nova começa com os recursos pesados desligados; quem já usava o app é migrado pelo
 * SettingsManager), hasEngine, engine ('whisper' =
 * painel do motor em Configurações → Inteligência Artificial; 'tool:<ferramenta>' = componente baixado sob demanda
 * pelo DependencyManager), order.
 *
 * SLOT 'extra': reservado para futuros módulos. Para criar um, acrescente uma definição abaixo
 * (id novo, `screens` com o data-view da tela) e inclua o data-view no menu do index.html. Enquanto
 * `EXTRA_MODULES` estiver vazio nada aparece na interface.
 */

const { ASSISTANT_ALLOWED_IN_PACKAGED_APP } = require('../../services/ai/releaseGate');

const BASE_MODULES = [
  {
    id: 'download',
    title: 'Downloads',
    description: 'Baixa vídeos e músicas de links, com fila, pausa e histórico.',
    screens: ['download'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 1
  },
  {
    id: 'converter',
    title: 'Conversor',
    description: 'Converte vídeos e áudios para MP4 e MP3, em fila.',
    screens: ['converter'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 2
  },
  {
    id: 'library',
    title: 'Biblioteca',
    description: 'Organiza e pesquisa as mídias das suas pastas. A pesquisa do topo e os números da Home dependem dela.',
    screens: ['library'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 3
  },
  {
    id: 'projects',
    title: 'Projetos',
    description: 'Agrupa mídias em projetos, com pastas, prazos e exportação.',
    screens: ['projects', 'project_workspace'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 4
  },
  {
    id: 'upload',
    title: 'Envio',
    description: 'Envia vídeos para o YouTube Studio.',
    screens: ['upload'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 5
  },
  {
    id: 'devices',
    title: 'Dispositivos',
    description: 'Conecta celulares, câmeras e cartões para importar mídias.',
    screens: ['devices'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 6
  },
  {
    id: 'luts',
    title: 'LUTs',
    description: 'Gerencia e visualiza as LUTs de cor.',
    screens: ['luts'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 7
  },
  {
    id: 'transcription',
    title: 'Transcrição',
    description: 'Gera legendas e transcrição de vídeos e áudios, com análise por IA opcional.',
    screens: ['transcription'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: true,
    engine: 'whisper',
    order: 10
  },
  {
    id: 'metadata',
    title: 'Metadados',
    description: 'Lê e edita as informações dos seus arquivos de mídia.',
    screens: ['metadata'],
    devOnly: false,
    defaultEnabled: false,
    hasEngine: false,
    order: 20
  },
  {
    id: 'recovery',
    title: 'Recuperar',
    description: 'Tenta recuperar vídeos e fotos corrompidos ou incompletos.',
    screens: ['recovery'],
    devOnly: true,
    defaultEnabled: false,
    hasEngine: true,
    engine: 'tool:untrunc',
    order: 40
  },
  {
    id: 'montage',
    title: 'Montagem',
    description: 'Monta automaticamente uma sequência a partir das suas mídias.',
    screens: ['montage'],
    devOnly: true,
    defaultEnabled: false,
    hasEngine: false,
    order: 50
  },
  {
    id: 'ai',
    title: 'Assistente de IA',
    description: 'Botão flutuante com um chat de IA para ajudar nas tarefas do BDS. Não é uma tela do menu.',
    screens: [],
    devOnly: !ASSISTANT_ALLOWED_IN_PACKAGED_APP, // a liberação no app final é uma só: src/services/ai/releaseGate.js
    defaultEnabled: true,   // o assistente vem LIGADO (único módulo assim); quem desligar em Configurações → Módulos continua desligado
    hasEngine: false,
    order: 60
  }
];

/** Slot 'extra': módulos futuros entram aqui (mesmo formato de BASE_MODULES). */
const EXTRA_MODULES = [];

const MODULES = Object.freeze([...BASE_MODULES, ...EXTRA_MODULES]
  .map((m) => Object.freeze({ ...m, screens: Object.freeze([...m.screens]) }))
  .sort((a, b) => a.order - b.order));

const IDS = new Set(MODULES.map((m) => m.id));

function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

function isKnownId(id) {
  return typeof id === 'string' && IDS.has(id);
}

/** Módulo dono de uma tela (data-view), ou null se a tela não pertence a módulo. */
function moduleForScreen(screen) {
  return MODULES.find((m) => m.screens.includes(screen)) || null;
}

/**
 * Estado efetivo de todos os módulos. Chave ausente em `enabledModules` = padrão do módulo (desligado, menos o
 * Assistente de IA, que é ligado; a migração de quem já usava o app grava as escolhas em `enabledModules`, ver SettingsManager).
 * Módulo devOnly fora do desenvolvimento nunca fica ligado.
 * @param {{enabledModules?: object}} [settings]
 * @param {{isDev?: boolean}} [opts]
 * @returns {Record<string, boolean>}
 */
function resolveEnabled(settings, { isDev = false } = {}) {
  const saved = settings && typeof settings.enabledModules === 'object' && settings.enabledModules
    && !Array.isArray(settings.enabledModules) ? settings.enabledModules : {};
  const out = {};
  for (const m of MODULES) {
    const value = typeof saved[m.id] === 'boolean' ? saved[m.id] : m.defaultEnabled;
    out[m.id] = (m.devOnly && !isDev) ? false : value;
  }
  return out;
}

function isEnabled(id, settings, opts) {
  if (!isKnownId(id)) return false;
  return resolveEnabled(settings, opts)[id];
}

/** Mantém só ids conhecidos com valor booleano (usado ao salvar as configurações). */
function sanitizeEnabledModules(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, v] of Object.entries(value)) {
    if (isKnownId(id) && typeof v === 'boolean') out[id] = v;
  }
  return out;
}

/** Módulos criados quando as telas principais passaram a ser módulos (quem já usava o app os recebe ligados). */
const CORE_SCREEN_MODULE_IDS = Object.freeze(['download', 'converter', 'library', 'projects', 'upload', 'devices', 'luts']);

module.exports = { CORE_SCREEN_MODULE_IDS, MODULES, getModule, isKnownId, moduleForScreen, resolveEnabled, isEnabled, sanitizeEnabledModules };
