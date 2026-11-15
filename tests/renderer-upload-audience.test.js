'use strict';

// Tela Envio: a declaração "para crianças" é do usuário. Cada vídeo mostra se ainda falta a escolha, o formulário do vídeo e o
// painel "Para todos os vídeos" têm o campo, e abrir o formulário de um vídeo não pode esconder o painel "Para todos os vídeos".

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const item = (id, extra = {}) => ({
  id, path: `C:/v/${id}.mp4`, name: `${id}.mp4`, title: `Vídeo ${id}`, description: '', visibility: 'private',
  audience: '', playlist: '', thumbnail: '', status: 'queued', progress: 0, ...extra
});

/** Monta a tela com a fila ligada e uma API de fila simulada que guarda o que a tela pediu. */
async function mountUpload(t, items, defaults = { description: '', playlist: '', audience: '' }) {
  const state = { items, running: false, paused: false, attention: null, waitUntil: null, doneToday: 0, dailyLimit: 10, enabled: true, defaults };
  const calls = { update: [], setDefaults: [] };
  const youtubeUpload = {
    getState: async () => JSON.parse(JSON.stringify(state)),
    update: async (id, patch) => { calls.update.push([id, patch]); return { ok: true }; },
    setDefaults: async (payload) => { calls.setDefaults.push(payload); return { ok: true }; }
  };
  const h = await mountScreen('upload', { bds: { getSettings: { uploadAutoEnabled: true }, youtubeUpload } });
  t.after(() => h.cleanup());
  await settle(40);
  return { h, calls };
}

const rows = (h) => [...h.document.querySelectorAll('#uploadQueueList .bds-upl-item')];
const subOf = (li) => li.querySelector('.bds-upl-item-sub').textContent;

test('cada vídeo mostra a declaração escolhida ou avisa que ainda falta escolher', async (t) => {
  const { h } = await mountUpload(t, [item('a'), item('b', { audience: 'not_kids' }), item('c', { audience: 'kids' })]);
  const [a, b, c] = rows(h);
  assert.match(subOf(a), /Escolher se é para crianças/);
  assert.equal(a.dataset.audience, 'missing');
  assert.match(subOf(b), /Não é para crianças/);
  assert.equal(b.dataset.audience, 'set');
  assert.match(subOf(c), /É para crianças/);
  assert.equal(c.dataset.audience, 'set');
});

test('formulário do vídeo: começa sem opção marcada, abre com a escolha atual e salva o que o usuário escolher', async (t) => {
  const { h, calls } = await mountUpload(t, [item('a'), item('b', { audience: 'kids' })]);
  const [a, b] = rows(h);
  const select = (li) => li.querySelector('.bds-upl-f-aud');

  const opts = [...select(a).querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(opts, ['', 'not_kids', 'kids'], 'a primeira opção é "Escolha uma opção" (vazia): nada vem pré-marcado');

  a.querySelector('.bds-upl-item-edit').click();
  assert.equal(select(a).value, '', 'vídeo sem escolha abre sem opção marcada');
  b.querySelector('.bds-upl-item-edit').click();
  assert.equal(select(b).value, 'kids', 'vídeo com escolha abre com ela');

  select(b).value = 'not_kids';
  b.querySelector('.bds-upl-item-form').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(20);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0][0], 'b');
  assert.equal(calls.update[0][1].audience, 'not_kids');
});

test('abrir o formulário de um vídeo NÃO esconde o painel "Para todos os vídeos"', async (t) => {
  const { h } = await mountUpload(t, [item('a'), item('b')]);
  const defaultsForm = h.document.getElementById('uploadDefaultsForm');
  assert.ok(!defaultsForm.classList.contains('hidden'));
  rows(h)[0].querySelector('.bds-upl-item-edit').click();
  rows(h)[1].querySelector('.bds-upl-item-edit').click(); // trocar de vídeo também fecha o formulário do anterior
  assert.ok(!defaultsForm.classList.contains('hidden'), 'o painel de padrões continua utilizável depois de editar vídeos');
  assert.ok(rows(h)[0].querySelector('.bds-upl-item-form').classList.contains('hidden'), 'só um formulário de vídeo fica aberto');
  assert.ok(!rows(h)[1].querySelector('.bds-upl-item-form').classList.contains('hidden'));
});

test('"Para todos os vídeos": o campo vem sem escolha, mostra o padrão da sessão e envia a escolha ao salvar', async (t) => {
  const { h, calls } = await mountUpload(t, [item('a')], { description: '', playlist: '', audience: 'not_kids' });
  const select = h.document.getElementById('uploadDefaultsAudience');
  const opts = [...select.querySelectorAll('option')].map((o) => o.getAttribute('value'));
  assert.deepEqual(opts, ['', 'not_kids', 'kids']);
  assert.equal(select.value, 'not_kids', 'mostra o padrão que o usuário já escolheu na sessão');
  assert.match(h.document.getElementById('uploadDefaultsHint').textContent, /não é para crianças/i);

  select.value = 'kids';
  h.document.getElementById('uploadDefaultsApply').checked = true;
  h.document.getElementById('uploadDefaultsForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(20);
  assert.equal(calls.setDefaults.length, 1);
  assert.equal(calls.setDefaults[0].audience, 'kids');
  assert.equal(calls.setDefaults[0].applyToQueued, true);
});

test('aviso permanente da fila: direitos de publicação e declaração de público por vídeo', async (t) => {
  const { h } = await mountUpload(t, []);
  const note = h.document.getElementById('uploadRightsNote');
  assert.ok(note, 'aviso no rodapé da fila');
  assert.match(note.textContent, /direito de publicar/);
  assert.match(note.textContent, /músicas e imagens de terceiros/);
  assert.match(note.textContent, /se ele é para crianças/);
});
