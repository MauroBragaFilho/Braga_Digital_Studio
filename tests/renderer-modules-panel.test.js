'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const PANEL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'components', 'modules-panel.js')).href;
let seq = 0;

/** Botão "Instalar" (o texto do botão inclui o nome do ícone, por isso termina com a palavra). */
const installBtn = (host) => [...host.querySelectorAll('button')].find((b) => /(^|[a-z_])Instalar$/.test(b.textContent.trim()) && !/Reinstalar/.test(b.textContent));

const MODELS = [
  ['tiny', 'Tiny', 5, 1, 32e6, 'Mais rápido e leve'],
  ['base', 'Base', 4, 2, 60e6, 'Pouco melhor que o Tiny'],
  ['small', 'Small', 3, 3, 190e6, 'Equilíbrio entre desempenho e precisão (melhor em CPU)'],
  ['medium', 'Medium', 2, 4, 539e6, 'Boa precisão'],
  ['large-v3', 'Large v3', 1, 5, 1081e6, 'Precisão máxima (recomendado GPU)'],
  ['large-v3-turbo', 'Large v3 Turbo', 4, 5, 574e6, 'Precisão e velocidade (recomendado GPU)']
];

function makeStatus({ engine = false, installedModels = [], active = null, cuda = false } = {}) {
  return {
    platformSupported: true, busy: false, disk: { freeBytes: 50e9 },
    whisper: {
      ready: engine && Boolean(active),
      engine: { installed: engine, downloadBytes: 8e6 },
      cuda: { installed: cuda, available: true, approxDownloadBytes: 640e6, licenseLinks: [{ label: 'x', url: 'https://docs.nvidia.com/cuda/eula/index.html' }] },
      models: MODELS.map(([id, label, speedLevel, quality, sizeBytes, description]) => ({
        id, label, speedLevel, quality, sizeBytes, description,
        installed: installedModels.includes(id), active: id === active, sizeOnDisk: installedModels.includes(id) ? sizeBytes : 0
      }))
    }
  };
}

async function mountPanel(statusRef, { nvidia = false, extra = {} } = {}) {
  const calls = [];
  const h = await mountScreen('luts', {
    init: false,
    bds: {
      getHardwareInfo: async () => ({ gpus: nvidia ? [{ vendor: 'nvidia', name: 'GeForce' }] : [{ vendor: 'intel', name: 'UHD' }] }),
      modulesGetStatus: async () => ({ ok: true, data: statusRef.value }),
      modulesInstallEngine: async (o) => { calls.push(['engine', o]); statusRef.value = makeStatus({ engine: true }); return { ok: true, data: statusRef.value }; },
      modulesInstallCuda: async (o) => { calls.push(['cuda', o]); statusRef.value = makeStatus({ engine: true, cuda: true }); return { ok: true, data: statusRef.value }; },
      modulesInstallModel: async (id) => { calls.push(['model', id]); return { ok: true, data: statusRef.value }; },
      modulesRemoveModel: async (id) => { calls.push(['removeModel', id]); return { ok: true, data: statusRef.value }; },
      modulesSetActiveModel: async (id) => { calls.push(['use', id]); return { ok: true, data: statusRef.value }; },
      ...extra
    }
  });
  const host = h.document.createElement('div');
  h.document.body.append(host);
  const mod = await import(`${PANEL}?t=${++seq}`);
  await mod.mountModulesPanel(host);
  await settle(30);
  return { h, host, calls, mod };
}

test('painel: sem instalar há um botão "Instalar" e nada de motor/GPU separados', async () => {
  const ref = { value: makeStatus() };
  const { h, host } = await mountPanel(ref);
  const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent.trim());
  assert.ok(installBtn(host), buttons.join('|'));
  assert.ok(!host.textContent.includes('Aceleração por GPU'), 'não deve ter seção de GPU separada');
  assert.ok(!/checkbox/.test(host.innerHTML), 'sem caixa de aceite separada');
  await h.cleanup();
});

// ------------------------------------------------------------------ lista de escolha de modelos (D10)

const choices = (host) => [...host.querySelectorAll('.mod-choice')];
const radios = (host) => [...host.querySelectorAll('.mod-choice input[type="radio"]')];
const checkedId = (host) => (radios(host).find((r) => r.checked) || {}).value || null;
/** Botão contextual "Baixar <nome> (<tamanho>)": o texto inclui o nome do ícone, por isso a busca é pelo trecho. */
const downloadBtns = (host) => [...host.querySelectorAll('button')].filter((b) => /Baixar [^e]/.test(b.textContent) && !/Baixar e aceitar/.test(b.textContent));
const choose = (h, radio) => { radio.checked = true; radio.dispatchEvent(new h.window.Event('change', { bubbles: true })); };

test('painel: lista de escolha com 6 modelos na ordem pedida, nomes diretos e estrelas (sem tabela)', async () => {
  const ref = { value: makeStatus() };
  const { h, host } = await mountPanel(ref);
  assert.equal(host.querySelector('table'), null, 'não há mais tabela de modelos');
  const group = host.querySelector('[role="radiogroup"]');
  assert.ok(group && group.getAttribute('aria-labelledby'), 'grupo de opções com nome');
  assert.equal(host.querySelector(`#${group.getAttribute('aria-labelledby')}`).textContent, 'neurologyModelos');
  const rows = choices(host);
  assert.deepEqual(rows.map((r) => r.querySelector('strong').textContent), ['Tiny', 'Base', 'Small', 'Medium', 'Large v3', 'Large v3 Turbo']);
  assert.match(rows[2].textContent, /melhor em CPU/);
  assert.match(rows[4].textContent, /recomendado GPU/);
  const labels = [...rows[0].querySelectorAll('[role="img"]')].map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(labels, ['5 de 5', '1 de 5']); // Tiny: velocidade máxima, precisão mínima
  assert.match(rows[0].textContent, /Velocidade/);
  assert.match(rows[0].textContent, /Precisão/);
  assert.match(rows[0].textContent, /30,5 MB/);
  assert.equal(radios(host).length, 6);
  assert.ok(radios(host).every((r) => r.name === 'modModel'), 'mesma família de opções (setas do teclado)');
  await h.cleanup();
});

test('painel: nenhum botão por linha; o único Baixar é o do modelo marcado que ainda falta, com nome e tamanho', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small' }) };
  const { h, host, calls } = await mountPanel(ref);
  assert.equal(checkedId(host), 'small', 'o modelo em uso nasce marcado');
  assert.equal(downloadBtns(host).length, 0, 'modelo instalado marcado: sem botão de baixar');
  assert.equal(host.querySelectorAll('.mod-choice button').length, 1, 'só o ícone de apagar do modelo baixado, nada nas linhas que faltam');
  assert.ok(![...host.querySelectorAll('button')].some((b) => /(^|[a-z_])Usar$/.test(b.textContent.trim())), 'sem botão Usar por linha');
  choose(h, radios(host).find((r) => r.value === 'medium'));
  await settle(30);
  assert.equal(checkedId(host), 'medium');
  const btns = downloadBtns(host);
  assert.equal(btns.length, 1, 'um único botão contextual');
  assert.equal(btns[0].textContent.replace(/^download/, ''), 'Baixar Medium (514 MB)');
  assert.equal(calls.length, 0, 'marcar não baixa nada');
  btns[0].click();
  await settle(30);
  assert.deepEqual(calls.at(-1), ['model', 'medium']);
  await h.cleanup();
});

test('painel: o botão acompanha a escolha, some ao voltar para um modelo baixado e a escolha não ativa nada sem baixar', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small' }) };
  const { h, host, calls } = await mountPanel(ref);
  choose(h, radios(host).find((r) => r.value === 'tiny'));
  await settle(30);
  assert.equal(downloadBtns(host)[0].textContent.replace(/^download/, ''), 'Baixar Tiny (30,5 MB)');
  choose(h, radios(host).find((r) => r.value === 'large-v3'));
  await settle(30);
  assert.equal(downloadBtns(host).length, 1);
  assert.equal(downloadBtns(host)[0].textContent.replace(/^download/, ''), 'Baixar Large v3 (1,0 GB)');
  assert.equal(calls.filter((c) => c[0] === 'use').length, 0, 'marcar um modelo que falta nunca troca o modelo em uso');
  choose(h, radios(host).find((r) => r.value === 'small'));
  await settle(30);
  assert.equal(downloadBtns(host).length, 0);
  assert.equal(checkedId(host), 'small');
  await h.cleanup();
});

const useBtn = (host) => host.querySelector('#modUseModel');
const useLabel = (host) => useBtn(host).textContent.replace(/^check_circle/, '');

test('painel: marcar um modelo já baixado só marca; o botão "Usar <nome>" é quem passa a usá-lo', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['tiny', 'small'], active: 'small' }) };
  const { h, host, calls } = await mountPanel(ref);
  const rowOf = (id) => radios(host).find((r) => r.value === id).closest('.mod-choice');
  assert.match(rowOf('small').textContent, /Em uso/);
  assert.match(rowOf('tiny').textContent, /Baixado/);
  assert.doesNotMatch(rowOf('base').textContent, /Baixado|Em uso/);
  assert.equal(useBtn(host), null, 'o modelo em uso está marcado: nada para usar');
  choose(h, radios(host).find((r) => r.value === 'tiny'));
  await settle(30);
  assert.equal(calls.length, 0, 'marcar não troca o modelo em uso');
  assert.equal(checkedId(host), 'tiny');
  assert.equal(useLabel(host), 'Usar Tiny');
  assert.equal(downloadBtns(host).length, 0, 'um único botão contextual: Usar, não Baixar');
  assert.equal(host.querySelector('.mod-choice-action').getAttribute('aria-live'), 'polite');
  useBtn(host).click();
  await settle(30);
  assert.deepEqual(calls.at(-1), ['use', 'tiny']);
  assert.equal(calls.filter((c) => c[0] === 'use').length, 1);
  // o estado vem do processo principal: ainda em 'small' no mock, então a marca volta para o que está em uso
  assert.equal(checkedId(host), 'small');
  assert.equal(useBtn(host), null);
  await h.cleanup();
});

test('painel: percorrer a lista com as setas passando por modelos baixados não troca o modelo em uso', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['tiny', 'base', 'small'], active: 'tiny' }) };
  const { h, host, calls } = await mountPanel(ref);
  for (const id of ['base', 'small', 'medium', 'large-v3']) {
    choose(h, radios(host).find((r) => r.value === id));
    await settle(30);
    assert.equal(checkedId(host), id);
  }
  assert.equal(calls.length, 0, 'só marcar: nenhuma troca nem download');
  assert.equal(useBtn(host), null);
  assert.equal(downloadBtns(host).length, 1, 'parou num modelo que falta: só o Baixar dele');
  await h.cleanup();
});

test('painel: clicar duas vezes em "Usar" ativa uma vez só e o botão fica desabilitado enquanto ativa', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['tiny', 'small'], active: 'small' }) };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { h, host, calls } = await mountPanel(ref, { extra: {
    modulesSetActiveModel: async (id) => { calls.push(['use', id]); await gate; return { ok: true, data: ref.value }; }
  } });
  choose(h, radios(host).find((r) => r.value === 'tiny'));
  await settle(30);
  const btn = useBtn(host);
  btn.click();
  btn.click();
  await settle(30);
  assert.equal(calls.filter((c) => c[0] === 'use').length, 1);
  assert.ok(useBtn(host).disabled, 'ativando: o botão não aceita novo clique');
  release();
  await settle(30);
  assert.equal(calls.filter((c) => c[0] === 'use').length, 1);
  await h.cleanup();
});

test('painel: se a ativação falha, a marca continua no modelo escolhido e o erro aparece', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['tiny', 'small'], active: 'small' }) };
  const { h, host } = await mountPanel(ref, { extra: {
    modulesSetActiveModel: async () => ({ ok: false, error: 'Não foi possível trocar o modelo.' })
  } });
  choose(h, radios(host).find((r) => r.value === 'tiny'));
  await settle(30);
  useBtn(host).click();
  await settle(30);
  assert.equal(checkedId(host), 'tiny');
  assert.equal(useLabel(host), 'Usar Tiny');
  assert.match(host.querySelector('#modNotice').textContent, /Não foi possível trocar o modelo/);
  await h.cleanup();
});

test('painel: sem o recurso instalado não há botão de baixar (nem desabilitado): entra uma frase de orientação', async () => {
  const ref = { value: makeStatus() };
  const { h, host, calls } = await mountPanel(ref);
  assert.equal(checkedId(host), null, 'sem modelo em uso nada vem marcado');
  assert.equal(downloadBtns(host).length, 0);
  assert.ok(![...host.querySelectorAll('button')].some((b) => /Baixar/.test(b.textContent) && !/Baixar e aceitar/.test(b.textContent)), 'nenhum Baixar, nem desabilitado');
  assert.doesNotMatch(host.textContent, /Instale a transcrição para baixar modelos/);
  choose(h, radios(host).find((r) => r.value === 'small'));
  await settle(30);
  assert.equal(downloadBtns(host).length, 0);
  const aviso = host.querySelector('.mod-choice-action');
  assert.equal(aviso.textContent, 'Instale a transcrição para baixar modelos.');
  assert.equal(aviso.getAttribute('aria-live'), 'polite', 'a mudança é anunciada');
  assert.equal(calls.length, 0);
  await h.cleanup();
});

test('painel: durante um download o botão contextual fica desabilitado e o foco não se perde ao refazer a lista', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small' }) };
  const { h, host } = await mountPanel(ref);
  // linkedom não tem foco real: um "activeElement" simulado, alimentado por focus()
  const foco = { atual: null };
  Object.defineProperty(h.document, 'activeElement', { configurable: true, get: () => foco.atual });
  const proto = h.window.Element.prototype;
  const original = proto.focus;
  proto.focus = function focar() { foco.atual = this; };
  try {
    choose(h, radios(host).find((r) => r.value === 'medium'));
    await settle(30);
    foco.atual = host.querySelector('#modDownloadModel');
    ref.value = { ...makeStatus({ engine: true, installedModels: ['small'], active: 'small' }), busy: true };
    h.bds.emit('onModulesStatus', {});
    await settle(30);
    const btn = host.querySelector('#modDownloadModel');
    assert.ok(btn && btn.disabled, 'ocupado: o botão não aceita novo clique');
    assert.ok(foco.atual && host.contains(foco.atual), 'o foco continua dentro do painel');
    assert.equal(foco.atual.type, 'radio', 'o botão desabilitado não segura o foco: ele vai para o modelo marcado');
    assert.equal(foco.atual.value, 'medium');
    // o download termina: o botão some e o foco vai para o modelo marcado, não para o nada
    foco.atual = host.querySelector('#modDownloadModel');
    ref.value = makeStatus({ engine: true, installedModels: ['small', 'medium'], active: 'small' });
    h.bds.emit('onModulesStatus', {});
    await settle(30);
    assert.equal(host.querySelector('#modDownloadModel'), null);
    assert.ok(foco.atual && host.contains(foco.atual) && foco.atual.type === 'radio', 'o foco foi para a lista');
    // o modelo recém-baixado continua marcado e o botão passa a ser "Usar" (o download valeu, falta só usar)
    assert.equal(foco.atual.value, 'medium');
    assert.equal(useLabel(host), 'Usar Medium');
  } finally { proto.focus = original; await h.cleanup(); }
});

test('painel: pode apagar qualquer modelo, inclusive o único e o em uso, com aviso claro', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small' }) };
  const { h, host, calls } = await mountPanel(ref);
  const del = host.querySelector('button[aria-label="Apagar o modelo Small"]');
  assert.ok(del && !del.disabled, 'botão de apagar existe e está ativo para o único modelo em uso');
  del.click();
  await settle(30);
  assert.match(h.dialogs.confirms.at(-1), /único modelo instalado/);
  assert.deepEqual(calls.at(-1), ['removeModel', 'small']);
  await h.cleanup();
});

test('painel: Instalar baixa o recurso e, com placa NVIDIA, pergunta pela aceleração (clicar = aceitar os termos)', async () => {
  const ref = { value: makeStatus() };
  const { h, host, calls } = await mountPanel(ref, { nvidia: true });
  installBtn(host).click();
  await settle(60);
  assert.equal(calls[0][0], 'engine');
  const dlg = host.querySelector('dialog');
  assert.ok(dlg, 'a pergunta da NVIDIA deve abrir');
  assert.match(dlg.textContent, /concorda com os termos de licença da NVIDIA/);
  [...dlg.querySelectorAll('button')].find((b) => /Baixar e aceitar/.test(b.textContent)).click();
  await settle(60);
  assert.deepEqual(calls.at(-1), ['cuda', { acceptLicense: true }]);
  await h.cleanup();
});

test('painel: sem placa NVIDIA nada de aceleração é oferecido', async () => {
  const ref = { value: makeStatus() };
  const { h, host, calls } = await mountPanel(ref, { nvidia: false });
  installBtn(host).click();
  await settle(60);
  assert.equal(calls.length, 1);
  assert.equal(host.querySelector('dialog'), null);
  assert.ok(!/NVIDIA/.test(host.textContent));
  await h.cleanup();
});

test('painel: instalado com placa NVIDIA mostra "Ativar aceleração"; "Agora não" não baixa nada', async () => {
  const ref = { value: makeStatus({ engine: true }) };
  const { h, host, calls } = await mountPanel(ref, { nvidia: true });
  [...host.querySelectorAll('button')].find((b) => /Ativar aceleração/.test(b.textContent)).click();
  await settle(30);
  const dlg = host.querySelector('dialog');
  assert.ok(dlg);
  [...dlg.querySelectorAll('button')].find((b) => /Agora não/.test(b.textContent)).click();
  await settle(30);
  assert.equal(calls.filter((c) => c[0] === 'cuda').length, 0);
  await h.cleanup();
});

// ------------------------------------------------------------------ "Ajustes avançados" (remover a transcrição e a aceleração)

const removeButtons = (host) => [...host.querySelectorAll('button')].filter((b) => /^(delete)?Remover a /.test(b.textContent.trim()));

test('painel: instalado, os Remover da transcrição e da aceleração ficam em "Ajustes avançados" recolhido, com nome próprio', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small', cuda: true }) };
  const { h, host } = await mountPanel(ref, { nvidia: true });
  const adv = host.querySelector('details.st-advanced');
  assert.ok(adv, 'bloco recolhível existe');
  assert.equal(adv.hasAttribute('open'), false, 'nasce recolhido');
  assert.equal(adv.querySelector('summary').textContent, 'Ajustes avançados');
  const inside = [...adv.querySelectorAll('button')];
  assert.deepEqual(inside.map((b) => b.getAttribute('aria-label')), ['Remover a transcrição', 'Remover a aceleração NVIDIA']);
  assert.ok(inside.every((b) => b.getAttribute('title') === b.getAttribute('aria-label')), 'todo botão tem title e aria-label');
  assert.equal(removeButtons(host).filter((b) => !adv.contains(b)).length, 0, 'nenhum Remover solto fora do bloco');
  assert.ok(![...host.querySelectorAll('button')].some((b) => !adv.contains(b) && /(^|[a-z_])Remover$/.test(b.textContent.trim())), 'sem um "Remover" genérico');
  await h.cleanup();
});

test('painel: sem aceleração instalada o bloco avançado só traz Remover a transcrição', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small' }) };
  const { h, host } = await mountPanel(ref, { nvidia: true });
  const adv = host.querySelector('details.st-advanced');
  assert.deepEqual([...adv.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')), ['Remover a transcrição']);
  assert.ok([...host.querySelectorAll('button')].some((b) => /Ativar aceleração/.test(b.textContent) && !adv.contains(b)), 'Ativar aceleração continua à vista');
  await h.cleanup();
});

test('painel: sem instalar não há bloco avançado e "Usar um arquivo…" continua à vista como link', async () => {
  const ref = { value: makeStatus() };
  const { h, host } = await mountPanel(ref);
  assert.equal(host.querySelector('details.st-advanced'), null);
  const link = [...host.querySelectorAll('button')].find((b) => /Usar um arquivo/.test(b.textContent));
  assert.ok(link && link.classList.contains('mod-btn-link') && !link.closest('details'), 'link fora de qualquer bloco recolhido');
  await h.cleanup();
});

test('painel: o bloco avançado aberto continua aberto quando chega um evento de status ou de progresso (a tela é refeita)', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small', cuda: true }) };
  const { h, host } = await mountPanel(ref, { nvidia: true });
  const adv = host.querySelector('details.st-advanced');
  adv.setAttribute('open', '');
  adv.dispatchEvent(new h.window.Event('toggle'));
  h.bds.emit('onModulesStatus', {});
  await settle(30);
  const again = host.querySelector('details.st-advanced');
  assert.notEqual(again, adv, 'o bloco foi refeito');
  assert.equal(again.hasAttribute('open'), true, 'o estado aberto foi reaplicado');
  h.bds.emit('onModulesProgress', { phase: 'download', percent: 40, label: 'Baixando' });
  h.bds.emit('onModulesStatus', {});
  await settle(30);
  assert.equal(host.querySelector('details.st-advanced').hasAttribute('open'), true);
  // fechar também vale
  const cur = host.querySelector('details.st-advanced');
  cur.removeAttribute('open');
  cur.dispatchEvent(new h.window.Event('toggle'));
  h.bds.emit('onModulesStatus', {});
  await settle(30);
  assert.equal(host.querySelector('details.st-advanced').hasAttribute('open'), false);
  await h.cleanup();
});

test('painel: Remover a transcrição e Remover a aceleração mantêm a confirmação; recusar não remove', async () => {
  const ref = { value: makeStatus({ engine: true, installedModels: ['small'], active: 'small', cuda: true }) };
  const { h, host } = await mountPanel(ref, { nvidia: true, extra: { modulesUninstallEngine: async () => ({ ok: true, data: ref.value }), modulesRemoveCuda: async () => ({ ok: true, data: ref.value }) } });
  const label = (text) => host.querySelector(`details.st-advanced button[aria-label="${text}"]`);
  h.window.bdsModal.confirm = async (msg) => { h.dialogs.confirms.push(String(msg)); return false; };
  label('Remover a transcrição').click();
  label('Remover a aceleração NVIDIA').click();
  await settle(30);
  assert.equal(h.dialogs.confirms.length, 2);
  assert.match(h.dialogs.confirms[0], /Remover a transcrição\?/);
  assert.match(h.dialogs.confirms[1], /Remover a aceleração NVIDIA\?/);
  assert.equal((h.bds.calls.modulesUninstallEngine || []).length, 0);
  assert.equal((h.bds.calls.modulesRemoveCuda || []).length, 0);
  h.window.bdsModal.confirm = async (msg) => { h.dialogs.confirms.push(String(msg)); return true; };
  label('Remover a transcrição').click();
  await settle(30);
  assert.equal(h.bds.calls.modulesUninstallEngine.length, 1);
  label('Remover a aceleração NVIDIA').click();
  await settle(30);
  assert.equal(h.bds.calls.modulesRemoveCuda.length, 1);
  await h.cleanup();
});
