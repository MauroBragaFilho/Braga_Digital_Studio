'use strict';

// Fila de envio automático para o YouTube Studio: ordem, pausa aleatória entre envios, limite diário,
// pedido de atenção (verificação do Google), cancelamento e preferências com valores seguros.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const YoutubeUploadQueue = require('../src/core/uploads/YoutubeUploadQueue');
const { readUploadSettings, pickPauseMs, defaultTitle } = YoutubeUploadQueue;
const { AttentionError } = require('../src/core/uploads/YoutubeStudioDriver');
const { STUDIO_SELECTORS, PERCENT_RE, UPLOADED_RE } = require('../src/core/uploads/studioSelectors');
const { guestProblem } = require('../src/ipc/uploadHandlers');
const SettingsManager = require('../src/core/settings/SettingsManager');

// ---------------------------------------------------------------- utilidades

/** Relógio e sono falsos: `sleep` avança o relógio na hora (os testes não esperam de verdade). */
function clock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; }
  };
}

/** Driver falso: registra os envios e deixa o teste decidir o resultado de cada um. */
function fakeDriver(plan = []) {
  const calls = [];
  return {
    calls,
    cancelled: 0,
    cancel() { this.cancelled++; },
    async upload(item, { onProgress }) {
      calls.push({ ...item });
      const step = plan.shift();
      onProgress({ progress: 50, stage: 'Enviando' });
      if (typeof step === 'function') return step(item);
      if (step instanceof Error) throw step;
      return { videoUrl: `https://youtu.be/${calls.length}` };
    }
  };
}

const flush = () => new Promise((r) => setImmediate(r));
async function finished(q) { while (q.running) await flush(); }

function makeQueue(settings = {}, extra = {}) {
  const c = clock();
  const q = new YoutubeUploadQueue({
    getSettings: () => ({ uploadAutoEnabled: true, uploadPauseEnabled: false, ...settings }),
    sleep: c.sleep, now: c.now, random: () => 0.5, ...extra
  });
  return { q, c };
}

// ---------------------------------------------------------------- preferências

test('preferências: padrão desligado, pausa de 60 s a 5 min, 10 por dia, vídeos privados', () => {
  assert.deepEqual(readUploadSettings({}), { enabled: false, pauseEnabled: true, minSec: 60, maxSec: 300, dailyLimit: 10, visibility: 'private' });
});

test('preferências: valores inválidos voltam ao padrão; mínimo nunca passa do máximo; limites de faixa', () => {
  const p = readUploadSettings({ uploadPauseMinSec: 'x', uploadPauseMaxSec: null, uploadDailyLimit: 'abc', uploadDefaultVisibility: 'secret' });
  assert.deepEqual(p, { enabled: false, pauseEnabled: true, minSec: 60, maxSec: 300, dailyLimit: 10, visibility: 'private' });
  assert.deepEqual(readUploadSettings({ uploadPauseMinSec: 400, uploadPauseMaxSec: 30 }).maxSec, 400);
  assert.equal(readUploadSettings({ uploadPauseMaxSec: 99999 }).maxSec, 3600);
  assert.equal(readUploadSettings({ uploadDailyLimit: 999 }).dailyLimit, 100);
  assert.equal(readUploadSettings({ uploadAutoEnabled: true, uploadDefaultVisibility: 'unlisted' }).visibility, 'unlisted');
});

test('pausa: o sorteio fica dentro da faixa', () => {
  const range = { minSec: 60, maxSec: 300 };
  assert.equal(pickPauseMs(range, () => 0), 60000);
  assert.equal(pickPauseMs(range, () => 1), 300000);
  for (let i = 0; i < 200; i++) { const ms = pickPauseMs(range); assert.ok(ms >= 60000 && ms <= 300000); }
});

test('SettingsManager guarda as preferências de envio com faixas seguras', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upl-'));
  const sm = new SettingsManager(dir, dir);
  sm.save({ uploadAutoEnabled: 'sim', uploadPauseMinSec: -5, uploadPauseMaxSec: 99999, uploadDailyLimit: 500, uploadDefaultVisibility: 'x' });
  const s = sm.load();
  assert.equal(s.uploadAutoEnabled, false, 'só true literal liga');
  assert.equal(s.uploadPauseMinSec, 0);
  assert.equal(s.uploadPauseMaxSec, 3600);
  assert.equal(s.uploadDailyLimit, 100);
  assert.equal(s.uploadDefaultVisibility, 'private', 'valor inválido mantém o atual');
  sm.save({ uploadPauseMinSec: 200, uploadPauseMaxSec: 100 });
  assert.equal(sm.load().uploadPauseMaxSec, 200, 'máximo sobe até o mínimo');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('título padrão: nome do arquivo sem extensão, "_" vira espaço, limitado a 100 caracteres', () => {
  assert.equal(defaultTitle('C:\\v\\meu_video_final.mp4'), 'meu video final');
  assert.equal(defaultTitle('/x/' + 'a'.repeat(150) + '.mov').length, 100);
});

// ---------------------------------------------------------------- fila

test('add: título padrão, visibilidade das preferências, sem duplicar o mesmo arquivo; update e remove', () => {
  const { q } = makeQueue({ uploadDefaultVisibility: 'unlisted' });
  const added = q.add(['C:\\v\\a.mp4', { path: 'C:\\v\\b.mp4', title: 'B', description: 'desc', visibility: 'public' }, 'C:\\v\\a.mp4']);
  assert.equal(added.length, 2);
  assert.deepEqual([added[0].title, added[0].visibility, added[0].status], ['a', 'unlisted', 'queued']);
  assert.deepEqual([added[1].title, added[1].description, added[1].visibility], ['B', 'desc', 'public']);

  assert.equal(q.update(added[0].id, { title: '  Novo  ', visibility: 'secret' }).ok, true);
  assert.deepEqual([q.items[0].title, q.items[0].visibility], ['Novo', 'unlisted'], 'visibilidade inválida é ignorada');
  assert.equal(q.update('nope', {}).ok, false);

  assert.equal(q.remove(added[1].id).ok, true);
  assert.equal(q.items.length, 1);
  assert.equal(q.add('C:\\v\\b.mp4').length, 1, 'removido pode voltar');
});

test('start: recusa com envio automático desligado ou sem a página do Studio', () => {
  const { q } = makeQueue({ uploadAutoEnabled: false });
  assert.match(q.start(fakeDriver()).error, /desligado/);
  const { q: q2 } = makeQueue();
  assert.match(q2.start(null).error, /não está disponível/);
});

test('fila: envia em ordem, um por vez, com pausa aleatória entre os envios e sem pausa depois do último', async () => {
  const { q, c } = makeQueue({ uploadPauseEnabled: true, uploadPauseMinSec: 100, uploadPauseMaxSec: 200 });
  const waits = [];
  q.on('wait', (w) => waits.push(w));
  q.add(['C:\\v\\1.mp4', 'C:\\v\\2.mp4', 'C:\\v\\3.mp4']);
  const d = fakeDriver();
  assert.equal(q.start(d).ok, true);
  await finished(q);
  assert.deepEqual(d.calls.map((x) => x.path), ['C:\\v\\1.mp4', 'C:\\v\\2.mp4', 'C:\\v\\3.mp4']);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done', 'done']);
  assert.equal(q.items[0].videoUrl, 'https://youtu.be/1');
  // 2 pausas (entre 1-2 e 2-3), cada uma com início e fim; random=0.5 → 150 s
  const starts = waits.filter((w) => w.until);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].seconds, 150);
  assert.equal(waits.filter((w) => !w.until).length, 2);
  assert.equal(q.doneToday(), 3);
  void c;
});

test('fila: skipWait encurta a pausa; pause interrompe antes do próximo', async () => {
  const { q } = makeQueue({ uploadPauseEnabled: true, uploadPauseMinSec: 3000, uploadPauseMaxSec: 3000 });
  q.add(['C:\\v\\1.mp4', 'C:\\v\\2.mp4', 'C:\\v\\3.mp4']);
  const d = fakeDriver();
  let pulled = false;
  q.on('wait', (w) => {
    if (!w.until) return;
    if (!pulled) { pulled = true; q.skipWait(); } else q.pause();
  });
  q.start(d);
  await finished(q);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done', 'queued']);
  assert.equal(q.paused, true);
  // Continuar retoma de onde parou
  q.start();
  await finished(q);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done', 'done']);
});

test('fila: falha de um vídeo não para os outros; retry devolve à fila', async () => {
  const { q } = makeQueue();
  q.add(['C:\\v\\1.mp4', 'C:\\v\\2.mp4']);
  const failed = [];
  q.on('item-failed', (i) => failed.push(i.name));
  q.start(fakeDriver([new Error('O YouTube recusou o envio: formato inválido')]));
  await finished(q);
  assert.deepEqual(q.items.map((i) => i.status), ['failed', 'done']);
  assert.match(q.items[0].error, /recusou/);
  assert.deepEqual(failed, ['1.mp4']);
  assert.equal(q.retry(q.items[0].id).ok, true);
  assert.equal(q.items[0].status, 'queued');
  q.clearCompleted();
  assert.equal(q.items.length, 1);
});

test('fila: pedido de atenção (verificação do Google) para a fila sem marcar o vídeo como falha', async () => {
  const { q } = makeQueue();
  q.add(['C:\\v\\1.mp4', 'C:\\v\\2.mp4']);
  const att = [];
  q.on('attention', (a) => att.push(a));
  const d = fakeDriver([new AttentionError('Confirme a conta.')]);
  q.start(d);
  await finished(q);
  assert.equal(att.length, 1);
  assert.equal(q.attention.kind, 'verify');
  assert.deepEqual(q.items.map((i) => i.status), ['queued', 'queued'], 'nada falhou, nada foi enviado');
  assert.equal(d.calls.length, 1);
  // O usuário resolve na página e clica em Continuar
  q.start();
  assert.equal(q.attention, null);
  await finished(q);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done']);
});

test('fila: limite diário para a fila e persiste entre instâncias (arquivo de histórico)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upl-'));
  const store = path.join(dir, 'youtube-uploads.json');
  const { q } = makeQueue({ uploadDailyLimit: 2 }, { storeFile: store });
  q.add(['C:\\v\\1.mp4', 'C:\\v\\2.mp4', 'C:\\v\\3.mp4']);
  q.start(fakeDriver());
  await finished(q);
  assert.deepEqual(q.items.map((i) => i.status), ['done', 'done', 'queued']);
  assert.equal(q.attention.kind, 'limit');
  assert.equal(q.getState().doneToday, 2);

  const { q: q2 } = makeQueue({ uploadDailyLimit: 2 }, { storeFile: store });
  assert.equal(q2.doneToday(), 2, 'o histórico sobrevive ao reinício');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fila: remover o vídeo em envio cancela no driver e marca como cancelado', async () => {
  const { q } = makeQueue();
  const [a] = q.add(['C:\\v\\1.mp4']);
  let release;
  const d = fakeDriver([() => new Promise((r) => { release = r; })]);
  q.start(d);
  while (!release) await flush();
  assert.equal(q.items[0].status, 'uploading');
  assert.equal(q.items[0].progress, 50);
  assert.equal(q.remove(a.id).cancelled, true);
  assert.equal(d.cancelled, 1);
  release({ videoUrl: null });
  await finished(q);
  assert.equal(q.items[0].status, 'cancelled');
  assert.equal(q.doneToday(), 0);
});

test('getState devolve cópias (mudar o retorno não altera a fila)', () => {
  const { q } = makeQueue();
  q.add(['C:\\v\\1.mp4']);
  const st = q.getState();
  st.items[0].title = 'hack';
  assert.notEqual(q.items[0].title, 'hack');
  assert.equal(st.enabled, true);
  assert.equal(st.dailyLimit, 10);
});

// ---------------------------------------------------------------- miniatura, playlist e padrões

test('miniatura automática: imagem com o mesmo nome do vídeo na mesma pasta (jpg, jpeg, png, webp)', () => {
  const { findThumbnail } = YoutubeUploadQueue;
  const have = new Set(['C:\\v\\a.png', 'C:\\v\\b.JPG']);
  const exists = (p) => have.has(p);
  assert.equal(findThumbnail('C:\\v\\a.mp4', exists), 'C:\\v\\a.png');
  assert.equal(findThumbnail('C:\\v\\b.mp4', exists), 'C:\\v\\b.JPG');
  assert.equal(findThumbnail('C:\\v\\c.mp4', exists), '');
  assert.equal(findThumbnail('', exists), '');
});

test('miniatura automática de verdade no disco e entrada na fila com ela', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upl-'));
  const video = path.join(dir, 'aula 01.mp4');
  fs.writeFileSync(video, 'x');
  fs.writeFileSync(path.join(dir, 'aula 01.jpg'), 'x');
  const { q } = makeQueue();
  const [item] = q.add([video]);
  assert.equal(item.thumbnail, path.join(dir, 'aula 01.jpg'));
  assert.equal(item.playlist, '');
  // Remover a miniatura e trocar a playlist por vídeo
  q.update(item.id, { thumbnail: '', playlist: '  Aulas 2026  ' });
  assert.equal(q.items[0].thumbnail, '');
  assert.equal(q.items[0].playlist, 'Aulas 2026');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('padrões da fila: descrição e playlist valem para os novos; applyToQueued muda só os ainda não enviados; persistem', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upl-'));
  const store = path.join(dir, 'youtube-uploads.json');
  const { q } = makeQueue({}, { storeFile: store });
  const [a] = q.add(['C:\\v\\1.mp4']);
  q.start(fakeDriver());
  await finished(q);
  const [b] = q.add(['C:\\v\\2.mp4']);
  assert.equal(b.description, '');

  q.setDefaults({ description: 'Inscreva-se!', playlist: 'Lives' });
  const [c] = q.add(['C:\\v\\3.mp4']);
  assert.deepEqual([c.description, c.playlist], ['Inscreva-se!', 'Lives']);
  assert.equal(q.items.find((i) => i.id === b.id).description, '', 'sem applyToQueued os antigos ficam');

  q.setDefaults({ description: 'Nova' }, { applyToQueued: true });
  assert.equal(q.items.find((i) => i.id === b.id).description, 'Nova');
  assert.equal(q.items.find((i) => i.id === b.id).playlist, '', 'playlist não foi passada: fica como estava (vazia)');
  assert.equal(q.items.find((i) => i.id === c.id).playlist, 'Lives');
  assert.equal(q.items.find((i) => i.id === a.id).description, '', 'já enviado não muda');
  assert.deepEqual(q.getState().defaults, { description: 'Nova', playlist: 'Lives' });

  const { q: q2 } = makeQueue({}, { storeFile: store });
  assert.deepEqual(q2.defaults, { description: 'Nova', playlist: 'Lives' }, 'padrões sobrevivem ao reinício');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('driver recebe miniatura e playlist; avisos não fatais ficam no item', async () => {
  const { q } = makeQueue();
  q.add([{ path: 'C:\\v\\1.mp4', thumbnail: 'C:\\v\\1.png', playlist: 'Lives' }]);
  const d = fakeDriver([() => ({ videoUrl: 'https://youtu.be/x', warnings: ['Playlist não aplicada: não há playlist chamada "Lives" na conta.'] })]);
  q.start(d);
  await finished(q);
  assert.deepEqual([d.calls[0].thumbnail, d.calls[0].playlist], ['C:\\v\\1.png', 'Lives']);
  assert.equal(q.items[0].status, 'done');
  assert.match(q.items[0].warnings[0], /Playlist não aplicada/);
});

// ---------------------------------------------------------------- driver / handlers

test('seletores do Studio: regex de progresso e de "upload concluído" cobrem PT e EN', () => {
  assert.equal(Number('Enviando 43%...'.match(PERCENT_RE)[1]), 43);
  assert.equal(Number('43% uploaded'.match(PERCENT_RE)[1]), 43);
  assert.ok(UPLOADED_RE.test('Upload concluído. Processando...'));
  assert.ok(UPLOADED_RE.test('Checks complete. No issues found.'));
  assert.ok(STUDIO_SELECTORS.attentionText.test('Confirme que é você'));
  assert.ok(STUDIO_SELECTORS.attentionText.test("Verify it's you"));
  assert.ok(STUDIO_SELECTORS.limitText.test('Daily upload limit reached'));
  assert.ok(Object.isFrozen(STUDIO_SELECTORS));
});

test('guestProblem: só aceita o webview da janela principal aberto no YouTube Studio', () => {
  const main = { webContents: { id: 1 } };
  const guest = (url, type = 'webview', hostId = 1) => ({ getType: () => type, getURL: () => url, hostWebContents: { id: hostId }, isDestroyed: () => false });
  assert.equal(guestProblem(guest('https://studio.youtube.com/channel/UC1'), main), null);
  assert.match(guestProblem(null, main), /não está aberta/);
  assert.match(guestProblem(guest('https://studio.youtube.com/', 'window'), main), /não é a do YouTube Studio/);
  assert.match(guestProblem(guest('https://studio.youtube.com/', 'webview', 9), main), /outra janela/);
  assert.match(guestProblem(guest('https://accounts.google.com/signin'), main), /Entre na sua conta/);
  assert.match(guestProblem(guest('https://www.youtube.com/'), main), /Abra o YouTube Studio/);
});
