// Contexto da tela para o assistente de IA: um objeto PEQUENO { screen, selectedIds, projectId } montado a cada
// mensagem e enviado como argumento opcional de ai:chatStart. O processo principal revalida tudo (tipos, limites,
// telas conhecidas) e só o usa como dado não confiável no prompt: o contexto nunca autoriza uma ação.
//
// As telas registram "provedores" (funções) em vez de empurrar valores a cada clique: assim nada fica velho e o
// assistente só lê o que a tela mostra no momento do envio.
//   - 'librarySelection': ids das mídias selecionadas na Biblioteca (só valem com a Biblioteca aberta);
//   - 'projectSelected': projeto selecionado na lista de Projetos;
//   - 'workspaceProject': projeto aberto na área de trabalho (registrado ao abrir e removido ao sair).

/**
 * Telas de PRODUÇÃO que o assistente conhece (mesma lista de src/services/ai/screens.js, conferida por teste).
 * `module` = módulo que precisa estar ligado; null = sempre disponível.
 */
export const AI_SCREENS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', module: null }),
  Object.freeze({ id: 'download', label: 'Downloads', module: null }),
  Object.freeze({ id: 'converter', label: 'Conversor', module: null }),
  Object.freeze({ id: 'silence', label: 'Remover Silêncio', module: 'silence' }),
  Object.freeze({ id: 'metadata', label: 'Metadados', module: 'metadata' }),
  Object.freeze({ id: 'transcription', label: 'Transcrição', module: 'transcription' }),
  Object.freeze({ id: 'library', label: 'Biblioteca', module: null }),
  Object.freeze({ id: 'projects', label: 'Projetos', module: null }),
  Object.freeze({ id: 'upload', label: 'Envio', module: null }),
  Object.freeze({ id: 'devices', label: 'Dispositivos', module: null }),
  Object.freeze({ id: 'luts', label: 'LUTs', module: null }),
  Object.freeze({ id: 'settings', label: 'Configurações', module: null })
]);

export const MAX_SELECTED_IDS = 50;

const providers = {};

/** Registra (fn) ou remove (null) um provedor de contexto. */
export function setContextProvider(name, fn) {
  if (typeof fn === 'function') providers[name] = fn;
  else delete providers[name];
}

const isId = (v) => Number.isInteger(v) && v >= 1 && v <= 2147483647;

function read(name) {
  try { return typeof providers[name] === 'function' ? providers[name]() : null; } catch (_) { return null; }
}

/** Id da tela aberta no menu lateral (data-view da aba ativa), ou null se não for uma tela conhecida. */
export function activeScreenId(doc = document) {
  const id = doc.querySelector('.sidebar .tab-button.active')?.getAttribute('data-view') || 'home';
  return AI_SCREENS.some((s) => s.id === id) ? id : null;
}

/**
 * Contexto a enviar junto da mensagem, ou undefined (tela desconhecida, como as de desenvolvimento). A seleção só
 * entra com a Biblioteca aberta; o projeto, com a tela de Projetos (lista ou área de trabalho).
 */
export function currentContext(doc = document) {
  const screen = activeScreenId(doc);
  if (!screen) return undefined;
  const ctx = { screen };
  if (screen === 'library') {
    const ids = read('librarySelection');
    if (Array.isArray(ids)) {
      const clean = [...new Set(ids.filter(isId))].slice(0, MAX_SELECTED_IDS);
      if (clean.length) ctx.selectedIds = clean;
    }
  }
  if (screen === 'projects') {
    const id = read('workspaceProject') ?? read('projectSelected');
    if (isId(id)) ctx.projectId = id;
  }
  return ctx;
}
