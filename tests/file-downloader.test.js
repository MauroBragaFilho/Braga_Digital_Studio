'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { downloadFile, fetchJson, sha256File } = require('../src/core/modules/FileDownloader');

const payload = Buffer.from('conteudo-de-teste-'.repeat(1000));
const payloadSha = createHash('sha256').update(payload).digest('hex');
let server;
let base;
let tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-dl-'));
  server = http.createServer((req, res) => {
    if (req.url === '/file') { res.writeHead(200, { 'Content-Length': payload.length }); return res.end(payload); }
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/redir') { res.writeHead(302, { Location: '/json' }); return res.end(); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('baixa arquivo e confere SHA-256', async () => {
  const dest = path.join(tmp, 'ok', 'f.bin');
  const res = await downloadFile({ url: `${base}/file`, dest, expectedSha256: payloadSha });
  assert.strictEqual(res.sha256, payloadSha);
  assert.ok(fs.readFileSync(dest).equals(payload));
  assert.strictEqual(await sha256File(dest), payloadSha);
});

test('SHA-256 divergente falha com CHECKSUM', async () => {
  const dest = path.join(tmp, 'bad.bin');
  await assert.rejects(
    downloadFile({ url: `${base}/file`, dest, expectedSha256: 'a'.repeat(64), attempts: 1 }),
    (e) => e.code === 'CHECKSUM'
  );
  assert.ok(!fs.existsSync(dest));
});

test('HTTP 404 falha sem retentativas longas', async () => {
  await assert.rejects(downloadFile({ url: `${base}/nada`, dest: path.join(tmp, 'x.bin'), attempts: 1, backoffMs: 1 }));
});

test('fetchJson lê JSON e segue redirecionamento', async () => {
  assert.deepStrictEqual(await fetchJson(`${base}/json`), { ok: true });
  assert.deepStrictEqual(await fetchJson(`${base}/redir`), { ok: true });
});
