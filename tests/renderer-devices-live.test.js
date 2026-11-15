'use strict';

// Tela Dispositivos: aparece sozinha o que for conectado (sem depender de evento ou de clique em "Atualizar"), diferencia
// "nada conectado" de "não consegui olhar", não pisca a grade a cada busca e mostra o aviso do celular bloqueado.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountScreen, settle } = require('./helpers/renderer-harness');

const GB = 1024 ** 3;
const card = (letter = 'E:', name = 'SD_CARD') => ({
  type: 'USB', isBdsm: false, id: letter, name, storage: [{ name: 'Mass Storage', path: `${letter}\\`, capacity: 64 * GB, free: 10 * GB }]
});
const phone = (storages) => ({ type: 'MTP', isBdsm: false, Name: 'Galaxy A51', Type: 'Telefone', Storages: storages });
const ok = (devices, issues = []) => ({ devices, issues });

/** Monta a tela com a busca automática a cada 40 ms (em vez de 3 s). */
async function mountLive(t, first, bds = {}) {
  const h = await mountScreen('devices', { bds: { getAllDevices: first, ...bds } });
  t.after(() => h.cleanup());
  await settle(30);
  await h.mod.onLeave(); // reinicia a tela com o intervalo curto
  h.window.__BDS_DEVICES_POLL_MS = 40;
  await h.mod.onEnter();
  await settle(60);
  return h;
}

const gridText = (h) => h.document.getElementById('devicesGrid').textContent.replace(/\s+/g, ' ');

test('cartão plugado aparece sozinho: nenhum evento, nenhum clique', async (t) => {
  const h = await mountLive(t, ok([]));
  assert.match(gridText(h), /Nenhum dispositivo conectado/);

  h.bds.set('getAllDevices', ok([card()])); // o usuário pluga o cartão
  await settle(220);

  const cards = h.document.querySelectorAll('.device-card');
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /SD_CARD/);
  assert.doesNotMatch(gridText(h), /Nenhum dispositivo conectado/);
});

test('e some sozinho quando o cartão é retirado', async (t) => {
  const h = await mountLive(t, ok([card()]));
  assert.equal(h.document.querySelectorAll('.device-card').length, 1);
  h.bds.set('getAllDevices', ok([]));
  await settle(220);
  assert.equal(h.document.querySelectorAll('.device-card').length, 0);
  assert.match(gridText(h), /Nenhum dispositivo conectado/);
});

test('busca que falhou NÃO diz "nenhum dispositivo conectado": avisa que não deu para conferir', async (t) => {
  const h = await mountLive(t, ok([], [{ source: 'usb', message: 'A consulta às unidades demorou demais.' }]));
  const text = gridText(h);
  assert.match(text, /Não consegui conferir tudo agora/);
  assert.match(text, /demorou demais/);
  assert.doesNotMatch(text, /Nenhum dispositivo conectado/);
  assert.ok(h.document.querySelector('#devicesGrid [data-action="rescan"]'), 'botão para tentar agora');
});

test('quando a busca volta a funcionar, o aviso some e o dispositivo aparece', async (t) => {
  const h = await mountLive(t, ok([], [{ source: 'usb', message: 'demorou' }]));
  assert.match(gridText(h), /Não consegui conferir tudo agora/);
  h.bds.set('getAllDevices', ok([card()]));
  await settle(220);
  assert.doesNotMatch(gridText(h), /Não consegui conferir tudo agora/);
  assert.equal(h.document.querySelectorAll('.device-card').length, 1);
});

test('aviso de varredura incompleta convive com os cartões que já foram vistos', async (t) => {
  const h = await mountLive(t, ok([card()], [{ source: 'mtp', message: 'A consulta às câmeras e celulares demorou demais.' }]));
  assert.equal(h.document.querySelectorAll('.device-card').length, 1);
  assert.match(gridText(h), /Não consegui conferir tudo agora/);
});

test('a lista simples (formato antigo do canal) continua funcionando', async (t) => {
  const h = await mountLive(t, [card('F:', 'PENDRIVE')]);
  assert.match(h.document.querySelector('.device-card').textContent, /PENDRIVE/);
});

test('celular bloqueado (sem armazenamento) mostra o que fazer para liberar os arquivos', async (t) => {
  const h = await mountLive(t, ok([phone([])]));
  const el = h.document.querySelector('.device-card');
  assert.match(el.getAttribute('aria-label'), /Aguardando liberação/);
  assert.match(el.textContent, /Transferência de arquivos/);

  h.bds.set('getAllDevices', ok([phone([{ Name: 'Armazenamento interno', TotalSize: 64 * GB, FreeSpace: 20 * GB }])]));
  await settle(220);
  const after = h.document.querySelector('.device-card');
  assert.doesNotMatch(after.textContent, /Transferência de arquivos/);
  assert.match(after.getAttribute('aria-label'), /Conectado/);
});

test('a busca automática não redesenha a grade quando nada mudou (o clique do usuário não se perde)', async (t) => {
  // cada resposta traz objetos novos e com "last_seen" diferente, como o celular faz a cada sondagem
  const bdsm = () => ({ type: 'BDSM', isBdsm: true, id: 'Scorpio_usb', physicalId: 'S', name: 'Scorpio', model: 'SM', ip: '127.0.0.1', port: 8080, connection: 'usb', battery: 80, paired: true, authRequired: true, storage_total: 8 * GB, storage_free: 2 * GB, app_version: '1.0', last_seen: Date.now() });
  const h = await mountLive(t, () => Promise.resolve(ok([bdsm(), card()])));
  const first = h.document.querySelector('.device-card');
  assert.ok(first);
  const calls0 = h.bds.calls.getAllDevices.length;
  await settle(200);
  assert.ok(h.bds.calls.getAllDevices.length > calls0 + 2, 'buscou várias vezes');
  assert.equal(h.document.querySelector('.device-card'), first, 'o mesmo elemento: a grade não foi refeita');
});

test('quando algo visível muda (bateria), a grade é atualizada', async (t) => {
  const bdsm = (battery) => ({ type: 'BDSM', isBdsm: true, id: 'Scorpio_usb', physicalId: 'S', name: 'Scorpio', model: 'SM', ip: '127.0.0.1', port: 8080, connection: 'usb', battery, paired: true, authRequired: true, storage_total: 8 * GB, storage_free: 2 * GB, app_version: '1.0', last_seen: Date.now() });
  const h = await mountLive(t, ok([bdsm(80)]));
  assert.match(h.document.querySelector('.device-card').textContent, /80%/);
  h.bds.set('getAllDevices', ok([bdsm(79)]));
  await settle(220);
  assert.match(h.document.querySelector('.device-card').textContent, /79%/);
});

test('busca automática que falha mantém a lista que estava na tela (sem tela de erro)', async (t) => {
  const h = await mountLive(t, ok([card()]));
  h.bds.set('getAllDevices', () => Promise.reject(new Error('Error invoking remote method: tempo esgotado')));
  await settle(220);
  assert.equal(h.document.querySelectorAll('.device-card').length, 1);
  assert.doesNotMatch(gridText(h), /Não foi possível procurar os dispositivos/);
});

test('a busca automática para ao sair da tela e volta ao entrar', async (t) => {
  const h = await mountLive(t, ok([]));
  await h.mod.onLeave();
  const before = h.bds.calls.getAllDevices.length;
  await settle(200);
  assert.equal(h.bds.calls.getAllDevices.length, before, 'tela fora de vista: não busca');
  await h.mod.onEnter();
  await settle(200);
  assert.ok(h.bds.calls.getAllDevices.length > before, 'voltou: busca de novo');
});

test('a busca automática nunca se acumula: uma resposta lenta não dispara outras por cima', async (t) => {
  let concurrent = 0; let maxConcurrent = 0;
  const slow = async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await settle(150);
    concurrent--;
    return ok([]);
  };
  const h = await mountLive(t, ok([]));
  await settle(200); // as buscas de abertura (inicial e ao entrar) já terminaram
  h.bds.set('getAllDevices', slow);
  const before = h.bds.calls.getAllDevices.length;
  await settle(600);
  assert.equal(maxConcurrent, 1, 'só uma busca automática por vez, mesmo com intervalo de 40 ms e resposta de 150 ms');
  assert.ok(h.bds.calls.getAllDevices.length - before >= 2, 'continuou buscando, uma de cada vez');
});

test('seleção continua no mesmo aparelho quando outro entra na lista (id pelo nome, não pela posição)', async (t) => {
  const h = await mountLive(t, ok([phone([{ Name: 'Interno' }])]));
  h.document.querySelector('.device-card').click();
  assert.match(h.document.getElementById('deviceInspector').textContent, /Galaxy A51/);

  h.bds.set('getAllDevices', ok([{ ...phone([{ Name: 'Interno' }]), Name: 'Sony A7', Type: 'Câmera' }, phone([{ Name: 'Interno' }])]));
  await settle(220);
  assert.equal(h.document.querySelectorAll('.device-card').length, 2);
  assert.match(h.document.getElementById('deviceInspector').textContent, /Galaxy A51/, 'o painel segue no celular, não pulou para a câmera');
});

test('"Atualizar" continua forçando a busca', async (t) => {
  const h = await mountLive(t, ok([]));
  h.document.getElementById('btnRefreshDevices').click();
  await settle(40);
  assert.ok(h.bds.calls.getAllDevices.some((args) => args[0] === true), 'pediu nova varredura (force)');
});
