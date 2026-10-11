'use strict';

// Fila de downloads: link repetido, nome de arquivo único ("Nome - 2"), subpasta temporária por item,
// status inicial decidido pelo processo principal e fila sequencial de informações dos links.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const DownloadManager = require('../src/services/downloadService');
const { processRunner } = require('../src/infrastructure/external-tools/ProcessRunner');
const { ytDlpTool } = require('../src/infrastructure/external-tools/adapters/YtDlpTool');
const { uniqueSuffixPath } = require('../src/services/uniquePath');

// Sem banco nos testes
DownloadManager.prototype.initDatabaseQueue = function initDatabaseQueue() { this.queue = []; };

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-dl-dedupe-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function makeManager(folder) {
  const m = new DownloadManager({
    paths: { dataDir: os.tmpdir() },
    getSettings: () => ({ mp3Folder: folder, mp4Folder: folder }),
    historyService: null
  });
  m.saveItemToDb = () => {};
  m.deleteItemFromDb = () => {};
  m.queue = [];
  return m;
}

const YT = 'https://www.youtube.com/watch?v=abc123DEF45';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const duplicate = (fn) => { try { fn(); } catch (e) { return e; } return null; };

// ---------------------------------------------------------------- status inicial e cartão imediato

test('o processo principal decide o status inicial: status/error do pedido são ignorados', () => {
  const m = makeManager(tmpDir());
  const item = m.add({ url: YT, status: 'failed', error: 'Link com erro', title: '' });
  assert.equal(item.status, 'queued');
  assert.equal(item.error, '');
});

test('sem título: nome do site pela URL e título neutro (nunca "erro")', () => {
  const m = makeManager(tmpDir());
  const yt = m.add({ url: YT, format: 'MP4' });
  assert.equal(yt.platform, 'YouTube');
  assert.equal(yt.title, 'Vídeo do YouTube');
  const musica = m.add({ url: 'https://open.spotify.com/track/xyz', format: 'MP3' });
  assert.equal(musica.title, 'Música');
  const vimeo = m.add({ url: 'https://vimeo.com/123', format: 'MP4' });
  assert.equal(vimeo.platform, 'Vimeo');
  assert.equal(vimeo.title, 'Vídeo de Vimeo');
  const outro = m.add({ url: 'https://exemplo.com.br/v/1', format: 'MP3' });
  assert.equal(outro.platform, 'exemplo.com.br');
  assert.equal(outro.title, 'Áudio de exemplo.com.br');
  for (const i of m.queue) assert.doesNotMatch(i.title, /erro|falh/i);
});

test('com título informado (playlist, prévia já carregada) o item não entra na fila de informações', () => {
  const m = makeManager(tmpDir());
  let chamadas = 0;
  m.metadataProvider = async () => { chamadas++; return {}; };
  const item = m.add({ url: YT, title: 'Título pronto', thumbnail: 'x.jpg' });
  assert.equal(item.title, 'Título pronto');
  assert.equal(item.infoLoading, false);
  assert.equal(chamadas, 0);
});

// ---------------------------------------------------------------- link repetido

test('link repetido na fila: youtu.be, watch?v=&list=, music.youtube.com, shorts e live contam como o mesmo vídeo', () => {
  const m = makeManager(tmpDir());
  const primeiro = m.add({ url: YT });
  const variantes = [
    'https://youtu.be/abc123DEF45',
    'https://www.youtube.com/watch?v=abc123DEF45&list=PLxyz&index=3',
    'https://music.youtube.com/watch?v=abc123DEF45',
    'https://m.youtube.com/watch?v=abc123DEF45&si=rastreio',
    'https://www.youtube.com/shorts/abc123DEF45',
    'https://www.youtube.com/live/abc123DEF45?feature=share'
  ];
  for (const url of variantes) {
    const err = duplicate(() => m.add({ url }));
    assert.ok(err, `deveria recusar ${url}`);
    assert.equal(err.code, 'DUPLICATE_QUEUED');
    assert.equal(err.message, 'Este link já está na fila.');
    assert.equal(err.existingId, primeiro.id);
  }
  assert.equal(m.queue.length, 1, 'nenhum cartão novo');
});

test('outros sites: parâmetros de rastreio e barra final são ignorados, mas o id do vídeo conta', () => {
  const m = makeManager(tmpDir());
  m.add({ url: 'https://site.com/v/clip?id=1' });
  assert.equal(duplicate(() => m.add({ url: 'https://site.com/v/clip/?id=1&utm_source=x&fbclid=abc#t=5' })).code, 'DUPLICATE_QUEUED');
  assert.equal(duplicate(() => m.add({ url: 'https://site.com/v/clip?id=2' })), null, 'outro id é outro vídeo');
  assert.equal(m.queue.length, 2);
});

test('mesmo vídeo em outro formato ou qualidade não é repetido', () => {
  const m = makeManager(tmpDir());
  m.add({ url: YT, format: 'MP4', quality: 'best' });
  assert.equal(duplicate(() => m.add({ url: YT, format: 'MP3', quality: '320kbps' })), null);
  assert.equal(duplicate(() => m.add({ url: YT, format: 'MP4', quality: '720p' })), null);
  assert.equal(m.queue.length, 3);
  assert.equal(duplicate(() => m.add({ url: YT, format: 'MP4', quality: '720p' })).code, 'DUPLICATE_QUEUED');
});

test('baixando e pausado também contam como "já está na fila"', () => {
  const m = makeManager(tmpDir());
  const a = m.add({ url: YT });
  for (const st of ['downloading', 'paused']) {
    a.status = st;
    assert.equal(duplicate(() => m.add({ url: YT })).code, 'DUPLICATE_QUEUED', st);
  }
});

test('concluído com o arquivo ainda na pasta: bloqueia e informa o NOME do arquivo (não o caminho)', () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const a = m.add({ url: YT });
  const file = path.join(folder, 'Minha aula.mp4');
  fs.writeFileSync(file, 'conteudo');
  a.status = 'completed'; a.outputPath = file;
  const err = duplicate(() => m.add({ url: 'https://youtu.be/abc123DEF45' }));
  assert.equal(err.code, 'DUPLICATE_DOWNLOADED');
  assert.match(err.message, /Este link já foi baixado/);
  assert.match(err.message, /Minha aula\.mp4/);
  assert.ok(!err.message.includes(folder), 'sem caminho completo');
  assert.equal(err.existingId, a.id);
  assert.equal(m.queue.length, 1);
});

test('concluído mas o arquivo foi apagado, movido ou está vazio: PERMITE baixar de novo e substitui o cartão antigo', () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const removidos = [];
  m.on('downloads:removed', (id) => removidos.push(id));
  const a = m.add({ url: YT });
  a.status = 'completed'; a.outputPath = path.join(folder, 'sumiu.mp4'); // nunca existiu
  const novo = m.add({ url: YT });
  assert.notEqual(novo.id, a.id);
  assert.equal(m.queue.length, 1, 'o cartão antigo concluído sai da fila');
  assert.deepEqual(removidos, [a.id]);

  const vazio = path.join(folder, 'vazio.mp4');
  fs.writeFileSync(vazio, '');
  novo.status = 'completed'; novo.outputPath = vazio;
  assert.equal(duplicate(() => m.add({ url: YT })), null, 'arquivo vazio não conta como baixado');
});

test('falhou ou cancelado: permite de novo e substitui o cartão com erro', () => {
  const m = makeManager(tmpDir());
  for (const st of ['failed', 'cancelled']) {
    const antigo = m.queue.find((i) => i.status === st) || m.add({ url: YT });
    antigo.status = st; antigo.error = 'x';
    const novo = m.add({ url: YT });
    assert.equal(novo.status, 'queued');
    assert.equal(m.queue.length, 1);
    assert.ok(!m.queue.includes(antigo));
    m.queue[0].status = st;
  }
});

// ---------------------------------------------------------------- nome único "Nome - 2"

test('uniqueSuffixPath: número DEPOIS do nome, começando em 2, pulando reservados', () => {
  const dir = tmpDir();
  assert.equal(uniqueSuffixPath(dir, 'Nome.mp4'), path.join(dir, 'Nome.mp4'));
  fs.writeFileSync(path.join(dir, 'Nome.mp4'), 'a');
  assert.equal(uniqueSuffixPath(dir, 'Nome.mp4'), path.join(dir, 'Nome - 2.mp4'));
  fs.writeFileSync(path.join(dir, 'Nome - 2.mp4'), 'b');
  assert.equal(uniqueSuffixPath(dir, 'Nome.mp4'), path.join(dir, 'Nome - 3.mp4'));
  assert.equal(uniqueSuffixPath(dir, 'Nome.mp4', { avoid: [path.join(dir, 'Nome - 3.mp4')] }), path.join(dir, 'Nome - 4.mp4'));
});

/** Item "baixado": o programa deixou o arquivo final na subpasta temporária. */
function itemComArquivo(m, folder, url, nome, conteudo) {
  const item = m.add({ url, title: 'T' });
  const work = m._workDir(item);
  fs.mkdirSync(work, { recursive: true });
  const src = path.join(work, nome);
  fs.writeFileSync(src, conteudo);
  fs.writeFileSync(path.join(work, 'capa.webp'), 'lixo');
  item.outputPath = src;
  item.status = 'downloading';
  return item;
}

test('arquivo pré-existente com o mesmo nome NÃO é alterado: o novo vira "Nome - 2.mp4"; o seguinte, "Nome - 3.mp4"', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const original = path.join(folder, 'clip.mp4');
  fs.writeFileSync(original, 'ORIGINAL');
  const mtime = fs.statSync(original).mtimeMs;

  const a = itemComArquivo(m, folder, 'https://s.com/a/clip.mp4', 'clip.mp4', 'A');
  const b = itemComArquivo(m, folder, 'https://s.com/b/clip.mp4', 'clip.mp4', 'B');
  m._completeItem(a);
  m._completeItem(b);

  assert.equal(path.basename(a.outputPath), 'clip - 2.mp4');
  assert.equal(path.basename(b.outputPath), 'clip - 3.mp4');
  assert.equal(a.title, 'clip - 2');
  assert.equal(fs.readFileSync(original, 'utf8'), 'ORIGINAL');
  assert.equal(fs.statSync(original).mtimeMs, mtime);
  assert.equal(fs.readFileSync(a.outputPath, 'utf8'), 'A');
  assert.equal(fs.readFileSync(b.outputPath, 'utf8'), 'B');
  await sleep(50);
  assert.equal(fs.existsSync(m._workDir(a)), false, 'subpasta temporária some ao concluir');
  assert.equal(fs.existsSync(m._workDir(b)), false);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['clip - 2.mp4', 'clip - 3.mp4', 'clip.mp4']);
});

test('dois itens da mesma fila com o mesmo título: "clip.mp4" e "clip - 2.mp4" (MP3 também)', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const a = itemComArquivo(m, folder, 'https://s.com/a/clip.mp4', 'clip.mp4', 'A');
  const b = itemComArquivo(m, folder, 'https://s.com/b/clip.mp4', 'clip.mp4', 'B');
  m._completeItem(a);
  m._completeItem(b);
  assert.equal(path.basename(a.outputPath), 'clip.mp4');
  assert.equal(path.basename(b.outputPath), 'clip - 2.mp4');

  const x = m.add({ url: 'https://s.com/a/faixa', format: 'MP3', title: 'F' });
  const y = m.add({ url: 'https://s.com/b/faixa', format: 'MP3', title: 'F' });
  for (const [it, conteudo] of [[x, 'X'], [y, 'Y']]) {
    const work = m._workDir(it);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'Faixa.mp3'), conteudo);
    it.outputPath = path.join(work, 'Faixa.mp3');
    m._completeItem(it);
  }
  assert.equal(path.basename(x.outputPath), 'Faixa.mp3');
  assert.equal(path.basename(y.outputPath), 'Faixa - 2.mp3');
  await sleep(50);
});

test('nome reservado por outro item da fila também é evitado', () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const outro = m.add({ url: 'https://s.com/o', title: 'O' });
  outro.status = 'completed';
  outro.outputPath = path.join(folder, 'clip.mp4'); // registrado, ainda que o arquivo esteja momentaneamente ausente
  const a = itemComArquivo(m, folder, 'https://s.com/a/clip.mp4', 'clip.mp4', 'A');
  m._completeItem(a);
  assert.equal(path.basename(a.outputPath), 'clip - 2.mp4');
});

test('o comando baixa na subpasta temporária do item (nunca direto no destino)', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const original = ytDlpTool.resolve;
  ytDlpTool.resolve = () => 'yt-dlp';
  try {
    const item = m.add({ url: YT, title: 'T' });
    const { args } = await m.buildCommand(item, m.getSettings());
    const dir = args[args.indexOf('-P') + 1];
    assert.equal(path.dirname(dir), folder);
    assert.equal(path.basename(dir), `.bds-dl-${item.id}`);
    assert.ok(fs.existsSync(dir));
    assert.ok(args.includes('--embed-metadata'), 'metadados continuam embutidos (agora só no arquivo temporário)');
  } finally {
    ytDlpTool.resolve = original;
  }
});

test('ciclo completo (processo simulado): dois links diferentes com o mesmo título viram "clip.mp4" e "clip - 2.mp4"', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  m.getSettings = () => ({ mp3Folder: folder, mp4Folder: folder, downloadPauseEnabled: false });
  const origResolve = ytDlpTool.resolve;
  const origSpawn = processRunner.spawn;
  ytDlpTool.resolve = () => 'yt-dlp';
  let n = 0;
  processRunner.spawn = (exe, args) => {
    const dir = args[args.indexOf('-P') + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const file = path.join(dir, 'clip.mp4');
      fs.writeFileSync(file, `conteudo ${++n}`);
      fs.writeFileSync(`${file}.part`, 'sobra');
      child.stdout.emit('data', Buffer.from(`[download] Destination: ${file}\n[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05\n`));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const a = m.add({ url: 'https://s.com/a/clip.mp4' });
    const b = m.add({ url: 'https://s.com/b/clip.mp4' });
    const completos = [];
    m.on('downloads:completed', (i) => completos.push(i.outputPath));
    await m.start();
    for (let i = 0; i < 100 && completos.length < 2; i++) await sleep(50);
    assert.equal(completos.length, 2);
    assert.equal(path.basename(a.outputPath), 'clip.mp4');
    assert.equal(path.basename(b.outputPath), 'clip - 2.mp4');
    assert.equal(fs.readFileSync(a.outputPath, 'utf8'), 'conteudo 1', 'o primeiro NÃO foi apagado nem substituído');
    assert.equal(fs.readFileSync(b.outputPath, 'utf8'), 'conteudo 2');
    await sleep(100);
    assert.deepEqual(fs.readdirSync(folder).sort(), ['clip - 2.mp4', 'clip.mp4'], 'sem subpastas nem parciais sobrando');
  } finally {
    m.pause();
    ytDlpTool.resolve = origResolve;
    processRunner.spawn = origSpawn;
  }
});

// ---------------------------------------------------------------- cancelar/remover não deixam parciais

test('cancelar e remover apagam a subpasta temporária (parciais)', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const origCancel = processRunner.cancel;
  processRunner.cancel = async () => {};
  try {
    const a = itemComArquivo(m, folder, 'https://s.com/a', 'a.mp4.part', 'x');
    const b = itemComArquivo(m, folder, 'https://s.com/b', 'b.mp4.part', 'x');
    a.status = 'queued'; b.status = 'queued';
    assert.ok(fs.existsSync(m._workDir(a)));
    await m.cancel(a.id);
    assert.equal(fs.existsSync(m._workDir(a)), false);
    m.remove(b.id);
    for (let i = 0; i < 20 && fs.existsSync(m._workDir(b)); i++) await sleep(25);
    assert.equal(fs.existsSync(m._workDir(b)), false);
    assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    processRunner.cancel = origCancel;
  }
});

test('pausa/falha mantêm a subpasta (retomada do parcial); clearAll apaga tudo', async () => {
  const folder = tmpDir();
  const m = makeManager(folder);
  const a = itemComArquivo(m, folder, 'https://s.com/a', 'a.mp4.part', 'x');
  m._failItem(a, 'erro de rede');
  assert.ok(fs.existsSync(m._workDir(a)), 'falha mantém o parcial para o "tentar novamente"');
  m.clearAll();
  for (let i = 0; i < 20 && fs.existsSync(m._workDir(a)); i++) await sleep(25);
  assert.equal(fs.existsSync(m._workDir(a)), false);
});

// ---------------------------------------------------------------- fila de informações dos links

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('informações: UM link por vez (concorrência 1), em ordem de chegada, atualizando cada cartão', async () => {
  const m = makeManager(tmpDir());
  const pendentes = [];
  let emVoo = 0; let maxEmVoo = 0;
  const ordem = [];
  m.metadataProvider = (url) => {
    emVoo++; maxEmVoo = Math.max(maxEmVoo, emVoo); ordem.push(url);
    const d = deferred();
    pendentes.push(() => { emVoo--; d.resolve({ title: `Título de ${url.split('/').pop()}`, thumbnail: 't.jpg', channel: 'Canal', duration: 90 }); });
    return d.promise;
  };
  const atualizacoes = [];
  m.on('downloads:updated', (q) => atualizacoes.push(q.filter((i) => !i.infoLoading).length));
  const itens = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => m.add({ url: `https://s.com/v/${x}` }));
  assert.ok(itens.every((i) => i.infoLoading && i.title === 'Vídeo de s.com'), 'todos nascem com cartão e título neutro');
  await sleep(20);
  assert.equal(pendentes.length, 1, 'só o primeiro foi buscado');
  for (let i = 0; i < 6; i++) {
    while (pendentes.length === 0) await sleep(5);
    pendentes.shift()();
    await sleep(10);
    assert.equal(itens[i].infoLoading, false);
    assert.equal(itens[i].title, `Título de ${'abcdef'[i]}`);
    assert.equal(itens[i].thumbnail, 't.jpg');
    if (i < 5) assert.equal(itens[i + 1].infoLoading, true, 'o próximo ainda carrega');
  }
  assert.equal(maxEmVoo, 1, 'nunca mais de uma busca ao mesmo tempo');
  assert.deepEqual(ordem, ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `https://s.com/v/${x}`));
  assert.ok(atualizacoes.includes(3));
});

test('informações: falha ou demora NÃO vira "Falhou" — continua Aguardando com título neutro', async () => {
  const m = makeManager(tmpDir());
  m.metadataTimeoutMs = 40;
  m.metadataProvider = (url) => {
    if (url.endsWith('/erro')) return Promise.reject(new Error('Tempo limite excedido'));
    return new Promise(() => {}); // nunca responde
  };
  const a = m.add({ url: 'https://s.com/v/erro' });
  const b = m.add({ url: 'https://s.com/v/lento' });
  for (let i = 0; i < 40 && (a.infoLoading || b.infoLoading); i++) await sleep(20);
  for (const it of [a, b]) {
    assert.equal(it.status, 'queued');
    assert.equal(it.infoLoading, false);
    assert.equal(it.error, '');
    assert.doesNotMatch(it.title, /erro|falh/i);
  }
  assert.equal(a.title, 'Vídeo de s.com');
});

test('informações: item removido durante a análise é ignorado; baixando não é buscado', async () => {
  const m = makeManager(tmpDir());
  const chamadas = [];
  const gates = [];
  m.metadataProvider = (url) => { chamadas.push(url); const d = deferred(); gates.push(d); return d.promise; };
  const a = m.add({ url: 'https://s.com/v/a' });
  const b = m.add({ url: 'https://s.com/v/b' });
  const c = m.add({ url: 'https://s.com/v/c' });
  await sleep(15);
  assert.deepEqual(chamadas, ['https://s.com/v/a']);
  // remove o que está sendo analisado e marca o seguinte como "baixando": nenhum dos dois é aplicado/buscado
  m.remove(a.id);
  b.status = 'downloading';
  await sleep(30);
  assert.deepEqual(chamadas, ['https://s.com/v/a', 'https://s.com/v/c'], 'b (baixando) foi pulado; o fluxo andou sem esperar a');
  gates[0].resolve({ title: 'NÃO DEVE APARECER' });
  gates[1].resolve({ title: 'Título do c' });
  await sleep(30);
  assert.equal(b.infoLoading, false);
  assert.equal(c.title, 'Título do c');
  assert.ok(!m.queue.includes(a));
});

test('sem provedor de informações o cartão fica só com o site (sem "carregando" eterno)', () => {
  const m = makeManager(tmpDir());
  const item = m.add({ url: YT });
  assert.equal(item.infoLoading, false);
  assert.equal(item.title, 'Vídeo do YouTube');
});

test('os itens da fila continuam clonáveis (IPC) mesmo com a busca de informações em andamento', async () => {
  const m = makeManager(tmpDir());
  m.metadataProvider = () => new Promise(() => {});
  const item = m.add({ url: YT });
  await sleep(10);
  assert.doesNotThrow(() => structuredClone(item), 'item enviado pelo IPC sem funções dentro');
  assert.doesNotThrow(() => structuredClone(m.queue));
  m.remove(item.id);
});
