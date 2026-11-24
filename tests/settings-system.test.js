'use strict';

// Configurações > Sistema:
//   - "Relatórios de erros" e "Diagnóstico e suporte" viraram um cartão só; o menu "⋯" guarda "Apagar relatórios
//     guardados" e "Exportar logs de diagnóstico", e "Relatar um problema" e "Enviar relatórios" ficam fora do menu;
//   - Enviar e Apagar relatórios só existem com relatórios guardados (somem, não ficam desabilitados) e o foco nunca se perde;
//   - o armazenamento é relido sozinho (não há "Atualizar"); a lista por tipo mora em "Detalhes por tipo de arquivo" e é pesquisável;
//   - sucesso e "nada a fazer" ficam escritos no cartão (região aria-live), com o caminho do log exportado à vista;
//     erros e confirmações destrutivas continuam em diálogo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { mountScreen, settle, SCREENS_DIR } = require('./helpers/renderer-harness');

const html = fs.readFileSync(path.join(SCREENS_DIR, 'settings.html'), 'utf8');
const css = fs.readFileSync(path.join(SCREENS_DIR, 'settings.css'), 'utf8');
const js = fs.readFileSync(path.join(SCREENS_DIR, 'settings.js'), 'utf8');
const { document: staticDoc } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

// ------------------------------------------------------------------ estrutura (HTML)

test('Erros e suporte: um cartão só, com o menu "⋯" acessível e os botões certos dentro e fora dele', () => {
  const panel = staticDoc.querySelector('#settingsSystemView [data-sub-panel="support"]');
  const cards = [...panel.querySelectorAll('.st-card')];
  assert.equal(cards.length, 1, 'um cartão só');
  const title = cards[0].querySelector('.st-card-title').textContent.replace(/\s+/g, ' ').trim();
  assert.match(title, /Relatórios de erros e suporte$/);
  assert.doesNotMatch(panel.textContent, /no botão abaixo/, 'o texto não aponta para um botão que pode não existir');

  // o menu: botão com aria-haspopup/aria-expanded/aria-controls e nome acessível; lista com role=menu
  const trigger = staticDoc.getElementById('supportMenuButton');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('aria-controls'), 'supportMenu');
  assert.ok(trigger.getAttribute('aria-label'));
  assert.ok(trigger.getAttribute('title'));
  assert.equal(trigger.closest('.st-card-title'), null, 'o botão não faz parte do título do cartão');
  const menu = staticDoc.getElementById('supportMenu');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.getAttribute('aria-labelledby'), 'supportMenuButton');
  assert.ok(menu.classList.contains('hidden'), 'menu fechado no início');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(items.map((i) => i.id), ['clearCrashReportsButton', 'exportLogsButton']);
  assert.deepEqual(items.map((i) => i.textContent.replace(/\s+/g, ' ').trim().replace(/^\w+ /, '')), ['Apagar relatórios guardados', 'Exportar logs de diagnóstico']);
  assert.ok(items[0].classList.contains('hidden'), 'apagar começa escondido: não há relatórios até a leitura terminar');
  assert.equal(menu.querySelectorAll('button').length, 2);

  // fora do menu: Enviar relatórios (escondido até haver relatórios) e Relatar um problema
  for (const id of ['sendCrashReportsButton', 'reportProblemButton']) {
    assert.equal(menu.contains(staticDoc.getElementById(id)), false, `${id} fica fora do menu`);
    assert.ok(cards[0].contains(staticDoc.getElementById(id)), id);
  }
  assert.ok(staticDoc.getElementById('sendCrashReportsButton').classList.contains('hidden'));
  assert.equal(staticDoc.getElementById('reportProblemButton').classList.contains('hidden'), false);
  assert.equal(staticDoc.getElementById('sendCrashReportsLabel').textContent.trim(), 'Enviar relatórios');
  // ícones decorativos: o nome do botão é só o texto
  for (const icon of cards[0].querySelectorAll('button .material-symbols-rounded')) assert.equal(icon.getAttribute('aria-hidden'), 'true');

  // o resultado das ações fica numa região aria-live do cartão (não no resumo, que é reescrito ao reler)
  const result = staticDoc.getElementById('supportResult');
  assert.equal(result.getAttribute('role'), 'status');
  assert.equal(result.getAttribute('aria-live'), 'polite');
  assert.ok(cards[0].contains(result));
  assert.equal(staticDoc.getElementById('crashReportsSummary').contains(result), false);
  // quem procura "exportar logs" ou "apagar relatórios" na busca acha o cartão: o texto está numa linha (.st-row)
  const row = [...cards[0].querySelectorAll('.st-row')].find((r) => /Exportar os logs de diagnóstico|exportar os logs de diagnóstico/i.test(r.textContent));
  assert.ok(row && /apagar os relatórios guardados/i.test(row.textContent));
});

test('Armazenamento: sem "Atualizar"; a lista por tipo fica em "Detalhes por tipo de arquivo" recolhido; o resultado fica fora do bloco', () => {
  assert.equal(staticDoc.getElementById('refreshCacheButton'), null);
  assert.doesNotMatch(js, /refreshCacheButton/);
  const card = staticDoc.getElementById('cacheTotalSize').closest('.st-card');
  const adv = staticDoc.getElementById('cacheAdvanced');
  assert.ok(adv && adv.matches('details.st-advanced') && card.contains(adv));
  assert.equal(adv.hasAttribute('open'), false);
  assert.equal(adv.querySelector('summary').textContent.trim(), 'Detalhes por tipo de arquivo');
  assert.ok(adv.contains(staticDoc.getElementById('cacheCategoriesList')));
  const result = staticDoc.getElementById('cacheResult');
  assert.equal(adv.contains(result), false, 'o resultado de limpar não pode ficar escondido num bloco recolhido');
  assert.equal(result.getAttribute('role'), 'status');
  assert.equal(result.getAttribute('aria-live'), 'polite');
  // "Limpar tudo" continua visível, fora do bloco
  const all = staticDoc.getElementById('clearCacheButton');
  assert.ok(all && card.contains(all) && !adv.contains(all));
  // o texto de carregamento está numa linha pesquisável
  assert.ok(adv.querySelector('#cacheCategoriesList .st-row'));
});

test('Zona de perigo: o resultado de limpar o banco fica numa região aria-live do cartão', () => {
  const result = staticDoc.getElementById('dbResult');
  assert.equal(result.getAttribute('role'), 'status');
  assert.equal(result.getAttribute('aria-live'), 'polite');
  assert.ok(staticDoc.getElementById('clearDbButton').closest('.st-card').contains(result));
});

test('CSS do menu e dos resultados: só tokens, sem peso acima de 600 e foco visível', () => {
  const from = css.indexOf('/* Cartão com menu "⋯"');
  const block = css.slice(from);
  assert.ok(from > 0 && block.length > 500);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'sem hex solto');
  assert.doesNotMatch(block, /rgba?\(/, 'sem cor solta');
  assert.doesNotMatch(block, /font-weight:\s*(7|8|9)00|font-weight:\s*bold/);
  assert.match(css, /\.st-icon-btn:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /\.st-menu-item:focus-visible/);
  assert.match(css, /\.st-menu\.hidden\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /settings-cache-item|settings-crash-list|settings-crash-empty/, 'sem CSS de elementos que saíram');
});

test('JS: nada de innerHTML com dado variável na lista do armazenamento e nada de alerta de sucesso nesses fluxos', () => {
  const from = js.indexOf('let cacheInfoLoad');
  const block = js.slice(from, js.indexOf('ACELERAÇÃO DE HARDWARE'));
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, /innerHTML/);
  // nenhum bdsModal.alert(...) leva texto de sucesso ou de "nada a fazer" desses cartões
  const alertas = [...js.matchAll(/bdsModal\.alert\(([^;]*);/g)].map((m) => m[1]);
  assert.ok(alertas.length > 5);
  for (const frase of ['exportados com sucesso', 'liberados', 'removido(s)', 'Basta enviar a mensagem', 'enviado(s)', 'Não há relatórios', 'O catálogo foi limpo']) {
    assert.deepEqual(alertas.filter((a) => a.includes(frase)), [], frase);
  }
});

// ------------------------------------------------------------------ comportamento (tela montada)

const ALL = ['download', 'converter', 'library', 'projects', 'upload', 'devices', 'luts', 'transcription', 'metadata', 'silence', 'ai'];
const MODULES = ALL.map((id) => ({ id, title: id, description: '', screens: [id], enabled: true, hasEngine: false, available: true }));

const CATEGORIAS = [
  { key: 'thumbnails', label: 'Miniaturas', sizeFormatted: '12 MB' },
  { key: 'waveforms', label: 'Ondas de áudio', sizeFormatted: '3 MB' }
];

/** Monta a tela com um "estado" que os testes mexem (relatórios guardados, categorias do armazenamento). */
async function montar(extra = {}) {
  const estado = { relatorios: 0, categorias: CATEGORIAS, total: '15 MB', leituras: 0 };
  const h = await mountScreen('settings', {
    init: false,
    bds: {
      modulesList: async () => ({ ok: true, data: MODULES }),
      getCrashReports: async () => Array.from({ length: estado.relatorios }, (_, i) => ({ id: i })),
      getCacheInfo: async () => { estado.leituras++; return { totalFormatted: estado.total, categories: estado.categorias, maxSizeMB: 500 }; },
      ...extra
    }
  });
  await h.mod.initScreen();
  await settle(60);
  const d = h.document;
  const $ = (id) => d.getElementById(id);
  const evento = (tipo, props = {}) => Object.assign(new h.window.Event(tipo, { bubbles: true, cancelable: true }), props);

  // linkedom não tem foco real: um "activeElement" simulado, alimentado por focus()
  const foco = { atual: null, historico: [] };
  Object.defineProperty(d, 'activeElement', { configurable: true, get: () => foco.atual });
  const proto = h.window.Element.prototype;
  const focusOriginal = proto.focus;
  proto.focus = function focar() { foco.atual = this; foco.historico.push(this.id || this.className); };

  const api = {
    h, d, $, estado, foco, evento,
    cleanup: async () => { proto.focus = focusOriginal; await h.cleanup(); },
    sub: async (nome, ms = 40) => { d.querySelector(`#settingsSystemView .st-subtab[data-sub="${nome}"]`).click(); await settle(ms); },
    oculto: (id) => $(id).classList.contains('hidden'),
    tecla: (alvo, key) => { const e = evento('keydown', { key }); alvo.dispatchEvent(e); return e; },
    linhasCache: () => [...$('cacheCategoriesList').querySelectorAll('.st-row')],
    resultado: () => $('supportResult').textContent.replace(/\s+/g, ' ').trim()
  };
  return api;
}

test('relatórios: sem nenhum, Enviar e Apagar não existem (não ficam desabilitados) e o rótulo traz o número', async () => {
  const s = await montar();
  try {
    assert.equal(s.$('crashReportsSummary').textContent, 'Nenhum relatório guardado.');
    for (const id of ['sendCrashReportsButton', 'clearCrashReportsButton']) {
      assert.equal(s.oculto(id), true, `${id} escondido sem relatórios`);
      assert.equal(s.$(id).disabled, false);
    }
    assert.equal(s.oculto('reportProblemButton'), false);

    s.estado.relatorios = 1;
    await s.sub('support');
    assert.equal(s.$('crashReportsSummary').textContent, '1 relatório guardado.');
    assert.equal(s.oculto('sendCrashReportsButton'), false);
    assert.equal(s.oculto('clearCrashReportsButton'), false);
    assert.equal(s.$('sendCrashReportsLabel').textContent, 'Enviar 1 relatório');

    s.estado.relatorios = 4;
    await s.sub('about');
    await s.sub('support');
    assert.equal(s.$('sendCrashReportsLabel').textContent, 'Enviar 4 relatórios');

    s.estado.relatorios = 0;
    await s.sub('about');
    await s.sub('support');
    assert.equal(s.oculto('sendCrashReportsButton'), true);
    assert.equal(s.oculto('clearCrashReportsButton'), true);
    assert.equal(s.$('sendCrashReportsLabel').textContent, 'Enviar relatórios');
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('foco: o botão focado que some (enviar ou apagar) passa o foco para "Relatar um problema" antes', async () => {
  const s = await montar();
  try {
    s.estado.relatorios = 2;
    await s.sub('support');
    // Enviar com o foco: ao zerar, o foco vai para Relatar um problema
    s.foco.atual = s.$('sendCrashReportsButton');
    s.estado.relatorios = 0;
    await s.sub('about');
    await s.sub('support');
    assert.equal(s.oculto('sendCrashReportsButton'), true);
    assert.equal(s.foco.atual, s.$('reportProblemButton'), 'o foco não ficou no botão escondido');

    // item do menu com o foco: o mesmo
    s.estado.relatorios = 1;
    await s.sub('about');
    await s.sub('support');
    s.foco.atual = s.$('clearCrashReportsButton');
    s.estado.relatorios = 0;
    await s.sub('about');
    await s.sub('support');
    assert.equal(s.oculto('clearCrashReportsButton'), true);
    assert.equal(s.foco.atual, s.$('reportProblemButton'));

    // botão escondido sem foco: o foco de quem está em outro lugar não é roubado
    const outro = s.$('errorReportingEnabledInput');
    s.estado.relatorios = 1;
    await s.sub('about');
    await s.sub('support');
    s.foco.atual = outro;
    s.estado.relatorios = 0;
    await s.sub('about');
    await s.sub('support');
    assert.equal(s.foco.atual, outro);
  } finally { await s.cleanup(); }
});

test('enviar relatórios: ocupado sem desabilitar, cliques repetidos ignorados e o e-mail aberto fica escrito no cartão', async () => {
  let libera;
  const espera = new Promise((resolve) => { libera = resolve; });
  const s = await montar({
    sendCrashReports: () => espera,
    openExternal: async () => {}
  });
  try {
    s.estado.relatorios = 3;
    await s.sub('support');
    const alertas = s.h.dialogs.alerts.length;
    const botao = s.$('sendCrashReportsButton');
    botao.click();
    await settle(10);
    assert.equal(botao.getAttribute('aria-busy'), 'true');
    assert.equal(botao.disabled, false, 'desabilitar tiraria o foco do botão');
    assert.equal(s.$('sendCrashReportsLabel').textContent, 'Enviando…');
    botao.click();
    assert.equal(s.h.bds.calls.sendCrashReports.length, 1, 'clique durante o envio é ignorado');

    s.estado.relatorios = 3; // continuam guardados (envio por e-mail não os apaga)
    libera({ method: 'mailto', mailto: 'mailto:suporte@exemplo.test?body=x', count: 3 });
    await settle(40);
    assert.deepEqual(s.h.bds.calls.openExternal.at(-1), ['mailto:suporte@exemplo.test?body=x']);
    assert.equal(botao.hasAttribute('aria-busy'), false);
    assert.equal(s.$('sendCrashReportsLabel').textContent, 'Enviar 3 relatórios');
    assert.match(s.resultado(), /^Abrimos o seu e-mail com o resumo dos relatórios\. Basta enviar a mensagem\.$/);
    assert.equal(s.h.dialogs.alerts.length, alertas, 'o sucesso não abre alerta');
    // a frase pede uma ação do usuário: continua na tela depois de reler os relatórios
    await s.sub('about');
    await s.sub('support');
    assert.match(s.resultado(), /Basta enviar a mensagem/);
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('enviar relatórios: envio direto (todos ou alguns), nada a enviar e erro (este em diálogo)', async () => {
  const respostas = [];
  const s = await montar({ sendCrashReports: async () => { const r = respostas.shift(); if (r instanceof Error) throw r; return r; } });
  try {
    s.estado.relatorios = 3;
    await s.sub('support');
    const alertas = s.h.dialogs.alerts.length;
    const enviar = async (resposta) => { respostas.push(resposta); s.$('sendCrashReportsButton').click(); await settle(40); };

    await enviar({ method: 'http', sent: 3, count: 3 });
    assert.equal(s.resultado(), '3 relatórios enviados. Obrigado!');
    await enviar({ method: 'http', sent: 1, count: 1 });
    assert.equal(s.resultado(), '1 relatório enviado. Obrigado!');
    await enviar({ method: 'http', sent: 2, count: 3 });
    assert.equal(s.resultado(), '2 de 3 relatórios enviados. Os demais continuam guardados para uma nova tentativa.');
    await enviar({ method: 'none' });
    assert.equal(s.resultado(), 'Não há relatórios para enviar.');
    assert.equal(s.h.dialogs.alerts.length, alertas, 'sucesso e "nada a fazer" não abrem alerta');

    await enviar(new Error('sem rede'));
    assert.equal(s.resultado(), '', 'o texto de uma tentativa anterior não fica ao lado do erro');
    assert.equal(s.h.dialogs.alerts.length, alertas + 1);
    assert.match(s.h.dialogs.alerts.at(-1), /Não foi possível enviar os relatórios/);
    assert.equal(s.$('sendCrashReportsButton').hasAttribute('aria-busy'), false);
  } finally { await s.cleanup(); }
});

test('apagar relatórios: pede confirmação, o resultado fica no cartão e os botões somem sem perder o foco', async () => {
  const s = await montar({ clearCrashReports: async () => { s.estado.relatorios = 0; return { deleted: 2 }; } });
  try {
    s.estado.relatorios = 2;
    await s.sub('support');
    // cancelar não apaga nada
    s.h.window.bdsModal.confirm = async (msg) => { s.h.dialogs.confirms.push(msg); return false; };
    s.$('clearCrashReportsButton').click();
    await settle(20);
    assert.equal((s.h.bds.calls.clearCrashReports || []).length, 0);
    assert.match(s.h.dialogs.confirms.at(-1), /Esta ação não pode ser desfeita/);
    assert.equal(s.resultado(), '');

    s.h.window.bdsModal.confirm = async (msg) => { s.h.dialogs.confirms.push(msg); return true; };
    const alertas = s.h.dialogs.alerts.length;
    s.foco.atual = s.$('supportMenuButton');
    s.$('clearCrashReportsButton').click();
    await settle(40);
    assert.equal(s.h.bds.calls.clearCrashReports.length, 1);
    assert.equal(s.resultado(), '2 relatórios removidos.');
    assert.equal(s.h.dialogs.alerts.length, alertas, 'sem alerta de sucesso');
    assert.equal(s.oculto('sendCrashReportsButton'), true);
    assert.equal(s.oculto('clearCrashReportsButton'), true);
    assert.equal(s.$('crashReportsSummary').textContent, 'Nenhum relatório guardado.');
    assert.ok(s.d.activeElement, 'o foco continua em algum controle');
  } finally { await s.cleanup(); }
});

test('exportar logs: o caminho do arquivo fica escrito no cartão, selecionável; cancelar e erro não deixam texto de sucesso', async () => {
  const respostas = [];
  const s = await montar({ exportDiagnosticLogs: async () => { const r = respostas.shift(); if (r instanceof Error) throw r; return r; } });
  try {
    await s.sub('support');
    const alertas = s.h.dialogs.alerts.length;
    const exportar = async (resposta) => { respostas.push(resposta); s.$('exportLogsButton').click(); await settle(30); };

    await exportar({ success: true, exportPath: 'D:\\Suporte\\bds-logs-2026-11-24.zip' });
    assert.equal(s.resultado(), 'Registros exportados para: D:\\Suporte\\bds-logs-2026-11-24.zip');
    const caminho = s.$('supportResult').querySelector('.st-result-path');
    assert.equal(caminho.textContent, 'D:\\Suporte\\bds-logs-2026-11-24.zip', 'o caminho vai por textContent, num trecho próprio');
    assert.equal(caminho.children.length, 0);
    assert.equal(s.h.dialogs.alerts.length, alertas, 'sem alerta de sucesso');

    await exportar({ cancelled: true });
    assert.equal(s.resultado(), '', 'cancelar: nada a dizer');
    assert.equal(s.h.dialogs.alerts.length, alertas);

    await exportar({ success: false });
    assert.equal(s.resultado(), '');
    assert.match(s.h.dialogs.alerts.at(-1), /Não foi possível exportar os registros/);

    await exportar({ success: true, exportPath: '<b>x</b>' });
    assert.equal(s.$('supportResult').querySelector('.st-result-path').textContent, '<b>x</b>');
    assert.equal(s.$('supportResult').querySelector('b'), null, 'o caminho nunca vira HTML');

    await exportar(new Error('disco cheio'));
    assert.equal(s.resultado(), '');
    assert.equal(s.h.dialogs.alerts.length, alertas + 2);
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('banco de dados: o resultado de limpar fica no cartão; cancelar também; erro continua em diálogo', async () => {
  const respostas = [];
  const s = await montar({ clearLibraryDatabase: async () => { const r = respostas.shift(); if (r instanceof Error) throw r; return r; } });
  try {
    await s.sub('danger');
    const alertas = s.h.dialogs.alerts.length;
    const limpar = async (resposta) => { respostas.push(resposta); s.$('clearDbButton').click(); await settle(40); };
    const texto = () => s.$('dbResult').textContent.trim();

    await limpar({ ok: true });
    assert.match(texto(), /^Pronto\. O catálogo foi limpo/);
    assert.equal(s.h.dialogs.alerts.length, alertas);
    await limpar(new Error('Operação cancelada pelo usuário'));
    assert.equal(texto(), 'Limpeza cancelada. Nada foi apagado.');
    assert.equal(s.h.dialogs.alerts.length, alertas);
    await limpar(new Error('banco travado'));
    assert.equal(texto(), '', 'o texto anterior não fica ao lado do erro');
    assert.match(s.h.dialogs.alerts.at(-1), /Não foi possível limpar o catálogo da biblioteca/);
    assert.equal(s.$('clearDbButton').disabled, false);
  } finally { await s.cleanup(); }
});

test('armazenamento: relido ao iniciar e ao voltar ao subpainel, sem botão Atualizar e sem piscar quando nada mudou', async () => {
  const s = await montar();
  try {
    assert.equal(s.estado.leituras >= 1, true, 'lido ao iniciar');
    assert.equal(s.$('cacheTotalSize').textContent, '15 MB');
    const linhas = s.linhasCache();
    assert.equal(linhas.length, 2);
    assert.deepEqual(linhas.map((l) => l.querySelector('.st-row-label').textContent), ['Miniaturas', 'Ondas de áudio']);
    assert.deepEqual(linhas.map((l) => l.querySelector('.st-row-hint').textContent), ['12 MB', '3 MB']);
    const botoes = [...s.$('cacheCategoriesList').querySelectorAll('button[data-clear-cache]')];
    assert.deepEqual(botoes.map((b) => b.dataset.clearCache), ['thumbnails', 'waveforms']);
    assert.deepEqual(botoes.map((b) => b.getAttribute('aria-label')), ['Limpar Miniaturas', 'Limpar Ondas de áudio']);
    assert.equal(botoes[0].querySelector('.material-symbols-rounded').getAttribute('aria-hidden'), 'true');

    // voltar ao subpainel relê; os mesmos dados não redesenham a lista (os nós são os mesmos)
    const antes = s.estado.leituras;
    await s.sub('support');
    await s.sub('about');
    assert.equal(s.estado.leituras, antes + 1, 'relê ao voltar para "Sobre e armazenamento"');
    assert.equal(s.linhasCache()[0], linhas[0], 'nada mudou: a lista não foi refeita');
    assert.doesNotMatch(s.$('cacheCategoriesList').textContent, /Calculando|Carregando/);

    // mudou: a lista acompanha
    s.estado.categorias = [{ key: 'thumbnails', label: 'Miniaturas', sizeFormatted: '1 MB' }];
    s.estado.total = '1 MB';
    await s.sub('support');
    await s.sub('about');
    assert.equal(s.$('cacheTotalSize').textContent, '1 MB');
    assert.equal(s.linhasCache().length, 1);
    assert.equal(s.linhasCache()[0].querySelector('.st-row-hint').textContent, '1 MB');

    // várias trocas seguidas dividem a mesma leitura
    const antes2 = s.estado.leituras;
    for (let i = 0; i < 3; i++) { s.d.querySelector('#settingsSystemView .st-subtab[data-sub="support"]').click(); s.d.querySelector('#settingsSystemView .st-subtab[data-sub="about"]').click(); }
    await settle(40);
    assert.equal(s.estado.leituras, antes2 + 1);
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('armazenamento: nomes vêm como texto (nunca HTML) e falhas viram uma linha de aviso', async () => {
  const s = await montar({ getCacheInfo: async () => ({ totalFormatted: '1 MB', categories: [{ key: 'x"y', label: '<img src=x>', sizeFormatted: '<b>1</b>' }] }) });
  try {
    assert.equal(s.$('cacheCategoriesList').querySelector('img'), null);
    assert.equal(s.$('cacheCategoriesList').querySelector('b'), null);
    assert.equal(s.linhasCache()[0].querySelector('.st-row-label').textContent, '<img src=x>');
    assert.equal(s.$('cacheCategoriesList').querySelector('button').getAttribute('aria-label'), 'Limpar <img src=x>');
    s.h.bds.set('getCacheInfo', async () => { throw new Error('disco ocupado'); });
    await s.sub('support');
    await s.sub('about');
    assert.match(s.$('cacheCategoriesList').textContent, /Não foi possível ler o armazenamento/);
    assert.equal(s.linhasCache().length, 1);
    assert.equal(s.$('cacheCategoriesList').querySelector('button'), null);
    // voltou a funcionar: a lista volta
    s.h.bds.set('getCacheInfo', async () => ({ totalFormatted: '2 MB', categories: CATEGORIAS }));
    await s.sub('support');
    await s.sub('about');
    assert.equal(s.linhasCache().length, 2);
  } finally { await s.cleanup(); }
});

test('limpar por tipo e limpar tudo: confirma, escreve o resultado no cartão (sem alerta), relê e devolve o foco', async () => {
  const s = await montar({ clearCache: async () => ({ totalFormatted: '12 MB' }) });
  try {
    const alertas = s.h.dialogs.alerts.length;
    const botao = () => s.$('cacheCategoriesList').querySelector('button[data-clear-cache="thumbnails"]');
    const antes = s.estado.leituras;
    s.foco.atual = botao();
    botao().click();
    await settle(60);
    assert.deepEqual(s.h.bds.calls.clearCache.at(-1), ['thumbnails']);
    assert.match(s.h.dialogs.confirms.at(-1), /Limpar "Miniaturas"\?/);
    assert.match(s.$('cacheResult').textContent, /^Concluído: 12 MB liberados\. \(\d{2}:\d{2}\)$/);
    assert.equal(s.h.dialogs.alerts.length, alertas, 'o sucesso não abre alerta');
    assert.ok(s.estado.leituras > antes, 'relê depois de limpar');
    assert.equal(s.foco.atual, botao(), 'o foco volta ao botão equivalente da lista refeita');
    assert.equal(botao().disabled, false);

    // limpar tudo
    s.foco.atual = s.$('clearCacheButton');
    s.$('clearCacheButton').click();
    await settle(60);
    assert.deepEqual(s.h.bds.calls.clearCache.at(-1), [null]);
    assert.match(s.h.dialogs.confirms.at(-1), /Limpar todo o armazenamento temporário/);
    assert.match(s.$('cacheResult').textContent, /Concluído: 12 MB liberados/);
    assert.equal(s.foco.atual, s.$('clearCacheButton'));
    assert.equal(s.h.dialogs.alerts.length, alertas);

    // cancelar a confirmação não limpa nada
    s.h.window.bdsModal.confirm = async () => false;
    const limpezas = s.h.bds.calls.clearCache.length;
    s.$('clearCacheButton').click();
    await settle(20);
    assert.equal(s.h.bds.calls.clearCache.length, limpezas);
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('limpar: a falha continua em diálogo e o botão volta ao normal', async () => {
  const s = await montar({ clearCache: async () => { throw new Error('arquivo em uso'); } });
  try {
    const alertas = s.h.dialogs.alerts.length;
    s.$('cacheCategoriesList').querySelector('button[data-clear-cache]').click();
    await settle(60);
    assert.equal(s.h.dialogs.alerts.length, alertas + 1);
    assert.match(s.h.dialogs.alerts.at(-1), /Não foi possível limpar "Miniaturas"/);
    assert.equal(s.$('cacheResult').textContent, 'Não foi possível limpar.');
    assert.equal(s.$('clearCacheButton').disabled, false);
    for (const b of s.$('cacheCategoriesList').querySelectorAll('button')) assert.equal(b.disabled, false);
  } finally { await s.cleanup(); }
});

test('busca: o nome de um tipo de arquivo acha o cartão e abre "Detalhes por tipo de arquivo"; limpar a busca fecha de novo', async () => {
  const s = await montar();
  try {
    const caixa = s.$('settingsSearch');
    const adv = s.$('cacheAdvanced');
    assert.equal(adv.open, false);
    caixa.value = 'miniaturas';
    caixa.dispatchEvent(s.evento('input'));
    assert.equal(adv.open, true, 'a busca abre o bloco recolhido');
    assert.equal(adv.dataset.searchOpened, '1');
    assert.equal(s.d.getElementById('settingsSystemView').classList.contains('hidden'), false);
    assert.equal(adv.closest('.st-card').classList.contains('st-filtered'), false);
    const [linha] = s.linhasCache();
    assert.equal(linha.classList.contains('st-filtered'), false);
    assert.equal(s.linhasCache()[1].classList.contains('st-filtered'), true, 'só a linha que combina fica');

    // as ações do menu também se acham pelo texto do cartão
    caixa.value = 'exportar os logs';
    caixa.dispatchEvent(s.evento('input'));
    const suporte = s.$('supportMenuButton').closest('.st-card');
    assert.equal(suporte.classList.contains('st-filtered'), false);
    assert.equal(s.d.getElementById('settingsSystemView').classList.contains('hidden'), false);

    caixa.value = '';
    caixa.dispatchEvent(s.evento('input'));
    assert.equal(adv.open, false);
    assert.equal(adv.hasAttribute('data-search-opened'), false);
  } finally { await s.cleanup(); }
});

test('menu "⋯": abre e fecha com clique, setas, Esc, Tab e clique fora; o foco acompanha e aria-expanded também', async () => {
  const s = await montar();
  try {
    await s.sub('support');
    const botao = s.$('supportMenuButton');
    const menu = s.$('supportMenu');
    const exportar = s.$('exportLogsButton');
    assert.equal(menu.classList.contains('hidden'), true);

    // clique abre, com o foco no primeiro item visível (apagar está escondido: sem relatórios)
    botao.click();
    assert.equal(menu.classList.contains('hidden'), false);
    assert.equal(botao.getAttribute('aria-expanded'), 'true');
    assert.equal(s.foco.atual, exportar);
    // Esc fecha, devolve o foco ao botão e não sobe para o resto da tela
    let vazou = 0;
    s.d.addEventListener('keydown', () => { vazou++; });
    const e = s.tecla(exportar, 'Escape');
    assert.equal(e.defaultPrevented, true);
    assert.equal(vazou, 0);
    assert.equal(menu.classList.contains('hidden'), true);
    assert.equal(botao.getAttribute('aria-expanded'), 'false');
    assert.equal(s.foco.atual, botao);

    // com relatórios há dois itens; setas dão a volta, Home e End vão às pontas
    s.estado.relatorios = 2;
    await s.sub('about');
    await s.sub('support');
    s.tecla(botao, 'ArrowDown');
    assert.equal(menu.classList.contains('hidden'), false);
    const apagar = s.$('clearCrashReportsButton');
    assert.equal(s.foco.atual, apagar);
    s.tecla(apagar, 'ArrowDown');
    assert.equal(s.foco.atual, exportar);
    s.tecla(exportar, 'ArrowDown');
    assert.equal(s.foco.atual, apagar, 'dá a volta');
    s.tecla(apagar, 'ArrowUp');
    assert.equal(s.foco.atual, exportar, 'dá a volta ao contrário');
    s.tecla(exportar, 'Home');
    assert.equal(s.foco.atual, apagar);
    s.tecla(apagar, 'End');
    assert.equal(s.foco.atual, exportar);
    // Tab fecha o menu (o foco volta ao botão e o Tab segue dali)
    s.tecla(exportar, 'Tab');
    assert.equal(menu.classList.contains('hidden'), true);
    assert.equal(s.foco.atual, botao);

    // seta para cima no botão abre no último item
    s.tecla(botao, 'ArrowUp');
    assert.equal(s.foco.atual, exportar);
    // clicar no botão de novo fecha
    botao.click();
    assert.equal(menu.classList.contains('hidden'), true);

    // clique fora fecha sem roubar o foco; clique dentro do menu não conta como "fora"
    botao.click();
    s.foco.atual = null;
    // o ouvinte é de captura no document (o contêiner da tela barra o clique na subida); o linkedom não tem captura,
    // então o clique chega direto ao document, como chegaria na fase de captura
    assert.match(js, /document\.addEventListener\('click', onOutside, true\)/);
    s.d.dispatchEvent(s.evento('click'));
    assert.equal(menu.classList.contains('hidden'), true, 'clique fora fecha');
    assert.equal(botao.getAttribute('aria-expanded'), 'false');
    assert.equal(s.foco.atual, null, 'clique fora não move o foco');

    // escolher um item fecha o menu ANTES de ele agir: o foco já está no botão quando o item executa
    botao.click();
    const ordem = [];
    s.h.window.bdsModal.confirm = async () => { ordem.push(`menu ${menu.classList.contains('hidden') ? 'fechado' : 'aberto'}, foco ${s.foco.atual === botao ? 'no botão' : 'em outro lugar'}`); return false; };
    apagar.click();
    await settle(20);
    assert.deepEqual(ordem, ['menu fechado, foco no botão']);
    assert.equal(botao.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(s.h.errors, []);
  } finally { await s.cleanup(); }
});

test('setVisible e setResult: helpers com um consumidor real cada e sem innerHTML', () => {
  assert.match(js, /function setVisible\(el, visible, fallback\)/);
  assert.equal((js.match(/setVisible\(document\.getElementById\('(send|clear)CrashReportsButton'\)/g) || []).length, 2);
  const bloco = js.slice(js.indexOf('function setResult('), js.indexOf('function setupOverflowMenu('));
  assert.doesNotMatch(bloco, /innerHTML/);
  assert.match(bloco, /span\.textContent = detail/);
});
