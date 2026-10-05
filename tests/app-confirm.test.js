'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppConfirm, ackConfirm, respondConfirm } = require('../src/infrastructure/desktop/AppConfirm');

/** webContents falso: guarda o que o main enviou. */
function fakeWebContents() {
  const sent = [];
  return { sent, send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false };
}
const request = (wc) => wc.sent.find((m) => m.channel === 'ui:confirmRequest').payload;
const tick = () => new Promise((r) => setImmediate(r));

test('confirma só com a resposta "true" do webContents que recebeu o pedido', async () => {
  const wc = fakeWebContents();
  const confirm = createAppConfirm({ fallback: async () => { throw new Error('não devia usar o nativo'); }, ackMs: 1000 });
  const pending = confirm({ webContents: wc, title: 'T', message: 'M', detail: 'D', confirmLabel: 'Sim' });
  await tick();
  const req = request(wc);
  assert.equal(req.message, 'M');
  assert.equal(req.confirmLabel, 'Sim');
  assert.ok(ackConfirm(wc, req.id));
  assert.equal(respondConfirm(wc, req.id, true), true);
  assert.equal(await pending, true);
  assert.equal(respondConfirm(wc, req.id, true), false, 'uso único');
});

test('resposta de outro webContents ou com id inventado é ignorada; só "true" explícito confirma', async () => {
  const wc = fakeWebContents();
  const other = fakeWebContents();
  const confirm = createAppConfirm({ fallback: async () => true, ackMs: 1000 });
  const pending = confirm({ webContents: wc, message: 'M' });
  await tick();
  const { id } = request(wc);
  ackConfirm(wc, id);
  assert.equal(respondConfirm(other, id, true), false);
  assert.equal(respondConfirm(wc, 'inventado', true), false);
  assert.equal(respondConfirm(wc, id, 'true'), true); // string não é true: recusa
  assert.equal(await pending, false);
});

test('sem ack a tempo, cai no diálogo nativo e fecha o modal', async () => {
  const wc = fakeWebContents();
  let nativeCalls = 0;
  const confirm = createAppConfirm({ fallback: async () => { nativeCalls++; return true; }, ackMs: 20 });
  assert.equal(await confirm({ webContents: wc, message: 'M' }), true);
  assert.equal(nativeCalls, 1);
  assert.ok(wc.sent.some((m) => m.channel === 'ui:confirmCancel'));
});

test('sem webContents usa o diálogo nativo direto', async () => {
  const confirm = createAppConfirm({ fallback: async () => false });
  assert.equal(await confirm({ webContents: null, message: 'M' }), false);
});

test('parar (abort) recusa e manda fechar o modal; tempo esgotado também recusa', async () => {
  const wc = fakeWebContents();
  const ctl = new AbortController();
  const confirm = createAppConfirm({ fallback: async () => true, ackMs: 1000 });
  const pending = confirm({ webContents: wc, message: 'M', signal: ctl.signal });
  await tick();
  ackConfirm(wc, request(wc).id);
  ctl.abort();
  assert.equal(await pending, false);
  assert.ok(wc.sent.some((m) => m.channel === 'ui:confirmCancel'));

  const wc2 = fakeWebContents();
  const slow = createAppConfirm({ fallback: async () => true, timeoutMs: 20, ackMs: 1000 });
  const p2 = slow({ webContents: wc2, message: 'M' });
  await tick();
  ackConfirm(wc2, request(wc2).id);
  assert.equal(await p2, false);
});

// ---- lado do renderer: renderer/components/app-confirm.js (ESM; importado dinamicamente) ----
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const RENDERER_CONFIRM = pathToFileURL(path.join(__dirname, '..', 'renderer', 'components', 'app-confirm.js')).href;

test('renderer: mostra o modal do app com o texto do main, avisa (ack) e devolve a decisão', async () => {
  const calls = [];
  const shown = [];
  globalThis.window = {
    bds: { uiConfirmAck: async (id) => calls.push(['ack', id]), uiConfirmRespond: async (id, ok) => calls.push(['respond', id, ok]) },
    bdsModal: { isOpen: () => false, show: (o) => { shown.push(o); return Promise.resolve(true); }, dismiss() {} }
  };
  try {
    const { onConfirmRequest } = await import(`${RENDERER_CONFIRM}?a`);
    const ok = await onConfirmRequest({ id: 'abc', title: 'Limpar', message: 'Certeza?', detail: 'Detalhe', confirmLabel: 'Limpar banco' });
    assert.equal(ok, true);
    assert.equal(shown[0].message, 'Certeza?\n\nDetalhe');
    assert.equal(shown[0].trusted, true, 'só clique real confirma');
    assert.equal(shown[0].focusCancel, true);
    assert.equal(shown[0].confirmLabel, 'Limpar banco');
    assert.deepEqual(calls, [['ack', 'abc'], ['respond', 'abc', true]]);
  } finally { delete globalThis.window; }
});

test('renderer: modal ocupado = sem ack nem resposta (o main usa o diálogo nativo); cancelar devolve false', async () => {
  const calls = [];
  globalThis.window = {
    bds: { uiConfirmAck: async () => calls.push('ack'), uiConfirmRespond: async (id, ok) => calls.push(['respond', ok]) },
    bdsModal: { isOpen: () => true, show: () => Promise.resolve(true) }
  };
  try {
    const { onConfirmRequest } = await import(`${RENDERER_CONFIRM}?b`);
    assert.equal(await onConfirmRequest({ id: 'x', message: 'M' }), false);
    assert.deepEqual(calls, []);
    globalThis.window.bdsModal = { isOpen: () => false, show: () => Promise.resolve(false) };
    assert.equal(await onConfirmRequest({ id: 'y', message: 'M' }), false);
    assert.deepEqual(calls, ['ack', ['respond', false]]);
  } finally { delete globalThis.window; }
});
