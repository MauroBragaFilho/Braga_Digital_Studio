'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const SonyCameraProvider = require('../src/core/devices/providers/SonyCameraProvider');

function startCamera(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('baixa sem sobrescrever e sem deixar .part; recusa host que não é da câmera', async () => {
  const body = Buffer.alloc(5000, 7);
  const server = await startCamera((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-length': body.length }); res.end(body); }
    else { res.writeHead(404); res.end(); }
  });
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-sony-'));
  try {
    const provider = new SonyCameraProvider({ id: 'c', name: 'cam', endpointURL: `http://127.0.0.1:${port}/sony` });
    fs.writeFileSync(path.join(dir, 'DSC0001.JPG'), 'foto antiga do usuario');

    const files = await provider.import({ filename: 'DSC0001.JPG', url: `http://127.0.0.1:${port}/ok` }, dir);
    assert.equal(path.basename(files[0]), 'DSC0001 (2).JPG');
    assert.equal(fs.readFileSync(path.join(dir, 'DSC0001.JPG'), 'utf8'), 'foto antiga do usuario');
    assert.equal(fs.statSync(files[0]).size, 5000);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), []);

    // nome com travessia vira só o nome do arquivo
    const f2 = await provider.import({ filename: '..\\..\\evil.jpg', url: `http://127.0.0.1:${port}/ok` }, dir);
    assert.equal(path.dirname(f2[0]), dir);

    // host diferente do da câmera é recusado
    await assert.rejects(provider.import({ filename: 'x.jpg', url: 'http://10.9.9.9/x' }, dir), /não pertence à câmera/);

    // JPG baixa e RAW falha (404): o erro traz o que já foi baixado
    await assert.rejects(
      provider.import({ filename: 'IMG.JPG', url: `http://127.0.0.1:${port}/ok`, rawUrl: `http://127.0.0.1:${port}/nada` }, dir),
      (err) => Array.isArray(err.partial) && err.partial.length === 1 && /HTTP 404/.test(err.message),
    );
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), []);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
