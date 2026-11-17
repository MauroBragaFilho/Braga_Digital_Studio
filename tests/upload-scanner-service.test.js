'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const UploadScannerService = require('../src/core/uploads/UploadScannerService');

test('sem dataDir absoluto não cria a pasta Thumbnails no diretório atual', () => {
  const svc = new UploadScannerService({ paths: {}, ffprobePath: 'x', ffmpegPath: 'x' });
  assert.equal(svc.thumbnailsDir, null);
  const rel = new UploadScannerService({ paths: { dataDir: 'relativo' }, ffprobePath: 'x', ffmpegPath: 'x' });
  assert.equal(rel.thumbnailsDir, null);
});

test('varre a pasta numa passada só, sem seguir junções em laço', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-upscan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'b.mov'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'nota.txt'), 'x');
  try { fs.symlinkSync(root, path.join(root, 'sub', 'laco'), 'junction'); } catch (_) { /* sem permissão: ignora */ }

  const svc = new UploadScannerService({ paths: { dataDir: root }, ffprobePath: path.join(root, 'nao-existe.exe'), ffmpegPath: path.join(root, 'nao-existe2.exe') });
  const { tree, files } = await svc.scanDirectory(root);
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.mp4', 'b.mov']);
  assert.equal(tree.children.some((c) => c.name === 'sub'), true);
  assert.equal(files[0].durationSec, 0);
});
