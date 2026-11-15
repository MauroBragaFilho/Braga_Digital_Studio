'use strict';

// Configurações > Inteligência Artificial > modelo local: escolher um modelo AINDA NÃO instalado mantém a escolha. Antes o
// seletor voltava sozinho ao modelo anterior: o botão de instalar sumia ou baixava o modelo errado, e o novo nunca ficava em uso.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const GB = 1024 ** 3;
const OLD = { id: 'qwen2.5-0.5b', label: 'Qwen2.5 0.5B', vision: false, sizeBytes: 0.5 * GB };
const NEW = { id: 'qwen3-vl-2b-instruct', label: 'Qwen3-VL 2B', vision: true, sizeBytes: 1.6 * GB };

/** Estado do modelo local como o processo principal devolve (envelope { ok, data }). */
function state({ selected = OLD.id, installed = [OLD.id] } = {}) {
  const cur = selected === OLD.id ? OLD : NEW;
  return {
    ok: true,
    data: {
      supported: true, installed: installed.includes(selected), running: false, port: 18756,
      modelId: cur.id, modelLabel: cur.label, license: 'Apache-2.0', vision: cur.vision, gpu: false,
      sizeBytes: cur.sizeBytes + 40e6, busy: null,
      models: [OLD, NEW].map((m) => ({ ...m, installed: installed.includes(m.id), selected: m.id === selected }))
    }
  };
}

async function mount(t, bds) {
  const h = await mountScreen('settings', { bds });
  t.after(() => h.cleanup());
  await settle(40);
  return h;
}

const el = (h, id) => h.document.getElementById(id);
const pick = async (h, id) => {
  const select = el(h, 'aiLocalLlmModel');
  select.value = id;
  select.dispatchEvent(new h.window.Event('change'));
  await settle(30);
};

test('escolher um modelo ainda não instalado mantém a escolha e instala ESSE modelo', async (t) => {
  const installs = [];
  const h = await mount(t, {
    aiLocalLlmStatus: async () => state(),
    aiLocalLlmInstall: async (id) => { installs.push(id); return state({ selected: NEW.id, installed: [OLD.id, NEW.id] }); }
  });
  assert.equal(el(h, 'aiLocalLlmModel').value, OLD.id);
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, true, 'o modelo em uso já está instalado');

  await pick(h, NEW.id);
  assert.equal(el(h, 'aiLocalLlmModel').value, NEW.id, 'o seletor não volta ao modelo anterior');
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, false, 'o botão de instalar aparece');
  assert.match(el(h, 'aiLocalLlmHint').textContent, /Não instalado: Qwen3-VL 2B/);

  el(h, 'aiLocalLlmInstallBtn').click();
  await settle(50);
  assert.deepEqual(installs, [NEW.id], 'baixou o modelo escolhido, não o anterior');
  assert.equal(el(h, 'aiLocalLlmModel').value, NEW.id, 'terminou: o novo modelo é o escolhido');
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, true);
});

test('voltar ao modelo em uso desfaz a escolha pendente', async (t) => {
  const h = await mount(t, { aiLocalLlmStatus: async () => state() });
  await pick(h, NEW.id);
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, false);
  await pick(h, OLD.id);
  assert.equal(el(h, 'aiLocalLlmModel').value, OLD.id);
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, true, 'nada a instalar');
  assert.doesNotMatch(el(h, 'aiLocalLlmHint').textContent, /Não instalado/);
});

test('modelo já instalado troca na hora, sem baixar nada', async (t) => {
  const swaps = [];
  const installs = [];
  const h = await mount(t, {
    aiLocalLlmStatus: async () => state({ installed: [OLD.id, NEW.id] }),
    aiLocalLlmSetModel: async (id) => { swaps.push(id); return state({ selected: NEW.id, installed: [OLD.id, NEW.id] }); },
    aiLocalLlmInstall: async (id) => { installs.push(id); return state(); }
  });
  await pick(h, NEW.id);
  assert.deepEqual(swaps, [NEW.id]);
  assert.deepEqual(installs, []);
  assert.equal(el(h, 'aiLocalLlmModel').value, NEW.id);
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, true);
});

test('instalação que falha mantém a escolha para tentar de novo', async (t) => {
  const h = await mount(t, {
    aiLocalLlmStatus: async () => state(),
    aiLocalLlmInstall: async () => ({ ok: false, error: 'Sem conexão com a internet.' })
  });
  await pick(h, NEW.id);
  el(h, 'aiLocalLlmInstallBtn').click();
  await settle(60);
  assert.equal(el(h, 'aiLocalLlmModel').value, NEW.id, 'continua no modelo escolhido');
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, false, 'dá para tentar de novo');
  assert.match(el(h, 'aiLocalLlmStatus').textContent, /Não foi possível instalar/);
});
