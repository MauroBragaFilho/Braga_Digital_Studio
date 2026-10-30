'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Os serviços gravam log; manda para uma pasta temporária em vez de logs/ do projeto
process.env.BMD_LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-rec-logs-'));

const carver = require('../src/services/recovery/photoCarver');
const common = require('../src/services/recovery/common');
const JpgRecoveryService = require('../src/services/jpgRecoveryService');
const RawRecoveryService = require('../src/services/rawRecoveryService');
const VideoRecoveryService = require('../src/services/videoRecoveryService');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bds-rec-test-'));
const noCheck = async () => null; // sem motor de mídia: só a estrutura é verificada

/** JPEG sintético (estrutura válida; os dados de entropia são só preenchimento sem marcadores). */
function makeJpeg({ w = 640, h = 480, sof = 0xc0, entropy = 2000, complete = true, thumb = null } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (thumb) {
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), thumb]);
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, body);
  }
  parts.push(Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 8));
  const sofSeg = Buffer.alloc(17);
  sofSeg.writeUInt16BE(17, 0); sofSeg[2] = 8; sofSeg.writeUInt16BE(h, 3); sofSeg.writeUInt16BE(w, 5); sofSeg[7] = 3;
  parts.push(Buffer.from([0xff, sof]), sofSeg);
  parts.push(Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x00]), Buffer.alloc(28, 1));
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]));
  const data = Buffer.alloc(entropy, 0x55);
  data[10] = 0xff; data[11] = 0x00; // byte stuffing válido
  parts.push(data);
  if (complete) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test('scanJpeg: lê um JPEG completo, suas dimensões e o fim', () => {
  const j = makeJpeg({ w: 800, h: 600 });
  const s = carver.scanJpeg(j);
  assert.equal(s.complete, true);
  assert.equal(s.width, 800);
  assert.equal(s.height, 600);
  assert.equal(s.end, j.length);
  assert.ok(carver.hasDecodableHeaders(s));
});

test('scanJpeg: JPEG cortado fica incompleto mas mantém o cabeçalho', () => {
  const s = carver.scanJpeg(makeJpeg({ complete: false, entropy: 500 }));
  assert.equal(s.complete, false);
  assert.ok(carver.hasDecodableHeaders(s));
});

test('scanJpeg: cabeçalho cortado no meio não é decodificável', () => {
  const s = carver.scanJpeg(makeJpeg().subarray(0, 40));
  assert.equal(s.complete, false);
  assert.equal(carver.hasDecodableHeaders(s), false);
});

test('findEmbeddedJpegs: acha miniatura aninhada e ignora dados lossless (SOF3) do sensor', () => {
  const thumb = makeJpeg({ w: 160, h: 120, entropy: 100 });
  const big = makeJpeg({ w: 6000, h: 4000, entropy: 5000, thumb });
  const sensor = makeJpeg({ w: 8000, h: 6000, sof: 0xc3, entropy: 9000 });
  const raw = Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(500, 0x11), sensor, Buffer.alloc(300, 0x22), big]);
  const found = carver.findEmbeddedJpegs(raw);
  assert.equal(found.some((f) => f.sofType === 0xc3), false);
  const best = carver.pickBestJpeg(found);
  assert.equal(best.width, 6000);
  assert.equal(found.some((f) => f.width === 160), true);
});

test('pickBestJpeg: prefere completo a incompleto mesmo que o incompleto seja maior', () => {
  const small = carver.scanJpeg(makeJpeg({ w: 100, h: 100 }));
  const bigPartial = carver.scanJpeg(makeJpeg({ w: 4000, h: 3000, complete: false }));
  assert.equal(carver.pickBestJpeg([bigPartial, small]), small);
  assert.equal(carver.pickBestJpeg([]), null);
});

test('detectContainer e readTiffMakeModel', () => {
  assert.equal(carver.detectContainer(Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(20)])), 'tiff');
  assert.equal(carver.detectContainer(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypcrx '), Buffer.alloc(20)])), 'isobmff');
  assert.equal(carver.detectContainer(Buffer.alloc(40)), null);

  const t = Buffer.alloc(80);
  t.write('II', 0); t.writeUInt16LE(0x2a, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(2, 8);
  t.writeUInt16LE(0x010f, 10); t.writeUInt16LE(2, 12); t.writeUInt32LE(6, 14); t.writeUInt32LE(40, 18);
  t.writeUInt16LE(0x0110, 22); t.writeUInt16LE(2, 24); t.writeUInt32LE(9, 26); t.writeUInt32LE(50, 30);
  t.write('Canon\0', 40, 'latin1'); t.write('EOS 5D\0', 50, 'latin1');
  assert.deepEqual(carver.readTiffMakeModel(t), { make: 'Canon', model: 'EOS 5D' });
  assert.equal(carver.readTiffMakeModel(Buffer.alloc(30)), null);
});

test('JpgRecoveryService: remove bytes extras e preserva o original', async () => {
  const d = tmp();
  const jpg = makeJpeg();
  const file = path.join(d, 'foto.jpg');
  const original = Buffer.concat([Buffer.alloc(37, 0x99), jpg, Buffer.alloc(50, 0xab)]);
  fs.writeFileSync(file, original);

  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  const diag = await svc.diagnose(file);
  assert.equal(diag.suggestedStrategy, 'LIMPEZA');
  const r = await svc.recoverJpg({ corruptPath: file });
  assert.equal(r.resultQuality, 'RECUPERAÇÃO COMPLETA');
  assert.deepEqual(fs.readFileSync(r.outputPath), jpg);
  assert.deepEqual(fs.readFileSync(file), original, 'o original não pode mudar');
  fs.rmSync(d, { recursive: true, force: true });
});

test('JpgRecoveryService: foto cortada é fechada com EOI e marcada como parcial', async () => {
  const d = tmp();
  const file = path.join(d, 'cortada.jpg');
  fs.writeFileSync(file, Buffer.concat([makeJpeg({ complete: false, entropy: 800 }), Buffer.alloc(200, 0)])); // cartão zerou o fim

  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  const r = await svc.recoverJpg({ corruptPath: file });
  assert.equal(r.resultQuality, 'RECUPERAÇÃO PARCIAL');
  const out = fs.readFileSync(r.outputPath);
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
  assert.equal(carver.scanJpeg(out).complete, true);
  assert.ok(r.warnings.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JpgRecoveryService: imagem principal destruída cai na miniatura embutida', async () => {
  const d = tmp();
  const thumb = makeJpeg({ w: 160, h: 120, entropy: 100 });
  const broken = makeJpeg({ thumb }).subarray(0, 25 + thumb.length + 30); // corta logo depois da miniatura, antes de SOF/SOS
  const file = path.join(d, 'sem-cabecalho.jpg');
  fs.writeFileSync(file, broken);

  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  assert.equal((await svc.diagnose(file)).suggestedStrategy, 'EXTRAIR_MINIATURA');
  const r = await svc.recoverJpg({ corruptPath: file });
  assert.equal(r.methodUsed, 'Extração da miniatura embutida');
  assert.equal(r.resolution, '160x120');
  fs.rmSync(d, { recursive: true, force: true });
});

test('JpgRecoveryService: arquivo íntegro não gera cópia; sem imagem dá erro e emite error', async () => {
  const d = tmp();
  const ok = path.join(d, 'ok.jpg');
  fs.writeFileSync(ok, makeJpeg());
  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  const r = await svc.recoverJpg({ corruptPath: ok });
  assert.equal(r.unchanged, true);
  assert.deepEqual(fs.readdirSync(d), ['ok.jpg']);

  const lixo = path.join(d, 'lixo.jpg');
  fs.writeFileSync(lixo, Buffer.alloc(5000, 0x41));
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  await assert.rejects(() => svc.recoverJpg({ corruptPath: lixo }), /Não foi possível recuperar/);
  assert.equal(errors.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JpgRecoveryService: nunca sobrescreve uma recuperação anterior', async () => {
  const d = tmp();
  const file = path.join(d, 'f.jpg');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(10, 0x99), makeJpeg()]));
  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  const a = await svc.recoverJpg({ corruptPath: file });
  const b = await svc.recoverJpg({ corruptPath: file });
  assert.notEqual(a.outputPath, b.outputPath);
  assert.equal(fs.existsSync(a.outputPath), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('JpgRecoveryService: não decodificável pelo motor descarta o candidato e tenta o próximo', async () => {
  const d = tmp();
  const thumb = makeJpeg({ w: 160, h: 120, entropy: 100 });
  const file = path.join(d, 'f.jpg');
  fs.writeFileSync(file, Buffer.concat([Buffer.alloc(5, 0x99), makeJpeg({ thumb })]));
  let calls = 0;
  const svc = new JpgRecoveryService({
    decodeCheckFn: async (p) => {
      calls++;
      return p.includes('f_recuperado') && calls === 1 ? { ok: false, decoded: false, message: 'erro' } : { ok: true, decoded: true, message: '' };
    },
  });
  const r = await svc.recoverJpg({ corruptPath: file });
  assert.equal(r.methodUsed, 'Extração da miniatura embutida');
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.part')), []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('RawRecoveryService: sem o motor RAW extrai a pré-visualização em JPG', async () => {
  const d = tmp();
  const preview = makeJpeg({ w: 6000, h: 4000, entropy: 4000 });
  const header = Buffer.alloc(600, 0x11); header.write('II*\0', 0, 'latin1');
  const raw = path.join(d, 'IMG_0001.CR2');
  fs.writeFileSync(raw, Buffer.concat([header, makeJpeg({ w: 8000, h: 6000, sof: 0xc3 }), preview, Buffer.alloc(100, 0)]));

  const svc = new RawRecoveryService({ decodeCheckFn: noCheck });
  svc._engineAvailable = () => false;
  const diag = await svc.diagnose(raw);
  assert.equal(diag.suggestedStrategy, 'PREVIEW_RECOVERY');
  assert.equal(diag.corrupted.previewResolution, '6000x4000');

  const r = await svc.recoverRaw({ corruptPath: raw });
  assert.equal(path.extname(r.outputPath), '.jpg');
  assert.equal(r.resultQuality, 'RECUPERAÇÃO PARCIAL');
  assert.deepEqual(fs.readFileSync(r.outputPath), preview);
  assert.ok(fs.existsSync(raw));
  fs.rmSync(d, { recursive: true, force: true });
});

test('RawRecoveryService: aceita CR3/DNG/RAF, recusa formatos desconhecidos e arquivo sem imagem falha limpo', async () => {
  const d = tmp();
  const svc = new RawRecoveryService({ decodeCheckFn: noCheck });
  svc._engineAvailable = () => false;
  for (const ext of ['.cr3', '.dng', '.raf', '.orf', '.rw2']) assert.ok(RawRecoveryService.SUPPORTED_RAW_EXTENSIONS.includes(ext));

  const txt = path.join(d, 'a.txt');
  fs.writeFileSync(txt, 'x');
  await assert.rejects(() => svc.diagnose(txt), /não suportado/);

  const vazio = path.join(d, 'vazio.cr3');
  fs.writeFileSync(vazio, Buffer.alloc(4000, 0x33));
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  await assert.rejects(() => svc.recoverRaw({ corruptPath: vazio }), /não há pré-visualização aproveitável/);
  assert.equal(errors.length, 1);
  assert.deepEqual(fs.readdirSync(d).sort(), ['a.txt', 'vazio.cr3']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('trava global: duas recuperações simultâneas não rodam juntas', async () => {
  const release = common.recoveryLock.acquire('video');
  const d = tmp();
  const f = path.join(d, 'a.jpg');
  fs.writeFileSync(f, makeJpeg());
  const svc = new JpgRecoveryService({ decodeCheckFn: noCheck });
  await assert.rejects(() => svc.recoverJpg({ corruptPath: f }), /recuperação em andamento/);
  release();
  assert.equal((await svc.recoverJpg({ corruptPath: f })).unchanged, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('assessVideoOutput: avisa quando a saída tem bem menos que o original', () => {
  assert.equal(common.assessVideoOutput({ durationSec: 100, sizeBytes: 1e9 }, { durationSec: 98, sizeBytes: 9e8 }).complete, true);
  const perda = common.assessVideoOutput({ durationSec: 100, sizeBytes: 1e9 }, { durationSec: 2, sizeBytes: 9e8 });
  assert.equal(perda.complete, false);
  assert.match(perda.warnings[0], /2% da duração/);
  // sem duração do original (cabeçalho perdido), compara o tamanho
  assert.equal(common.assessVideoOutput({ durationSec: null, sizeBytes: 4e9 }, { durationSec: 3, sizeBytes: 1e6 }).complete, false);
  assert.equal(common.assessVideoOutput({ durationSec: null, sizeBytes: 4e9 }, { durationSec: 30, sizeBytes: 3e9 }).complete, true);
});

test('parseFfmpegProgressSeconds lê out_time_us / out_time_ms', () => {
  assert.equal(common.parseFfmpegProgressSeconds('out_time_us=2500000'), 2.5);
  assert.equal(common.parseFfmpegProgressSeconds('out_time_ms=1000000'), 1);
  assert.equal(common.parseFfmpegProgressSeconds('frame=10'), null);
});

test('moveFile e safeRmDir', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a'), 'x');
  common.moveFile(path.join(d, 'a'), path.join(d, 'b'));
  assert.equal(fs.existsSync(path.join(d, 'a')), false);
  assert.equal(fs.readFileSync(path.join(d, 'b'), 'utf8'), 'x');
  common.safeRmDir(d);
  assert.equal(fs.existsSync(d), false);
});

test('vídeo: plano de tentativas usa todas as alternativas e explica o que foi pulado', () => {
  const svc = new VideoRecoveryService({});
  svc._untruncAvailable = () => true;
  const legivel = { corrupted: { readable: true }, suggestedLevel: 'NIVEL_1_RAPIDO' };
  const ilegivel = { corrupted: { readable: false }, suggestedLevel: 'NIVEL_2_ESTRUTURAL' };

  assert.deepEqual(svc._buildPlan('AUTO', legivel, true).plan.map((s) => s.id), ['level1', 'level2']);
  assert.deepEqual(svc._buildPlan('AUTO', ilegivel, true).plan.map((s) => s.id), ['level2', 'level1']);
  assert.deepEqual(svc._buildPlan('AUTO', ilegivel, false).plan.map((s) => s.id), ['level1'], 'sem referência ainda tenta o nível 1');
  assert.deepEqual(svc._buildPlan('NIVEL_2', legivel, true).plan.map((s) => s.id), ['level2', 'level1']);

  svc._untruncAvailable = () => false;
  const p = svc._buildPlan('AUTO', ilegivel, true);
  assert.deepEqual(p.plan.map((s) => s.id), ['level1']);
  assert.match(p.skipped[0], /não está instalado/);
});

test('vídeo: só aceita como saída do Untrunc o arquivo novo, nunca um _fixed antigo', async () => {
  const d = tmp();
  const svc = new VideoRecoveryService({});
  fs.writeFileSync(path.join(d, 'clip_fixed.mp4'), 'antigo');
  const before = svc._listFixed(d, 'clip_fixed');
  assert.deepEqual(svc._newFixed(d, 'clip_fixed', before), []);

  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(d, 'clip_fixed.mov'), 'novo');
  const novos = svc._newFixed(d, 'clip_fixed', before);
  assert.equal(novos.length, 1);
  assert.equal(path.basename(novos[0].file), 'clip_fixed.mov');

  // nome real do Untrunc: "<nome completo>_fixed.<ext>"
  const prefixos = ['clip.mp4_fixed', 'clip_fixed'];
  const antes = svc._listFixed(d, prefixos);
  fs.writeFileSync(path.join(d, 'clip.mp4_fixed.mp4'), 'gerado');
  const achados = svc._newFixed(d, prefixos, antes);
  assert.deepEqual(achados.map((a) => path.basename(a.file)), ['clip.mp4_fixed.mp4']);
  fs.rmSync(d, { recursive: true, force: true });
});
