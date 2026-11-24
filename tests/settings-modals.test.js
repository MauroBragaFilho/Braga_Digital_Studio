'use strict';

// Configurações: as duas janelas (Nova fonte e Relatar um problema) não têm mais "Cancelar".
//   - fecham por X, Esc e clique fora (o clique fora só vale se o mouse também foi pressionado fora e os campos estão vazios);
//   - nada fecha a janela enquanto o cadastro ou a geração do e-mail está em andamento;
//   - o sucesso do cadastro fica numa região aria-live do cartão (não em alerta); erros continuam em diálogo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const js = fs.readFileSync(path.join(SCREENS_DIR, 'settings.js'), 'utf8');

test('HTML e JS: nenhum Cancelar nas duas janelas; o campo principal recebe o foco ao abrir', () => {
  assert.doesNotMatch(html, /modalSettingsAddCustomSourceCancel|modalSettingsReportProblemCancel/);
  assert.doesNotMatch(js, /modalSettingsAddCustomSourceCancel|modalSettingsReportProblemCancel/);
  assert.match(html, /id="modalSettingsAddCustomSourceName"[^>]*data-autofocus/);
  assert.match(html, /id="modalSettingsReportProblemDesc"[^>]*data-autofocus/);
  // o texto do botão de confirmar é um só (antes o JS trocava "e" por "&" depois de usar o botão)
  assert.doesNotMatch(js, /Cadastrar & Importar/);
  assert.match(html, /Cadastrar e importar mídias/);
  const status = html.match(/<span id="settingsCustomSourcesStatus"[^>]*>/)?.[0] || '';
  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/);
});

test('CSS: o X travado fica discreto, só com tokens', () => {
  const css = fs.readFileSync(path.join(SCREENS_DIR, 'settings.css'), 'utf8');
  const bloco = css.match(/\.settings-modal-close\[aria-disabled="true"\]\s*\{[^}]*\}/);
  assert.ok(bloco, 'regra do X travado');
  assert.doesNotMatch(bloco[0], /#[0-9a-fA-F]{3,8}\b/);
});

// ---- Comportamento (uma montagem; o app.js é importado uma vez por processo)
const estado = { cadastros: [], travaCadastro: null, falhaCadastro: false, mailtos: [], travaMailto: null, externos: [], fontes: 0 };
let montagem = null;
function montar() {
  if (!montagem) {
    montagem = mountScreen('settings', {
      shell: true,
      bds: {
        getSettings: async () => ({}),
        getCustomSources: async () => { estado.fontes++; return [{ id: 1, name: 'Câmera', path: 'D:/Cam' }]; },
        addCustomSource: (dados) => {
          estado.cadastros.push(dados);
          if (estado.falhaCadastro) return Promise.reject(new Error('pasta inválida'));
          return estado.travaCadastro ? estado.travaCadastro.promise : Promise.resolve();
        },
        generateManualMailto: (descricao) => {
          estado.mailtos.push(descricao);
          return estado.travaMailto ? estado.travaMailto.promise : Promise.resolve('mailto:suporte@exemplo.test?body=x');
        },
        openExternal: async (url) => { estado.externos.push(url); }
      }
    });
  }
  return montagem;
}
test.after(async () => { if (montagem) await (await montagem).cleanup(); });

const evento = (h, tipo, props = {}) => Object.assign(new h.window.Event(tipo, { bubbles: true, cancelable: true }), props);
const trava = () => { const t = {}; t.promise = new Promise((resolve, reject) => { t.resolve = resolve; t.reject = reject; }); return t; };

function apoio(h) {
  const doc = h.document;
  const $ = (id) => doc.getElementById(id);
  return {
    $,
    aberta: (id) => !$(id).classList.contains('hidden') && $(id).classList.contains('active'),
    esc: (alvo) => alvo.dispatchEvent(evento(h, 'keydown', { key: 'Escape' })),
    // clique fora como o navegador faz: botão pressionado e solto no fundo (mousedown + click no mesmo alvo)
    cliqueFora: (id) => { $(id).dispatchEvent(evento(h, 'mousedown')); $(id).dispatchEvent(evento(h, 'click')); },
    digitar: (id, valor) => { $(id).value = valor; $(id).dispatchEvent(evento(h, 'input')); }
  };
}

const JANELAS = [
  { nome: 'Nova fonte', id: 'modalSettingsAddCustomSource', abrir: 'btnSettingsAddCustomSource', fechar: 'btnCloseSettingsCustomSourceModal', campos: ['modalSettingsAddCustomSourceName', 'modalSettingsAddCustomSourcePath'], foco: 'modalSettingsAddCustomSourceName' },
  { nome: 'Relatar um problema', id: 'modalSettingsReportProblem', abrir: 'reportProblemButton', fechar: 'btnCloseSettingsReportProblem', campos: ['modalSettingsReportProblemDesc'], foco: 'modalSettingsReportProblemDesc' }
];

test('as duas janelas viram diálogos acessíveis e abrem pelo botão do cartão', async () => {
  const h = await montar();
  await settle(60);
  const { $, aberta } = apoio(h);
  for (const j of JANELAS) {
    assert.equal($(j.id).getAttribute('role'), 'dialog');
    assert.equal($(j.id).getAttribute('aria-modal'), 'true');
    assert.equal($(j.id).dataset.a11yModal, '1', `${j.nome}: enhanceModalOverlay aplicado`);
    assert.equal(aberta(j.id), false);
    assert.equal($(j.id).querySelector('[id*="Cancel"]'), null);
    $(j.abrir).click();
    assert.equal(aberta(j.id), true, `${j.nome}: abre`);
    $(j.fechar).click();
    assert.equal(aberta(j.id), false, `${j.nome}: o X fecha`);
  }
  assert.deepEqual(h.errors, []);
});

test('o foco vai para o campo principal ao abrir (não para o X, o primeiro botão do diálogo)', async () => {
  const h = await montar();
  const { $ } = apoio(h);
  const proto = h.window.Element.prototype;
  const antesRects = proto.getClientRects;
  const antesFocus = proto.focus;
  const focados = [];
  proto.getClientRects = () => [{}]; // o linkedom não calcula layout: tudo conta como visível
  proto.focus = function focar() { focados.push(this.id); };
  try {
    for (const j of JANELAS) {
      focados.length = 0;
      $(j.abrir).click();
      await settle(30);
      assert.deepEqual(focados, [j.foco], `${j.nome}: foco no campo principal`);
      $(j.fechar).click();
      await settle(10);
    }
  } finally { proto.getClientRects = antesRects; proto.focus = antesFocus; }
});

test('Esc fecha as duas janelas, sem propagar para o resto da tela', async () => {
  const h = await montar();
  const { $, aberta, esc } = apoio(h);
  let vazou = 0;
  h.document.addEventListener('keydown', () => { vazou++; });
  for (const j of JANELAS) {
    $(j.abrir).click();
    const antes = vazou;
    esc($(j.foco));
    assert.equal(aberta(j.id), false, `${j.nome}: Esc fecha`);
    assert.equal(vazou, antes, `${j.nome}: o Esc não sobe para ouvintes de fora da janela`);
  }
});

test('clique fora: fecha só com campos vazios e só se o mouse também foi pressionado fora', async () => {
  const h = await montar();
  const { $, aberta, cliqueFora, digitar } = apoio(h);
  for (const j of JANELAS) {
    $(j.abrir).click();
    // clique "sozinho" (sem o botão ter sido pressionado no fundo): nada
    $(j.id).dispatchEvent(evento(h, 'click'));
    assert.equal(aberta(j.id), true, `${j.nome}: click sem mousedown no fundo não fecha`);
    // arrastar para selecionar texto dentro da janela e soltar fora: o mousedown foi dentro
    $(j.foco).dispatchEvent(evento(h, 'mousedown'));
    $(j.id).dispatchEvent(evento(h, 'click'));
    assert.equal(aberta(j.id), true, `${j.nome}: seleção que termina fora não fecha`);
    // um clique de verdade fora, com a janela já "limpa" e depois de um arrasto anterior: fecha
    cliqueFora(j.id);
    assert.equal(aberta(j.id), false, `${j.nome}: clique fora com campos vazios fecha`);

    // com texto digitado, o clique fora não apaga nada
    $(j.abrir).click();
    digitar(j.campos[0], 'algo digitado');
    cliqueFora(j.id);
    assert.equal(aberta(j.id), true, `${j.nome}: com campo preenchido o clique fora não fecha`);
    assert.equal($(j.campos[0]).value, 'algo digitado');
    // o X continua fechando mesmo com texto
    $(j.fechar).click();
    assert.equal(aberta(j.id), false);
    digitar(j.campos[0], '');
    // espaços não contam como conteúdo
    $(j.abrir).click();
    digitar(j.campos[0], '   ');
    cliqueFora(j.id);
    assert.equal(aberta(j.id), false, `${j.nome}: só espaços conta como vazio`);
  }
});

test('Nova fonte: durante o cadastro nada fecha a janela; no fim ela fecha, limpa os campos e o sucesso vai para a região do cartão', async () => {
  const h = await montar();
  const { $, aberta, esc, cliqueFora, digitar } = apoio(h);
  const alertas = h.dialogs.alerts.length;
  const leituras = estado.fontes;
  $('btnSettingsAddCustomSource').click();
  digitar('modalSettingsAddCustomSourceName', 'Podcast');
  digitar('modalSettingsAddCustomSourcePath', 'D:/Pod');
  estado.travaCadastro = trava();
  $('modalSettingsAddCustomSourceConfirm').click();
  await settle(10);

  const confirmar = $('modalSettingsAddCustomSourceConfirm');
  assert.deepEqual(estado.cadastros.at(-1), { name: 'Podcast', folderPath: 'D:/Pod' });
  assert.equal(confirmar.disabled, true);
  assert.equal(confirmar.getAttribute('aria-busy'), 'true');
  assert.match(confirmar.textContent, /Indexando/);
  assert.equal($('btnCloseSettingsCustomSourceModal').getAttribute('aria-disabled'), 'true');
  $('btnCloseSettingsCustomSourceModal').click();
  esc($('modalSettingsAddCustomSourceName'));
  cliqueFora('modalSettingsAddCustomSource');
  assert.equal(aberta('modalSettingsAddCustomSource'), true, 'em andamento: X, Esc e clique fora não fecham');

  estado.travaCadastro.resolve();
  estado.travaCadastro = null;
  await settle(30);
  assert.equal(aberta('modalSettingsAddCustomSource'), false, 'terminou: fecha');
  assert.equal($('modalSettingsAddCustomSourceName').value, '');
  assert.equal($('modalSettingsAddCustomSourcePath').value, '');
  assert.equal($('btnCloseSettingsCustomSourceModal').hasAttribute('aria-disabled'), false);
  assert.equal(confirmar.disabled, false);
  assert.equal(confirmar.hasAttribute('aria-busy'), false);
  assert.match(confirmar.textContent.replace(/\s+/g, ' ').trim(), /Cadastrar e importar mídias$/, 'texto de volta ao original, igual ao do HTML');
  assert.ok(estado.fontes > leituras, 'a lista de fontes foi relida');
  assert.match($('settingsCustomSourcesStatus').textContent, /Fonte "Podcast" cadastrada/);
  assert.equal(h.dialogs.alerts.length, alertas, 'o sucesso não abre alerta');
  // abrir a janela de novo limpa a mensagem anterior
  $('btnSettingsAddCustomSource').click();
  assert.equal($('settingsCustomSourcesStatus').textContent, '');
  $('btnCloseSettingsCustomSourceModal').click();
  assert.deepEqual(h.errors, []);
});

test('Nova fonte: validação e erro continuam em diálogo, a janela fica aberta com o que foi digitado e destravada', async () => {
  const h = await montar();
  const { $, aberta, digitar, cliqueFora } = apoio(h);
  const cadastros = estado.cadastros.length;
  $('btnSettingsAddCustomSource').click();
  $('modalSettingsAddCustomSourceConfirm').click();
  await settle(10);
  assert.match(h.dialogs.alerts.at(-1), /nome desejado/);
  digitar('modalSettingsAddCustomSourceName', 'Sony');
  $('modalSettingsAddCustomSourceConfirm').click();
  await settle(10);
  assert.match(h.dialogs.alerts.at(-1), /selecione a pasta/i);
  assert.equal(estado.cadastros.length, cadastros, 'sem cadastro enquanto faltar dado');

  digitar('modalSettingsAddCustomSourcePath', 'D:/Sony');
  estado.falhaCadastro = true;
  $('modalSettingsAddCustomSourceConfirm').click();
  await settle(30);
  estado.falhaCadastro = false;
  assert.match(h.dialogs.alerts.at(-1), /Não foi possível cadastrar a fonte/);
  assert.equal(aberta('modalSettingsAddCustomSource'), true);
  assert.equal($('modalSettingsAddCustomSourceName').value, 'Sony');
  assert.equal($('modalSettingsAddCustomSourceConfirm').disabled, false);
  assert.equal($('btnCloseSettingsCustomSourceModal').hasAttribute('aria-disabled'), false, 'X liberado depois do erro');
  assert.equal($('settingsCustomSourcesStatus').textContent, '', 'erro não deixa mensagem de sucesso');
  cliqueFora('modalSettingsAddCustomSource');
  assert.equal(aberta('modalSettingsAddCustomSource'), true, 'com texto digitado o clique fora não fecha');
  $('btnCloseSettingsCustomSourceModal').click();
  assert.equal(aberta('modalSettingsAddCustomSource'), false);
  digitar('modalSettingsAddCustomSourceName', '');
  digitar('modalSettingsAddCustomSourcePath', '');
});

test('Relatar um problema: descrição vazia avisa e mantém a janela; durante a geração nada fecha; depois abre o e-mail e limpa', async () => {
  const h = await montar();
  const { $, aberta, esc, cliqueFora, digitar } = apoio(h);
  $('reportProblemButton').click();
  $('modalSettingsReportProblemConfirm').click();
  await settle(10);
  assert.match(h.dialogs.alerts.at(-1), /descreva o problema/);
  assert.equal(aberta('modalSettingsReportProblem'), true);
  assert.equal(estado.mailtos.length, 0);

  digitar('modalSettingsReportProblemDesc', 'O app travou ao exportar');
  estado.travaMailto = trava();
  $('modalSettingsReportProblemConfirm').click();
  await settle(10);
  assert.deepEqual(estado.mailtos, ['O app travou ao exportar']);
  assert.equal($('modalSettingsReportProblemConfirm').disabled, true);
  assert.match($('modalSettingsReportProblemConfirm').textContent, /Gerando/);
  assert.equal($('btnCloseSettingsReportProblem').getAttribute('aria-disabled'), 'true');
  $('btnCloseSettingsReportProblem').click();
  esc($('modalSettingsReportProblemDesc'));
  cliqueFora('modalSettingsReportProblem');
  assert.equal(aberta('modalSettingsReportProblem'), true, 'em andamento: X, Esc e clique fora não fecham');

  estado.travaMailto.resolve('mailto:suporte@exemplo.test?body=abc');
  estado.travaMailto = null;
  await settle(30);
  assert.equal(aberta('modalSettingsReportProblem'), false);
  assert.equal($('modalSettingsReportProblemDesc').value, '');
  assert.deepEqual(estado.externos, ['mailto:suporte@exemplo.test?body=abc']);
  assert.equal($('modalSettingsReportProblemConfirm').disabled, false);
  assert.equal($('btnCloseSettingsReportProblem').hasAttribute('aria-disabled'), false);
  assert.match($('modalSettingsReportProblemConfirm').textContent.replace(/\s+/g, ' '), /Gerar e-mail de suporte/);
  assert.deepEqual(h.errors, []);
});

test('Relatar um problema: sem endereço gerado, avisa e deixa a janela aberta com o texto', async () => {
  const h = await montar();
  const { $, aberta, digitar } = apoio(h);
  $('reportProblemButton').click();
  digitar('modalSettingsReportProblemDesc', 'Texto que não pode se perder');
  estado.travaMailto = { promise: Promise.resolve('') };
  $('modalSettingsReportProblemConfirm').click();
  await settle(30);
  estado.travaMailto = null;
  assert.match(h.dialogs.alerts.at(-1), /Não foi possível gerar o e-mail de suporte/);
  assert.equal(aberta('modalSettingsReportProblem'), true);
  assert.equal($('modalSettingsReportProblemDesc').value, 'Texto que não pode se perder');
  assert.equal($('btnCloseSettingsReportProblem').hasAttribute('aria-disabled'), false);
  $('btnCloseSettingsReportProblem').click();
  digitar('modalSettingsReportProblemDesc', '');
});

test('o aviso de alterações não salvas continua sem o X e não é afetado', () => {
  assert.equal(/id="btnCloseSettingsLeave/.test(html), false);
  assert.match(js, /enhanceModalOverlay\(modal,/);
  // só as duas janelas passam pelo helper; o aviso de saída segue com o Esc próprio
  assert.equal((js.match(/= setupDismissibleModal\(modal,/g) || []).length, 2);
});
