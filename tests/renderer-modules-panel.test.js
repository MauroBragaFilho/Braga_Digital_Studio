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

test('painel: tabela com 6 modelos na ordem pedida, nomes diretos e estrelas', async () => {
  const ref = { value: makeStatus() };
  const { h, host } = await mountPanel(ref);
  const rows = [...host.querySelectorAll('tbody tr')];
  assert.deepEqual(rows.map((r) => r.querySelector('th strong').textContent), ['Tiny', 'Base', 'Small', 'Medium', 'Large v3', 'Large v3 Turbo']);
  assert.match(rows[2].querySelector('th').textContent, /melhor em CPU/);
  assert.match(rows[4].querySelector('th').textContent, /recomendado GPU/);
  const labels = [...rows[0].querySelectorAll('[role="img"]')].map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(labels, ['5 de 5', '1 de 5']); // Tiny: velocidade máxima, precisão mínima
  await h.cleanup();
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
