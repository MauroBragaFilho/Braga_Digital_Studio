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

// ------------------------------------------------------------------ lista pela memória da placa de vídeo

const MB = 1024 ** 2;
const CARD = { name: 'NVIDIA GeForce GTX 1650', totalMB: 4096, freeMB: 3938, source: 'nvidia-smi' };
const B05 = { id: 'qwen2.5-0.5b-instruct', label: 'Qwen2.5 0.5B Instruct', vision: false, sizeBytes: 490 * MB };
const V2 = { id: 'qwen3-vl-2b-instruct', label: 'Qwen3-VL 2B Instruct', vision: true, sizeBytes: 1480 * MB };
const V4 = { id: 'qwen3-vl-4b-instruct', label: 'Qwen3-VL 4B Instruct', vision: true, sizeBytes: 2815 * MB };
const V8 = { id: 'qwen3-vl-8b-instruct', label: 'Qwen3-VL 8B Instruct', vision: true, sizeBytes: 5512 * MB };
const FITS = { [B05.id]: 'fits', [V2.id]: 'fits', [V4.id]: 'partial', [V8.id]: 'slow' };

/** Estado do modelo local COM a leitura da placa (o que o processo principal devolve depois do `probeGpu`). */
function rich({ installed = [], selected = B05.id, memory = { checked: true, gpu: CARD, integratedOnly: false, safetyMB: 512 }, plan = null, fits = FITS, recommendedId = V2.id, gpuRetryAt = null } = {}) {
  const models = [B05, V2, V4, V8].map((m) => ({
    ...m, installed: installed.includes(m.id), selected: m.id === selected, fit: fits[m.id] ? { state: fits[m.id], gpuPercent: 100, needMB: 3000 } : null
  }));
  const cur = models.find((m) => m.selected);
  return {
    ok: true,
    data: {
      supported: true, installed: installed.includes(selected), running: false, port: 18756, modelId: cur.id, modelLabel: cur.label,
      license: 'Apache-2.0', vision: cur.vision, gpu: true, sizeBytes: cur.sizeBytes + 40e6, busy: null, memory, recommendedId, plan, gpuRetryAt, models
    }
  };
}
const optionText = (h, id) => [...el(h, 'aiLocalLlmModel').options].find((o) => o.value === id).textContent;

test('a lista diz como cada modelo se sai na placa de vídeo e marca o recomendado (só modelo com visão)', async (t) => {
  const h = await mount(t, { aiLocalLlmStatus: async () => rich() });
  assert.match(optionText(h, V2.id), /Qwen3-VL 2B Instruct \(1,4 GB\) — entende imagens · cabe na placa de vídeo · recomendado$/);
  assert.match(optionText(h, V4.id), /entende imagens · parte roda no processador$/);
  assert.match(optionText(h, V8.id), /entende imagens · quase tudo no processador \(lento\)$/);
  assert.doesNotMatch(optionText(h, B05.id), /recomendado|entende imagens/);
  assert.match(optionText(h, B05.id), /cabe na placa de vídeo/);
  const hint = el(h, 'aiLocalLlmFit');
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, 'Placa de vídeo: NVIDIA GeForce GTX 1650 — 3,8 GB livres de 4,0 GB. Recomendado: Qwen3-VL 2B Instruct.');
});

test('nada instalado: já vem marcado o recomendado (com visão), e é ele que o botão instala', async (t) => {
  const installs = [];
  const h = await mount(t, {
    aiLocalLlmStatus: async () => rich(),
    aiLocalLlmInstall: async (id) => { installs.push(id); return rich({ installed: [V2.id], selected: V2.id }); }
  });
  assert.equal(el(h, 'aiLocalLlmModel').value, V2.id, 'o básico (de texto) não é o marcado');
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, false);
  assert.match(el(h, 'aiLocalLlmHint').textContent, /Não instalado: Qwen3-VL 2B Instruct/);
  el(h, 'aiLocalLlmInstallBtn').click();
  await settle(60);
  assert.deepEqual(installs, [V2.id]);
});

test('o usuário pode escolher outro modelo mesmo com o recomendado marcado (inclusive o básico em uso)', async (t) => {
  const h = await mount(t, { aiLocalLlmStatus: async () => rich() });
  await pick(h, V4.id);
  assert.equal(el(h, 'aiLocalLlmModel').value, V4.id, 'a escolha vale, não volta ao recomendado');
  assert.match(el(h, 'aiLocalLlmHint').textContent, /Não instalado: Qwen3-VL 4B Instruct/);
  await pick(h, B05.id);
  assert.equal(el(h, 'aiLocalLlmModel').value, B05.id, 'dá para voltar ao básico mesmo ele sendo o "em uso" ainda não instalado');
});

test('com um modelo instalado, o seletor mostra o instalado (a recomendação só aparece na lista e na dica)', async (t) => {
  const h = await mount(t, { aiLocalLlmStatus: async () => rich({ installed: [B05.id], selected: B05.id }) });
  assert.equal(el(h, 'aiLocalLlmModel').value, B05.id);
  assert.equal(el(h, 'aiLocalLlmInstallBtn').hidden, true);
  assert.match(el(h, 'aiLocalLlmFit').textContent, /Recomendado: Qwen3-VL 2B Instruct\.$/);
});

test('servidor ligado com parte no processador (placa ocupada por outro programa): a dica explica o porquê', async (t) => {
  const busy = { checked: true, gpu: { ...CARD, freeMB: 1896 }, integratedOnly: false, safetyMB: 512 };
  const h1 = await mount(t, { aiLocalLlmStatus: async () => rich({ installed: [V2.id], selected: V2.id, memory: busy, plan: { mode: 'partial', gpuPercent: 41 }, fits: { ...FITS, [V2.id]: 'tight' } }) });
  assert.match(el(h1, 'aiLocalLlmFit').textContent, /1,9 GB livres de 4,0 GB/);
  assert.match(el(h1, 'aiLocalLlmFit').textContent, /Agora parte do modelo roda no processador: outros programas estão usando a placa\.$/);
  assert.match(optionText(h1, V2.id), /cabe se outros programas liberarem a placa/);
  const h2 = await mount(t, { aiLocalLlmStatus: async () => rich({ installed: [V2.id], selected: V2.id, memory: busy, plan: { mode: 'cpu', gpuPercent: 0 } }) });
  assert.match(el(h2, 'aiLocalLlmFit').textContent, /Agora o modelo roda no processador: a placa está ocupada\.$/);
});

test('a placa de vídeo falhou ao ligar: a dica diz que por enquanto roda no processador e que o app tenta de novo; sem falha, nada disso', async (t) => {
  const failed = await mount(t, { aiLocalLlmStatus: async () => rich({ installed: [V2.id], selected: V2.id, gpuRetryAt: Date.now() + 3600000 }) });
  assert.match(el(failed, 'aiLocalLlmFit').textContent, /^Placa de vídeo: NVIDIA GeForce GTX 1650 — 3,8 GB livres de 4,0 GB\. Recomendado: Qwen3-VL 2B Instruct\. Não deu para usar a placa de vídeo da última vez: por enquanto o modelo roda no processador, e o app tenta a placa de novo mais tarde\.$/);
  const fine = await mount(t, { aiLocalLlmStatus: async () => rich({ installed: [V2.id], selected: V2.id }) });
  assert.doesNotMatch(el(fine, 'aiLocalLlmFit').textContent, /Não deu para usar/);
});

test('sem placa dedicada, só integrada, ou sem leitura: a dica diz a verdade ou some; a lista não inventa "cabe"', async (t) => {
  const none = await mount(t, { aiLocalLlmStatus: async () => rich({ memory: { checked: true, gpu: null, integratedOnly: false, safetyMB: 512 }, fits: { [B05.id]: 'cpu', [V2.id]: 'cpu', [V4.id]: 'cpu', [V8.id]: 'cpu' } }) });
  assert.match(el(none, 'aiLocalLlmFit').textContent, /^Não encontrei uma placa de vídeo dedicada: o modelo roda no processador\. Recomendado: Qwen3-VL 2B Instruct\.$/);
  assert.doesNotMatch(optionText(none, V2.id), /cabe na placa/);
  const igpu = await mount(t, { aiLocalLlmStatus: async () => rich({ memory: { checked: true, gpu: null, integratedOnly: true, safetyMB: 512 }, fits: {} }) });
  assert.match(el(igpu, 'aiLocalLlmFit').textContent, /^Este computador só tem placa de vídeo integrada: o modelo roda no processador\./);
  const unknown = await mount(t, { aiLocalLlmStatus: async () => rich({ memory: { checked: false, gpu: null, integratedOnly: false, safetyMB: 512 }, fits: {}, recommendedId: '' }) });
  assert.equal(el(unknown, 'aiLocalLlmFit').hidden, true, 'sem leitura, sem dica');
  assert.equal(el(unknown, 'aiLocalLlmModel').value, B05.id, 'sem recomendação, fica o padrão');
  const other = await mount(t, { aiLocalLlmStatus: async () => rich({ memory: null, fits: {}, recommendedId: '' }) });
  assert.equal(el(other, 'aiLocalLlmFit').hidden, true, 'sistema sem pacote com placa: nada a dizer');
});
