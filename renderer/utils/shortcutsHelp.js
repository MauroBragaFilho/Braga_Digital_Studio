// Ajuda de atalhos de teclado: abre com "?" (fora de campos de texto) ou pelo botão discreto do menu lateral.
// Usa <dialog> nativo: Esc fecha, foco fica preso e volta ao elemento que abriu.

const GROUPS = [
  ['Navegação', [
    ['Ctrl + 1 … 9', 'Abrir a tela na posição do menu'],
    ['Ctrl + B', 'Recolher ou expandir o menu'],
    ['Ctrl + J', 'Abrir ou fechar o assistente de IA'],
    ['Ctrl + K  ou  /', 'Pesquisar na biblioteca'],
    ['F11', 'Tela cheia (Esc sai)']
  ]],
  ['Biblioteca', [
    ['Clique', 'Abrir detalhes do arquivo'],
    ['Ctrl + clique', 'Somar à seleção'],
    ['Shift + clique', 'Selecionar um intervalo'],
    ['Ctrl + A', 'Selecionar tudo'],
    ['Esc', 'Fechar detalhes ou limpar a seleção']
  ]],
  ['Pré-visualização', [
    ['Espaço', 'Reproduzir ou pausar'],
    ['← →', 'Voltar ou avançar'],
    ['Esc', 'Fechar']
  ]]
];

let dialog = null;
let opener = null;

function build() {
  const d = document.createElement('dialog');
  d.className = 'bds-shortcuts';
  d.setAttribute('aria-labelledby', 'bdsShortcutsTitle');
  const h = document.createElement('h2');
  h.id = 'bdsShortcutsTitle';
  h.textContent = 'Atalhos de teclado';
  d.appendChild(h);
  for (const [title, rows] of GROUPS) {
    const sec = document.createElement('section');
    const h3 = document.createElement('h3');
    h3.textContent = title;
    sec.appendChild(h3);
    const dl = document.createElement('dl');
    for (const [keys, what] of rows) {
      const dt = document.createElement('dt');
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      dt.appendChild(kbd);
      const dd = document.createElement('dd');
      dd.textContent = what;
      dl.append(dt, dd);
    }
    sec.appendChild(dl);
    d.appendChild(sec);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'bds-btn-secondary bds-shortcuts-close';
  close.textContent = 'Fechar';
  close.addEventListener('click', () => d.close());
  d.appendChild(close);
  d.addEventListener('close', () => {
    if (opener && document.contains(opener)) { try { opener.focus(); } catch (_) { /* noop */ } }
    opener = null;
  });
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  document.body.appendChild(d);
  return d;
}

export function openShortcutsHelp() {
  if (document.querySelector('dialog[open]')) return;
  if (!dialog) dialog = build();
  opener = document.activeElement;
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  dialog.querySelector('.bds-shortcuts-close')?.focus();
}

export function initShortcutsHelp() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
    e.preventDefault();
    openShortcutsHelp();
  });
  document.getElementById('shortcutsHelpBtn')?.addEventListener('click', openShortcutsHelp);
}
