'use strict';

/**
 * Telas de PRODUÇÃO que o assistente conhece: lista FIXA usada em três lugares (e só aqui no main):
 *  - contexto da tela que o renderer envia a cada mensagem (ai:chatStart, validado em context.js);
 *  - ferramenta open_screen (o modelo só escolhe um destes ids);
 *  - evento ai:navigate (main → renderer), que o renderer confere contra a MESMA lista antes de navegar
 *    (renderer/components/ai-assistant.js repete a lista; tests/ai-assistant-integration.test.js garante que são iguais).
 * Recuperação e Montagem ficam de fora de propósito: são telas de desenvolvimento.
 *
 * `module` = módulo (ModuleRegistry) que precisa estar ligado para a tela existir; null = sempre disponível.
 * `label` = nome mostrado no menu lateral.
 */
const AI_SCREENS = Object.freeze([
  { id: 'home', label: 'Home', module: null },
  { id: 'download', label: 'Downloads', module: null },
  { id: 'converter', label: 'Conversor', module: null },
  { id: 'silence', label: 'Remover Silêncio', module: 'silence' },
  { id: 'metadata', label: 'Metadados', module: 'metadata' },
  { id: 'transcription', label: 'Transcrição', module: 'transcription' },
  { id: 'library', label: 'Biblioteca', module: null },
  { id: 'projects', label: 'Projetos', module: null },
  { id: 'upload', label: 'Envio', module: null },
  { id: 'devices', label: 'Dispositivos', module: null },
  { id: 'luts', label: 'LUTs', module: null },
  { id: 'settings', label: 'Configurações', module: null }
].map((s) => Object.freeze(s)));

const SCREEN_IDS = Object.freeze(AI_SCREENS.map((s) => s.id));
const BY_ID = new Map(AI_SCREENS.map((s) => [s.id, s]));

const screenById = (id) => (typeof id === 'string' ? BY_ID.get(id) || null : null);
const isKnownScreen = (id) => screenById(id) !== null;

module.exports = { AI_SCREENS, SCREEN_IDS, screenById, isKnownScreen };
