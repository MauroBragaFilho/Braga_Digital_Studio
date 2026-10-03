'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KeyedThrottle = require('../src/infrastructure/desktop/KeyedThrottle');
const { mapLimit, classifyRows } = require('../src/core/library/reconcile');
const { ToolResolver } = require('../src/infrastructure/external-tools/ToolResolver');
const { getExecutableName } = require('../src/infrastructure/external-tools/ToolManifest');

test('KeyedThrottle: 1ª entrega imediata, último valor vence, flush e cancel', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let clock = 0;
    const t = new KeyedThrottle(250, () => clock);
    const got = [];
    const sink = (v) => got.push(v);

    t.push('a', 1, sink);            // imediato
    clock = 10; t.push('a', 2, sink);
    clock = 20; t.push('a', 3, sink); // 2 é descartado
    assert.deepEqual(got, [1]);

    clock = 250; mock.timers.tick(250);
    assert.deepEqual(got, [1, 3]);

    // flush entrega o pendente sem esperar
    clock = 260; t.push('a', 4, sink);
    t.flush('a');
    assert.deepEqual(got, [1, 3, 4]);

    // cancel descarta
    clock = 270; t.push('a', 5, sink);
    t.cancel('a');
    clock = 1000; mock.timers.tick(1000);
    assert.deepEqual(got, [1, 3, 4]);

    // canais independentes
    t.push('b', 'x', sink);
    assert.deepEqual(got, [1, 3, 4, 'x']);
  } finally {
    mock.timers.reset();
  }
});

test('mapLimit respeita o limite de concorrência e a ordem', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  }, 2);
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `pico ${peak}`);
});

test('classifyRows: marca ausentes, restaura presentes e confirma com access', async () => {
  const files = new Set(['/m/a.mp4', '/m/b.mp4', '/n/c.mp4']);
  const accessed = [];
  const io = {
    readdir: async (dir) => {
      if (dir === '/gone') throw new Error('ENOENT');
      return [...files].filter((f) => path.posix.dirname(f) === dir).map((f) => path.posix.basename(f));
    },
    access: async (f) => { accessed.push(f); if (!files.has(f)) throw new Error('ENOENT'); }
  };
  const rows = [
    { id: 1, filepath: '/m/a.mp4', missing: 0 },   // presente e ok
    { id: 2, filepath: '/m/x.mp4', missing: 0 },   // ausente -> marcar
    { id: 3, filepath: '/m/b.mp4', missing: 1 },   // presente -> restaurar
    { id: 4, filepath: '/m/y.mp4', missing: 1 },   // continua ausente: nada
    { id: 5, filepath: '/gone/z.mp4', missing: 0 }, // pasta ilegível -> access confirma ausência
    { id: 6, filepath: '/n/c.mp4', missing: 0 }
  ];
  const { toMark, toRestore } = await classifyRows(
    rows.map((r) => ({ ...r })),
    io,
    { caseInsensitive: false }
  );
  assert.deepEqual(toMark.sort(), [2, 5]);
  assert.deepEqual(toRestore, [3]);
  // arquivos encontrados na listagem não precisam de access
  assert.ok(!accessed.includes('/m/a.mp4'));
});

test('ToolResolver: cache da busca no PATH e invalidate()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-tool-'));
  const emptyTools = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-tools-'));
  const oldPath = process.env.PATH;
  const oldPathWin = process.env.Path;
  try {
    const exe = getExecutableName('ffmpeg');
    fs.writeFileSync(path.join(dir, exe), '');
    process.env.PATH = dir;
    if (process.platform === 'win32') process.env.Path = dir;

    const r = new ToolResolver();
    assert.equal(r.resolve('ffmpeg', emptyTools), path.join(dir, exe));

    fs.rmSync(path.join(dir, exe));
    // Ainda em cache
    assert.equal(r.resolve('ffmpeg', emptyTools), path.join(dir, exe));
    // Após invalidar, enxerga o estado novo
    r.invalidate();
    assert.throws(() => r.resolve('ffmpeg', emptyTools));
    assert.equal(r.exists('ffmpeg', emptyTools), false);
  } finally {
    process.env.PATH = oldPath;
    if (process.platform === 'win32') process.env.Path = oldPathWin;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(emptyTools, { recursive: true, force: true });
  }
});
