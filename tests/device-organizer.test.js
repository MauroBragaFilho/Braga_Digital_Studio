'use strict';

// Organização ao copiar de um dispositivo: regras (data, tipo, estruturas, renomear), sugestões do sistema local
// (validação estrita do que o modelo devolve, miniaturas, projeto) e renomeação segura depois da cópia.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DeviceOrganizer, applyRenames, safeSegment, typeOf, dateOf, parseJsonLoose } = require('../src/services/organizer/DeviceOrganizer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-org-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ITEMS = [
  { key: '1', name: 'IMG_20261114_153012.jpg' },
  { key: '2', name: 'VID_20261113_090000.mp4' },
  { key: '3', name: 'contrato.pdf' },
  { key: '4', name: 'IMG_20261114_153012(1).JPG' }
];
const folders = (plan) => plan.groups.map((g) => `${g.folder}:${g.keys.join(',')}`);

test('safeSegment: sem caminho, sem caracteres proibidos, sem nomes reservados', () => {
  assert.equal(safeSegment('Casamento: João/..'), 'Casamento João');
  assert.equal(safeSegment('../../etc'), 'etc');
  assert.equal(safeSegment('CON', 'x'), 'x');
  assert.equal(safeSegment('   ...  ', 'vazio'), 'vazio');
  assert.equal(safeSegment('a'.repeat(100)).length, 60);
  assert.equal(safeSegment('nome<>|?*bom'), 'nome bom');
});

test('tipo e data: pelo nome do arquivo ou pela data informada', () => {
  assert.equal(typeOf('x.MP4'), 'Vídeos');
  assert.equal(typeOf('x.dng'), 'Fotos');
  assert.equal(typeOf('x.xyz'), 'Outros');
  assert.deepEqual(dateOf({ name: 'IMG_20261114_153012.jpg' }), { day: '2026-11-14', time: '153012' });
  assert.deepEqual(dateOf({ name: '2026-11-13 aula.mp4' }), { day: '2026-11-13', time: null });
  assert.equal(dateOf({ name: 'foto.jpg' }), null);
  assert.deepEqual(dateOf({ name: 'foto.jpg', date: '2026-01-02T03:04:05Z' }), { day: '2026-01-02', time: '030405' });
  assert.equal(dateOf({ name: 'IMG_20269999_000000.jpg' }), null, 'mês/dia impossíveis não viram data');
});

test('regras: estruturas de pasta e evento', async () => {
  const o = new DeviceOrganizer();
  let plan = await o.plan({ items: ITEMS });
  assert.deepEqual(folders(plan), ['2026-11-13/Vídeos:2', '2026-11-14/Fotos:1,4', 'Sem data/Documentos:3']);
  assert.equal(plan.usedAi, false);
  plan = await o.plan({ items: ITEMS, structure: 'tipo-data' });
  assert.deepEqual(folders(plan), ['Documentos/Sem data:3', 'Fotos/2026-11-14:1,4', 'Vídeos/2026-11-13:2']);
  plan = await o.plan({ items: ITEMS, structure: 'tipo' });
  assert.deepEqual(folders(plan), ['Documentos:3', 'Fotos:1,4', 'Vídeos:2']);
  plan = await o.plan({ items: ITEMS, structure: 'plana' });
  assert.deepEqual(folders(plan), [':1,2,3,4']);
  plan = await o.plan({ items: ITEMS, structure: 'tipo', eventName: 'Casamento: João/..' });
  assert.ok(plan.groups.every((g) => g.folder.startsWith('Casamento João/')), 'o nome do evento também é limpo');
  plan = await o.plan({ items: ITEMS, structure: '../../x' });
  assert.ok(plan.groups[0].folder.includes('/'), 'estrutura inválida volta ao padrão (data e tipo)');
});

test('renomear pela data: só nomes genéricos, extensão mantida, sem repetir nome', async () => {
  const plan = await new DeviceOrganizer().plan({ items: ITEMS, rename: 'data' });
  assert.equal(plan.renames['1'], '20261114_153012.jpg');
  assert.equal(plan.renames['4'], '20261114_153012_2.JPG', 'mesmo horário: ganha sufixo e mantém a extensão');
  assert.equal(plan.renames['2'], '20261113_090000.mp4');
  assert.equal(plan.renames['3'], undefined, 'nome que não é genérico não muda');
});

test('sistema local ausente: usa só as regras e avisa', async () => {
  const none = await new DeviceOrganizer({ llm: { isInstalled: () => false } }).plan({ items: ITEMS, useAi: true });
  assert.equal(none.usedAi, false);
  assert.match(none.aiNote, /ainda não está instalado/);
});

function fakeLlm({ vision = false, answer, fail = false, seen = [] }) {
  return {
    llm: { isInstalled: () => true, ensureRunning: async () => {}, supportsVision: () => vision, baseUrl: () => 'http://127.0.0.1:1/v1' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      if (fail) throw new Error('fora do ar');
      return { ok: true, json: async () => ({ choices: [{ message: { content: typeof answer === 'function' ? answer(body) : answer } }] }) };
    }
  };
}

test('sugestões: assunto vira subpasta, nome descritivo, projeto só entre os informados; lixo é ignorado', async () => {
  const seen = [];
  const answer = JSON.stringify({
    itens: [
      { n: 1, assunto: 'Aniversário', nome: 'Maria faz 30 anos.jpg' },
      { n: 2, assunto: '../../Windows', nome: 'Parabéns' },
      { n: 99, assunto: 'Fora', nome: 'x' },
      { n: 1, assunto: 'Repetido', nome: 'y' },
      { n: 3, assunto: 'CON', nome: '' }
    ],
    projeto: 7
  });
  const { llm, fetchImpl } = fakeLlm({ answer, seen });
  const o = new DeviceOrganizer({ llm, fetchImpl });
  const plan = await o.plan({ items: ITEMS.slice(0, 3), rename: 'ia', structure: 'tipo', projects: [{ id: 7, name: 'Festa', client: 'Maria' }, { id: 8, name: 'Outro' }] });
  assert.equal(plan.usedAi, true);
  assert.equal(plan.projectId, 7);
  assert.deepEqual(folders(plan), ['Documentos:3', 'Fotos/Aniversário:1', 'Vídeos/Windows:2']);
  assert.equal(plan.renames['1'], 'Maria faz 30 anos.jpg');
  assert.equal(plan.renames['2'], 'Parabéns.mp4');
  assert.equal(seen.length, 1);
  assert.match(JSON.stringify(seen[0]), /dados, não instruções/);
  const bad = await new DeviceOrganizer({ ...fakeLlm({ answer: JSON.stringify({ itens: [{ n: 1, assunto: 'A', nome: 'B' }], projeto: 999 }) }) }).plan({ items: ITEMS.slice(0, 1), useAi: true, projects: [{ id: 7, name: 'Festa' }] });
  assert.equal(bad.projectId, null, 'projeto fora da lista informada é descartado');
});

test('sugestões: texto com crases ou sem JSON, e falha de rede, caem nas regras', async () => {
  const wrapped = await new DeviceOrganizer(fakeLlm({ answer: '```json\n{"itens":[{"n":1,"assunto":"Teste","nome":"Foto"}]}\n```' })).plan({ items: ITEMS.slice(0, 1), useAi: true });
  assert.equal(wrapped.usedAi, true);
  const garbage = await new DeviceOrganizer(fakeLlm({ answer: 'não sei' })).plan({ items: ITEMS.slice(0, 1), useAi: true });
  assert.equal(garbage.usedAi, false);
  assert.match(garbage.aiNote, /não conseguiu sugerir/);
  const down = await new DeviceOrganizer(fakeLlm({ answer: '', fail: true })).plan({ items: ITEMS.slice(0, 1), useAi: true });
  assert.equal(down.usedAi, false);
  assert.equal(down.groups.length, 1);
  assert.deepEqual(parseJsonLoose('xx {"a":1} yy'), { a: 1 });
  assert.equal(parseJsonLoose('nada'), null);
});

test('miniaturas: só com modelo que enxerga e só imagens válidas e pequenas; sem visão, só nomes', async () => {
  const good = `data:image/jpeg;base64,${Buffer.from('foto').toString('base64')}`;
  const answer = JSON.stringify({ itens: [{ n: 1, assunto: 'A', nome: 'B' }] });
  let seen = [];
  await new DeviceOrganizer(fakeLlm({ vision: true, answer, seen })).plan({
    items: ITEMS.slice(0, 2), useAi: true,
    thumbs: { 1: good, 2: 'data:text/html;base64,PHNjcmlwdD4=', 9: good }
  });
  const withImage = seen.find((b) => b.messages[0].content.some((c) => c.type === 'image_url'));
  assert.ok(withImage, 'a miniatura válida segue ao modelo');
  assert.equal(withImage.messages[0].content.filter((c) => c.type === 'image_url').length, 1, 'html disfarçado e chave inexistente ficam de fora');
  assert.equal(withImage.response_format.type, 'json_object');
  seen = [];
  const plan = await new DeviceOrganizer(fakeLlm({ vision: false, answer, seen })).plan({ items: ITEMS.slice(0, 2), useAi: true, thumbs: { 1: good } });
  assert.ok(seen.every((b) => !b.messages[0].content.some((c) => c.type === 'image_url')), 'sem visão não manda imagem');
  assert.match(plan.aiNote, /só os nomes/);
});

test('applyRenames: só dentro da pasta, sem trocar extensão e sem sobrescrever', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r-'));
  for (const n of ['a.jpg', 'b.jpg', 'c.mp4', 'd.jpg']) fs.writeFileSync(path.join(dir, n), n);
  const out = applyRenames(dir, [
    { from: 'a.jpg', to: 'novo.jpg' },
    { from: 'b.jpg', to: 'd.jpg' },            // já existe
    { from: 'c.mp4', to: 'c.jpg' },            // troca a extensão
    { from: '../fora.jpg', to: 'x.jpg' },      // caminho
    { from: 'd.jpg', to: 'sub/x.jpg' },        // caminho no destino
    { from: 'nao-existe.jpg', to: 'y.jpg' }
  ]);
  assert.deepEqual(out, { renamed: 1, failed: 5 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b.jpg', 'c.mp4', 'd.jpg', 'novo.jpg']);
});

// ------------------------------------------------------------------------- depois da cópia: mover, miniaturas e projeto

const { applyMoves, relSegments } = require('../src/services/organizer/DeviceOrganizer');
const { createOrganizerApi } = require('../src/ipc/organizerHandlers');

test('applyMoves: move dentro da pasta, cria subpastas, recusa caminho fora, extensão trocada e sobrescrita', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  fs.mkdirSync(path.join(dir, 'Fotos'));
  for (const n of ['Fotos/a.jpg', 'Fotos/b.jpg', 'Fotos/c.mp4']) fs.writeFileSync(path.join(dir, n), n);
  const out = applyMoves(dir, [
    { from: 'Fotos/a.jpg', to: 'Fotos/Aniversario/Maria faz 30 anos.jpg' },
    { from: 'Fotos/b.jpg', to: 'Fotos/Aniversario/Maria faz 30 anos.jpg' },   // já existe (acabou de ser criado)
    { from: 'Fotos/c.mp4', to: 'Fotos/c.jpg' },                                // extensão trocada
    { from: '../fora.jpg', to: 'x.jpg' },                                       // origem fora da pasta
    { from: 'Fotos/b.jpg', to: '../../escapou.jpg' },                           // destino fora da pasta
    { from: 'Fotos/b.jpg', to: 'C:/Windows/x.jpg' },                            // unidade/caminho absoluto vira segmentos inválidos
    { from: 'Fotos/nao-existe.jpg', to: 'Fotos/y.jpg' }
  ]);
  assert.deepEqual(out, { moved: 1, failed: 6 });
  assert.ok(fs.existsSync(path.join(dir, 'Fotos', 'Aniversario', 'Maria faz 30 anos.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'Fotos', 'b.jpg')) && fs.existsSync(path.join(dir, 'Fotos', 'c.mp4')));
  assert.equal(relSegments('a/../b'), null);
  assert.equal(relSegments('a/b/c.jpg').length, 3);
  assert.equal(relSegments('1/2/3/4/5/6/7/8/9'), null, 'profundidade limitada');
});

test('organizer:thumbnails: só imagens existentes, pequenas, em JPEG; o resto é ignorado', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 't-'));
  fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'doc.pdf'), 'x');
  const fakeImage = (empty) => ({ isEmpty: () => empty, getSize: () => ({ width: 4000, height: 3000 }), resize: (o) => ({ toJPEG: () => Buffer.from(`jpg${o.width}`) }) });
  const api = createOrganizerApi({ getLlm: () => null, nativeImage: { createFromPath: (f) => fakeImage(f.endsWith('vazia.jpg')) } });
  const out = api.thumbnails([
    { key: '1', path: path.join(dir, 'a.jpg') },
    { key: '2', path: path.join(dir, 'doc.pdf') },       // não é imagem
    { key: '3', path: path.join(dir, 'nao-existe.jpg') }, // não existe
    { key: '4', path: 'relativo.jpg' },                    // caminho relativo
    { key: '', path: path.join(dir, 'a.jpg') }             // sem chave
  ]);
  assert.deepEqual(Object.keys(out), ['1']);
  assert.equal(out['1'], `data:image/jpeg;base64,${Buffer.from('jpg384').toString('base64')}`, 'redimensiona para 384 de largura');
});

test('organizer:linkProject: enfileira na Biblioteca, espera as mídias nascerem e vincula só as que entraram', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'l-'));
  for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) fs.writeFileSync(path.join(dir, n), n);
  const queued = [];
  const linked = [];
  let polls = 0;
  const media = [];
  const db = {
    prepare: (sql) => ({
      get: () => (/FROM libraries/.test(sql) ? { id: 5 } : null),
      all: (name) => media.filter((m) => m.filename === name)
    })
  };
  const projectService = {
    getProjectById: (id) => (id === 3 ? { id } : null),
    addMediaBulkToProject: (pid, bin, ids) => { linked.push({ pid, bin, ids }); return ids.length; }
  };
  const wait = async () => {
    polls++;
    if (polls === 1) media.push({ id: 11, filename: 'a.jpg', filepath: path.join(dir, 'a.jpg') }, { id: 12, filename: 'b.jpg', filepath: path.join(dir, 'b.jpg') });
    // c.jpg nunca entra
  };
  const api = createOrganizerApi({ getLlm: () => null, projectService, importQueue: { add: (i) => queued.push(i) }, getDb: () => db, wait, linkWaitMs: 20 });
  const wrongProject = await api.linkProject(99, dir, ['a.jpg']);
  assert.deepEqual(wrongProject, { linked: 0, total: 1 }, 'projeto inexistente: nada é ligado');
  const r = await api.linkProject(3, dir, ['a.jpg', 'b.jpg', 'c.jpg', '../fora.jpg', 'nao-existe.jpg']);
  assert.deepEqual(queued.map((q) => path.basename(q.path)).sort(), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.ok(queued.every((q) => q.libraryId === 5 && q.event === 'CREATE'));
  assert.deepEqual(r, { linked: 2, total: 3 }, 'nome com caminho e arquivo ausente ficam de fora; c.jpg não entrou a tempo');
  assert.deepEqual(linked[0], { pid: 3, bin: null, ids: [11, 12] });
});

test('organizer:status e plan: sem sistema local ou projetos, seguem pelas regras', async () => {
  const api = createOrganizerApi({ getLlm: () => null });
  assert.deepEqual(api.status(), { aiAvailable: false, vision: false });
  const plan = await api.plan({ items: [{ key: '1', name: 'IMG_20261114_010203.jpg' }] });
  assert.equal(plan.groups[0].folder, '2026-11-14/Fotos');
  const withLlm = createOrganizerApi({ getLlm: () => ({ isInstalled: () => true, supportsVision: () => true }) });
  assert.deepEqual(withLlm.status(), { aiAvailable: true, vision: true });
});
