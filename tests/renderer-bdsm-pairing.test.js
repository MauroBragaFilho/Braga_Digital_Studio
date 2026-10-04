'use strict';

// Tela Dispositivos: estado de pareamento no cartão, diálogo "Conectar ao celular" (código, contagem,
// cancelar, Esc, recusa/expiração/429 com "Tentar de novo") e continuação automática da ação original.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const rawPhone = (extra = {}) => ({
  id: 'Scorpio_usb', physicalId: 'Scorpio|SM-A515F', type: 'BDSM', name: 'Scorpio', model: 'SM-A515F',
  ip: '127.0.0.1', port: 8080, connection: 'usb', battery: null, storage_total: 0, storage_free: 0,
  app_version: '1.0.0', paired: false, authRequired: true, ...extra
});

const MEDIA = [
  { id: 'rec-1', name: 'VID_1.mp4', size: 5000, duration: 10 },
  { id: 'rec-2', name: 'VID_2.mp4', size: 2048, duration: 4 }
];

/** Erro como chega pelo IPC (o Electron prefixa a mensagem). */
const ipcError = (code, message) => new Error(`Error invoking remote method 'bdsm:x': Error: BDSM:${code}:${message}`);

const isOpen = (doc, id) => { const m = doc.getElementById(id); return m.classList.contains('active') && !m.classList.contains('hidden'); };
const click = (doc, selector) => doc.querySelector(selector).click();

async function mountPhone(t, { phone = rawPhone(), bds = {} } = {}) {
  const calls = { start: 0, cancel: 0 };
  const h = await mountScreen('devices', {
    bds: {
      getAllDevices: [phone],
      getBdsmImportHistory: [],
      startBdsmPairing: async () => { calls.start++; return { state: 'PENDING', code: '4821', secondsLeft: 90 }; },
      cancelBdsmPairing: async () => { calls.cancel++; return true; },
      ...bds
    }
  });
  t.after(() => h.cleanup());
  await settle(30);
  return { h, calls };
}

test('cartão do celular mostra "Pareamento necessário" e, depois de parear, "Pareado" (com bateria)', async (t) => {
  const { h } = await mountPhone(t);
  const card = h.document.querySelector('.device-card');
  assert.match(card.textContent, /Pareamento necessário/);
  assert.doesNotMatch(card.textContent, /%/, 'sem pareamento não há bateria');
  assert.match(card.getAttribute('aria-label'), /Pareamento necessário/);

  h.bds.set('getAllDevices', [rawPhone({ paired: true, battery: 87, storage_total: 128 * 1024 ** 3, storage_free: 64 * 1024 ** 3 })]);
  h.bds.emit('onBdsmDeviceUpdated', {});
  await settle(900);
  const paired = h.document.querySelector('.device-card');
  assert.match(paired.textContent, /Pareado/);
  assert.match(paired.textContent, /87%/);
  assert.doesNotMatch(paired.textContent, /Pareamento necessário/);

  // "Esquecer este celular" só no painel de detalhes
  assert.equal(paired.querySelectorAll('button').length, 3, 'cartão: ocultar + 2 ações');
  paired.click();
  const inspector = h.document.getElementById('deviceInspector');
  assert.match(inspector.textContent, /Esquecer este celular/);
});

test('Importar mídia sem pareamento abre o diálogo, mostra o código e, ao aprovar, continua a importação', async (t) => {
  const { h, calls } = await mountPhone(t, { bds: { getBdsmMedia: async () => MEDIA } });
  click(h.document, '[data-action="bdsm-import"]');
  await settle(30);

  assert.ok(isOpen(h.document, 'bdsmPairModal'), 'diálogo aberto');
  assert.equal(h.bds.calls.getBdsmMedia, undefined, 'não pediu a lista antes de parear');
  assert.deepEqual(h.bds.calls.startBdsmPairing[0], ['127.0.0.1', 8080]);
  assert.equal(h.document.getElementById('bdsmPairCode').textContent, '4821');
  assert.match(h.document.getElementById('bdsmPairCode').getAttribute('aria-label'), /4 8 2 1/);
  assert.match(h.document.getElementById('bdsmPairHint').textContent, /Confira no celular se o código é o mesmo e toque em Aprovar/);
  assert.match(h.document.getElementById('bdsmPairTimer').textContent, /^Expira em (89|90) s$/);
  assert.match(h.document.getElementById('bdsmPairDevice').textContent, /Scorpio/);
  assert.equal(h.document.getElementById('bdsmPairCodeBox').classList.contains('hidden'), false);
  assert.ok(h.document.getElementById('btnBdsmPairRetry').classList.contains('hidden'));

  // o processo principal informa o tempo restante
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'PENDING', code: '4821', secondsLeft: 61 });
  assert.match(h.document.getElementById('bdsmPairTimer').textContent, /^Expira em (60|61) s$/);

  // aprovado no celular: o diálogo fecha e a ação original continua sozinha
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'APPROVED', code: '4821', secondsLeft: 0 });
  await settle(40);
  assert.equal(isOpen(h.document, 'bdsmPairModal'), false);
  assert.equal(h.bds.calls.getBdsmMedia.length, 1);
  assert.ok(isOpen(h.document, 'bdsmImportModal'));
  const names = [...h.document.querySelectorAll('#bdsmMediaList .item-name')].map((n) => n.textContent);
  assert.deepEqual(names, ['VID_1.mp4', 'VID_2.mp4']);
  assert.equal(calls.start, 1);
  assert.equal(calls.cancel, 0);
});

test('Cancelar fecha o diálogo, avisa o processo principal e NÃO continua a ação', async (t) => {
  const { h, calls } = await mountPhone(t, { bds: { getBdsmMedia: async () => MEDIA } });
  click(h.document, '[data-action="bdsm-import"]');
  await settle(30);
  assert.ok(isOpen(h.document, 'bdsmPairModal'));
  click(h.document, '#btnBdsmPairCancel');
  await settle(30);
  assert.equal(isOpen(h.document, 'bdsmPairModal'), false);
  assert.equal(calls.cancel, 1);
  assert.deepEqual(h.bds.calls.cancelBdsmPairing[0], ['127.0.0.1', 8080]);
  assert.equal(h.bds.calls.getBdsmMedia, undefined);
  assert.equal(isOpen(h.document, 'bdsmImportModal'), false);
  // eventos tardios depois de cancelar são ignorados
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'APPROVED' });
  await settle(20);
  assert.equal(h.bds.calls.getBdsmMedia, undefined);
});

test('Esc cancela o pareamento', async (t) => {
  const { h, calls } = await mountPhone(t);
  click(h.document, '[data-action="bdsm-import"]');
  await settle(30);
  const overlay = h.document.getElementById('bdsmPairModal');
  assert.ok(isOpen(h.document, 'bdsmPairModal'));
  const esc = new h.window.Event('keydown', { bubbles: true });
  esc.key = 'Escape';
  overlay.dispatchEvent(esc);
  await settle(30);
  assert.equal(isOpen(h.document, 'bdsmPairModal'), false);
  assert.equal(calls.cancel, 1);
});

test('recusado e expirado mostram mensagem clara e "Tentar de novo" pede um novo código', async (t) => {
  const { h, calls } = await mountPhone(t);
  click(h.document, '[data-action="bdsm-luts"]');
  await settle(30);

  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'DENIED' });
  const result = h.document.getElementById('bdsmPairResult');
  assert.equal(result.classList.contains('hidden'), false);
  assert.match(result.textContent, /Pareamento recusado/);
  assert.match(result.textContent, /recusado no celular/);
  assert.equal(h.document.getElementById('btnBdsmPairRetry').classList.contains('hidden'), false);
  assert.equal(h.document.getElementById('btnBdsmPairCancel').textContent, 'Fechar');
  assert.equal(h.document.getElementById('bdsmPairCodeBox').classList.contains('hidden'), true);

  click(h.document, '#btnBdsmPairRetry');
  await settle(30);
  assert.equal(calls.start, 2);
  assert.equal(h.document.getElementById('bdsmPairCode').textContent, '4821');
  assert.equal(h.document.getElementById('bdsmPairResult').classList.contains('hidden'), true);

  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'EXPIRED' });
  assert.match(h.document.getElementById('bdsmPairResult').textContent, /O tempo para aprovar no celular acabou/);
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'ERROR', message: 'Sem conexão com o celular. Confira o cabo.' });
  assert.match(h.document.getElementById('bdsmPairResult').textContent, /Sem conexão com o celular/);
});

test('429 ao iniciar: mensagem de celular ocupado, sem código, com "Tentar de novo"', async (t) => {
  const { h } = await mountPhone(t, {
    bds: { startBdsmPairing: async () => { throw ipcError('DEVICE_BUSY', 'O celular ainda tem um pedido de pareamento aberto. Aguarde alguns segundos e tente de novo.'); } }
  });
  click(h.document, '[data-action="bdsm-import"]');
  await settle(30);
  const result = h.document.getElementById('bdsmPairResult');
  assert.match(result.textContent, /O celular está ocupado/);
  assert.match(result.textContent, /pedido de pareamento aberto/);
  assert.doesNotMatch(result.textContent, /BDSM:|Error invoking/);
  assert.equal(h.document.getElementById('btnBdsmPairRetry').classList.contains('hidden'), false);
});

test('PAIRING_REQUIRED no meio da ação (token recusado) abre o diálogo e repete a ação ao aprovar', async (t) => {
  let attempts = 0;
  const { h } = await mountPhone(t, {
    phone: rawPhone({ paired: true, authRequired: true, battery: 80 }),
    bds: {
      getBdsmMedia: async () => {
        attempts++;
        if (attempts === 1) throw ipcError('PAIRING_REQUIRED', 'O celular pede pareamento. Confirme o código no aparelho para continuar.');
        return MEDIA;
      }
    }
  });
  click(h.document, '[data-action="bdsm-import"]');
  await settle(30);
  assert.ok(isOpen(h.document, 'bdsmPairModal'), 'abriu o diálogo ao receber PAIRING_REQUIRED');
  assert.equal(h.document.getElementById('bdsmPairCode').textContent, '4821');
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'APPROVED' });
  await settle(40);
  assert.equal(attempts, 2);
  assert.equal(h.document.querySelectorAll('#bdsmMediaList .item-name').length, 2);
  assert.deepEqual(h.dialogs.alerts, []);
});

test('sincronizar LUTs sem pareamento: parear e continuar (analisar + executar)', async (t) => {
  const plan = { upload: [{ relativePath: 'a.cube', hash: 'h' }], download: [], conflict: [], identical: [], remoteOnly: [{ relativePath: 'x.cube' }] };
  const { h } = await mountPhone(t, {
    bds: { analyzeBdsmLutSync: async () => plan, executeBdsmLutSync: async () => ({ completed: 1, failed: 0, skipped: 0, total: 1 }) }
  });
  click(h.document, '[data-action="bdsm-luts"]');
  await settle(30);
  assert.ok(isOpen(h.document, 'bdsmPairModal'));
  assert.equal(h.bds.calls.analyzeBdsmLutSync, undefined);
  h.bds.emit('onBdsmPairing', { ip: '127.0.0.1', port: 8080, state: 'APPROVED' });
  await settle(60);
  assert.equal(h.bds.calls.analyzeBdsmLutSync.length, 1);
  assert.match(h.dialogs.confirms[0], /Enviar para o celular: 1 LUT/);
  assert.match(h.dialogs.confirms[0], /Só no celular: 1 LUT/);
  assert.equal(h.bds.calls.executeBdsmLutSync.length, 1);
  assert.match(h.dialogs.alerts.at(-1), /concluída com sucesso/);
});

test('erros do celular têm mensagem específica (nunca "Falha desconhecida")', async (t) => {
  const { h } = await mountPhone(t, {
    phone: rawPhone({ paired: true, authRequired: true }),
    bds: { getBdsmMedia: async () => { throw ipcError('DEVICE_UNREACHABLE', 'Sem conexão com o celular. Confira o cabo ou o Wi-Fi e se o BDS Mobile está aberto.'); } }
  });
  click(h.document, '[data-action="bdsm-import"]');
  await settle(40);
  assert.equal(h.dialogs.alerts.length, 1);
  assert.match(h.dialogs.alerts[0], /Sem conexão com o celular/);
  assert.doesNotMatch(h.dialogs.alerts[0], /desconhecida|HTTP 401|BDSM:/);
  assert.equal(isOpen(h.document, 'bdsmPairModal'), false);
  assert.equal(isOpen(h.document, 'bdsmImportModal'), false);
});

test('"Esquecer este celular" confirma, chama o processo principal e atualiza a lista', async (t) => {
  const { h } = await mountPhone(t, { phone: rawPhone({ paired: true, authRequired: true, battery: 80 }) });
  h.document.querySelector('.device-card').click();
  click(h.document, '#deviceInspector [data-action="bdsm-forget"]');
  await settle(40);
  assert.match(h.dialogs.confirms[0], /Esquecer este celular/);
  assert.deepEqual(h.bds.calls.forgetBdsmPairing[0], ['127.0.0.1', 8080]);
});
