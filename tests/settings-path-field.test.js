'use strict';

// Configurações: campo de caminho (campo editável com o ícone de escolher dentro) e detecção automática das pastas
// de gravação (sem o botão "Detectar de novo").
//   - os 7 botões "Alterar" das pastas, a imagem de LUTs e a janela "Nova fonte" usam o mesmo componente;
//   - a detecção roda ao abrir a tela, ao voltar o foco para a janela e ao esvaziar um campo manual;
//   - os ícones da lista de fontes ficam visíveis (nunca opacidade 0) e têm o nome da fonte no aria-label.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const css = fs.readFileSync(path.join(SCREENS_DIR, 'settings.css'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

// id do botão (mantido) -> id do campo
const PATH_FIELDS = {
  mp3FolderButton: 'mp3FolderInput',
  mp4FolderButton: 'mp4FolderInput',
  converterFolderButton: 'converterFolderInput',
  obsFolderButton: 'obsFolderInput',
  shadowplayFolderButton: 'shadowplayFolderInput',
  deviceFolderButton: 'deviceFolderInput',
  uploadsFolderButton: 'uploadsFolderInput',
  lutPreviewImageSelectBtn: 'lutPreviewImageInput',
  modalSettingsAddCustomSourceSelectBtn: 'modalSettingsAddCustomSourcePath'
};

test('HTML: pastas, imagem de LUTs e janela Nova fonte usam o campo de caminho com o ícone dentro', () => {
  const labels = new Set();
  for (const [buttonId, inputId] of Object.entries(PATH_FIELDS)) {
    const btn = staticDoc.getElementById(buttonId);
    const input = staticDoc.getElementById(inputId);
    assert.ok(btn && input, `${buttonId} e ${inputId} existem (ids mantidos)`);
    const box = btn.parentElement;
    assert.ok(box.classList.contains('st-path-field'), `${buttonId}: dentro de .st-path-field`);
    assert.equal(input.parentElement, box, `${buttonId}: campo e ícone no mesmo componente`);
    assert.ok(btn.classList.contains('st-path-pick'), `${buttonId}: classe do ícone`);
    assert.equal(btn.getAttribute('type'), 'button');
    const label = btn.getAttribute('aria-label');
    assert.match(label || '', /^Escolher /, `${buttonId}: aria-label específico`);
    assert.equal(btn.getAttribute('title'), label, `${buttonId}: title igual ao aria-label`);
    assert.equal(btn.textContent.trim().replace(/\s+/g, ' '), btn.querySelector('.material-symbols-rounded').textContent.trim(), `${buttonId}: só o ícone, sem texto "Alterar"`);
    assert.equal(btn.querySelector('.material-symbols-rounded').getAttribute('aria-hidden'), 'true', `${buttonId}: ícone decorativo`);
    assert.ok(!labels.has(label), `aria-label repetido: ${label}`);
    labels.add(label);
  }
  // os campos de pasta continuam editáveis (dá para colar o caminho); só a imagem de LUTs é somente leitura
  for (const [buttonId, inputId] of Object.entries(PATH_FIELDS)) {
    const readonly = staticDoc.getElementById(inputId).hasAttribute('readonly');
    assert.equal(readonly, buttonId === 'lutPreviewImageSelectBtn', `${inputId}: somente leitura só nas LUTs`);
  }
  assert.doesNotMatch(html, />\s*Alterar\s*</, 'nenhum botão "Alterar" sobrou na tela de Configurações');
  assert.doesNotMatch(html, /Escolher outra pasta/);
});

test('HTML: sem "Detectar de novo" nem a linha "Detecção automática"; as dicas dos campos continuam com aria-live', () => {
  assert.equal(staticDoc.getElementById('btnDetectRecordingFolders'), null);
  assert.doesNotMatch(html, /Detectar de novo|Detecção automática/);
  for (const id of ['obsDetectedHint', 'shadowplayDetectedHint']) {
    assert.equal(staticDoc.getElementById(id).getAttribute('aria-live'), 'polite');
  }
});

test('CSS: o ícone do campo usa só tokens e tem foco visível; os ícones da lista de fontes nunca somem (opacidade mínima)', () => {
  const bloco = (re) => { const m = css.match(re); assert.ok(m, String(re)); return m[0]; };
  const pick = bloco(/\.st-path-pick\s*\{[^}]*\}/);
  assert.match(pick, /var\(--radius-pill\)/);
  assert.match(pick, /var\(--muted\)/);
  assert.doesNotMatch(pick, /#[0-9a-fA-F]{3,8}\b/, 'sem hex solto');
  assert.doesNotMatch(pick, /font-weight:\s*(7|8|9)00|font-weight:\s*bold/);
  assert.match(css, /\.st-path-pick:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring\)/);
  assert.match(css, /\.st-path-field \.settings-input\s*\{[^}]*padding-right/, 'o campo cede a área do ícone');

  const row = bloco(/\.btn-edit-custom-source,\s*\.btn-delete-custom-source\s*\{[^}]*\}/);
  const op = Number(row.match(/opacity:\s*([\d.]+)/)?.[1]);
  assert.ok(op >= 0.5 && op < 1, `ícones visíveis e discretos em repouso (opacity ${op})`);
  assert.doesNotMatch(css, /\.btn-(edit|delete)-custom-source[^{]*\{[^}]*(opacity:\s*0\s*[;}]|display:\s*none|visibility:\s*hidden)/);
  assert.match(css, /\.btn-edit-custom-source:focus-visible[^{]*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.btn-delete-custom-source:focus-visible[^{]*\{[^}]*outline/);
});

// ---- Testes de comportamento: uma única montagem (o app.js é importado uma vez por processo e `state.settings` vem dela).
const estado = { deteccoes: 0, falhar: false, escolhas: [], seletoresDeImagem: 0 };
const RESULTADO = {
  obs: { configDir: 'C:/obs', activeProfile: 'Principal', profiles: [{ profile: 'Principal', path: 'D:/Rec', active: true }] },
  shadowplay: { path: 'E:/NVIDIA', source: 'registry' }
};
let montagem = null;
function montar() {
  if (!montagem) {
    montagem = mountScreen('settings', {
      shell: true,
      bds: {
        getSettings: async () => ({
          mp3Folder: 'D:/Meus/Audios', mp4Folder: 'D:/Meus/Videos', converterFolder: 'D:/Meus/Saida', obsFolder: 'D:/OBS',
          shadowplayFolder: '', deviceFolder: 'D:/Disp', uploadsFolder: '', lutPreviewImage: ''
        }),
        getDefaultFolders: async () => ({ mp3Folder: 'C:/Music', mp4Folder: 'C:/Videos', converterFolder: 'C:/Videos/Convertido' }),
        selectFolder: async (atual) => { const novo = `D:/Nova/${estado.escolhas.length}`; estado.escolhas.push(atual); return novo; },
        selectFiles: async () => { estado.seletoresDeImagem++; return ['D:/Imagens/ref.png']; },
        detectRecordingFolders: async () => { estado.deteccoes++; if (estado.falhar) throw new Error('falhou'); return RESULTADO; },
        getCustomSources: async () => [{ id: 7, name: 'Podcast "Studio"', path: 'D:/Pod' }, { id: 8, name: 'Câmera', path: 'D:/Cam' }]
      }
    });
  }
  return montagem;
}
test.after(async () => { if (montagem) await (await montagem).cleanup(); });

const evento = (h, tipo, props = {}) => Object.assign(new h.window.Event(tipo, { bubbles: true, cancelable: true }), props);

test('detecção automática: ao abrir, ao voltar o foco (com intervalo mínimo) e ao esvaziar um campo manual; resultado na dica', async () => {
  const h = await montar();
  const realNow = Date.now;
  let agora = realNow();
  Date.now = () => agora;
  try {
    await settle(80);
    const doc = h.document;
    const $ = (id) => doc.getElementById(id);
    const hint = (id) => $(id).textContent;
    const digitar = (id, valor) => {
      $(id).value = valor;
      $(id).dispatchEvent(evento(h, 'input'));
    };
    const foco = () => h.window.dispatchEvent(evento(h, 'focus'));

    // ao iniciar: uma detecção; o OBS manual mostra o aviso e o ShadowPlay em branco mostra o que foi achado
    assert.equal(estado.deteccoes, 1, 'detecta ao iniciar');
    assert.equal($('obsFolderInput').value, 'D:/OBS');
    assert.match(hint('obsDetectedHint'), /definida manualmente/);
    assert.equal(hint('shadowplayDetectedHint'), 'Detectado do NVIDIA App: E:/NVIDIA');
    assert.equal($('btnDetectRecordingFolders'), null, 'não há botão para detectar');

    // voltar o foco logo em seguida não lê de novo; passado o intervalo mínimo, lê
    foco();
    await settle(20);
    assert.equal(estado.deteccoes, 1, 'foco dentro do intervalo mínimo: nada a fazer');
    agora += 11000;
    foco();
    await settle(20);
    assert.equal(estado.deteccoes, 2, 'foco depois do intervalo: detecta');

    // esvaziar o campo manual detecta já (sem esperar o intervalo) e mostra o resultado na dica do campo
    digitar('obsFolderInput', '');
    await settle(20);
    assert.equal(estado.deteccoes, 3, 'campo manual esvaziado: detecta');
    assert.equal(hint('obsDetectedHint'), 'Detectado do OBS: Principal (ativo) → D:/Rec');
    // digitar de novo só troca a dica para "manual" (sem ler nada)
    digitar('obsFolderInput', 'D:/Outra');
    assert.equal(estado.deteccoes, 3);
    assert.match(hint('obsDetectedHint'), /definida manualmente/);
    // um campo que já estava em branco não detecta de novo
    digitar('shadowplayFolderInput', '');
    await settle(20);
    assert.equal(estado.deteccoes, 3, 'campo que já estava vazio: sem nova leitura');
    // esvaziar outra vez conta de novo
    digitar('obsFolderInput', '');
    await settle(20);
    assert.equal(estado.deteccoes, 4);

    // falha na leitura: nada escapa e a dica anterior continua
    estado.falhar = true;
    agora += 11000;
    foco();
    await settle(20);
    assert.equal(estado.deteccoes, 5);
    assert.equal(hint('obsDetectedHint'), 'Detectado do OBS: Principal (ativo) → D:/Rec');
    assert.deepEqual(h.errors, [], 'a falha não vira erro não tratado');

    // ao sair da tela o foco da janela deixa de detectar; ao voltar, volta a detectar
    estado.falhar = false;
    await h.mod.onLeave();
    agora += 11000;
    foco();
    await settle(20);
    assert.equal(estado.deteccoes, 5, 'tela fechada: sem detecção');
    await h.mod.onEnter();
    await settle(20);
    assert.equal(estado.deteccoes, 6, 'ao voltar para a tela: detecta');
    assert.equal($('obsFolderInput').value, 'D:/OBS', 'os campos voltam ao que está salvo');
    assert.match(hint('obsDetectedHint'), /definida manualmente/, 'a dica reflete o campo, sem nova leitura');
    agora += 11000;
    foco();
    await settle(20);
    assert.equal(estado.deteccoes, 7, 'e o foco da janela volta a valer');
  } finally {
    Date.now = realNow;
  }
});

test('o ícone de pasta abre o seletor com o caminho atual, preenche o campo e marca a tela como alterada', async () => {
  const h = await montar();
  await settle(40);
  const doc = h.document;
  const $ = (id) => doc.getElementById(id);
  const pastas = ['mp3FolderButton', 'mp4FolderButton', 'converterFolderButton', 'obsFolderButton', 'shadowplayFolderButton', 'deviceFolderButton', 'uploadsFolderButton'];
  const base = estado.escolhas.length;
  for (const [i, id] of pastas.entries()) {
    const antes = $(PATH_FIELDS[id]).value;
    $(id).click();
    await settle(20);
    assert.equal(estado.escolhas[base + i], antes, `${id}: o seletor abre na pasta atual do campo`);
    assert.equal($(PATH_FIELDS[id]).value, `D:/Nova/${base + i}`, `${id}: o campo recebe a pasta escolhida`);
  }
  assert.equal($('settingsSaveBar').classList.contains('hidden'), false, 'escolher uma pasta marca alterações não salvas');
  // colar o caminho continua possível: o campo é editável
  $('mp3FolderInput').value = 'E:/Colado/Audios';
  $('mp3FolderInput').dispatchEvent(evento(h, 'input'));
  assert.equal($('mp3FolderInput').value, 'E:/Colado/Audios');
  assert.equal($('mp3FolderInput').hasAttribute('readonly'), false);

  // janela Nova fonte: o ícone dentro do campo escolhe a pasta da fonte
  $('modalSettingsAddCustomSourceSelectBtn').click();
  await settle(20);
  assert.equal($('modalSettingsAddCustomSourcePath').value, `D:/Nova/${base + pastas.length}`);
  assert.deepEqual(h.errors, []);
});

test('LUTs: o ícone, o clique e o Enter no campo e o clique na miniatura abrem o seletor de imagem; o Enter não salva', async () => {
  const h = await montar();
  const doc = h.document;
  const $ = (id) => doc.getElementById(id);
  const base = estado.seletoresDeImagem;
  $('lutPreviewImageSelectBtn').click();
  await settle(20);
  assert.equal(estado.seletoresDeImagem, base + 1);
  assert.equal($('lutPreviewImageInput').value, 'D:/Imagens/ref.png');
  // URL de arquivo bem formada (três barras antes da unidade), montada pelo auxiliar único toFileUrl
  assert.equal($('settingsLutPreviewThumb').getAttribute('src'), 'file:///D:/Imagens/ref.png');
  $('lutPreviewImageInput').click();
  await settle(20);
  assert.equal(estado.seletoresDeImagem, base + 2, 'clique no campo somente leitura');
  $('settingsLutPreviewThumbBox').click();
  await settle(20);
  assert.equal(estado.seletoresDeImagem, base + 3, 'clique na miniatura');

  // a tela está alterada: o Enter no campo abre o seletor e NÃO dispara o salvamento dos outros campos
  assert.equal($('settingsSaveBar').classList.contains('hidden'), false);
  const enter = evento(h, 'keydown', { key: 'Enter' });
  $('lutPreviewImageInput').dispatchEvent(enter);
  await settle(20);
  assert.equal(estado.seletoresDeImagem, base + 4, 'Enter no campo');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.bds.calls.saveSettings, undefined, 'o Enter aqui não salva');
  assert.deepEqual(h.errors, []);
});

test('lista de fontes: os ícones de alterar e remover têm o nome da fonte no aria-label e no title, e o ícone é decorativo', async () => {
  const h = await montar();
  const doc = h.document;
  const edits = [...doc.querySelectorAll('.btn-edit-custom-source')];
  const dels = [...doc.querySelectorAll('.btn-delete-custom-source')];
  assert.equal(edits.length, 2);
  assert.equal(dels.length, 2);
  assert.equal(edits[0].getAttribute('aria-label'), 'Alterar a pasta de Podcast "Studio"');
  assert.equal(edits[1].getAttribute('aria-label'), 'Alterar a pasta de Câmera');
  assert.equal(dels[0].getAttribute('aria-label'), 'Remover a fonte Podcast "Studio"');
  assert.equal(dels[1].getAttribute('aria-label'), 'Remover a fonte Câmera');
  for (const b of [...edits, ...dels]) {
    assert.ok(b.getAttribute('title').includes(b.dataset.name), 'title com o nome da fonte');
    assert.equal(b.querySelector('.material-symbols-rounded').getAttribute('aria-hidden'), 'true');
  }
});
