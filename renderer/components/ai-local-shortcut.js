/**
 * Atalho único para "Neste computador" (Configurações → Inteligência Artificial), usado pelas seções Áudio e Imagem.
 * Mesmo rótulo e aria-label nas duas; o clique avisa o evento 'bds:ai-open-sub' (detail 'local'), que abre o subpainel.
 * Quem usa decide quando mostrá-lo: só quando falta algo instalado (pronto vira uma frase na dica da própria linha).
 */

export const LOCAL_SHORTCUT_HINT = 'Para trocar ou apagar modelos, abra "Neste computador".';

export function localShortcut() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mod-btn mod-btn-secondary mod-btn-sm';
  btn.setAttribute('aria-label', 'Gerenciar modelos neste computador');
  btn.title = 'Gerenciar modelos neste computador';
  const ic = document.createElement('span');
  ic.className = 'material-symbols-rounded';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = 'tune';
  btn.append(ic, 'Gerenciar modelos');
  btn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('bds:ai-open-sub', { detail: 'local' })));
  return btn;
}
