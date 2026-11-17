'use strict';
// P27/P28/P29: configurações (regravação que falha, tipos e URLs) e start() idempotente da câmera Sony.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SettingsManager = require('../src/core/settings/SettingsManager');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-cfg-')); }

test('P27: falha ao regravar não troca o arquivo bom por .corrupt nem volta ao padrão', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8');
    const sm = new SettingsManager(dir, dir);
    sm._writeAtomic = () => { throw new Error('disco cheio'); };
    const s = sm.load();
    assert.strictEqual(s.theme, 'light');
    assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P28: tipos das chaves conhecidas e URLs só https', () => {
  const dir = tmp();
  try {
    const sm = new SettingsManager(dir, dir);
    const out = sm._sanitize({
      theme: 42, notifyCopy: 'sim', deadlineNotifyLeadDays: '7', cacheMaxSizeMB: 'x', hiddenDevices: 'a',
      updateServerUrl: 'http://evil.example', errorReportingEndpoint: ' https://ok.example/r ', chaveNova: 1
    });
    assert.ok(!('theme' in out));
    assert.ok(!('notifyCopy' in out));
    assert.strictEqual(out.deadlineNotifyLeadDays, 7);
    assert.ok(!('cacheMaxSizeMB' in out));
    assert.ok(!('hiddenDevices' in out));
    assert.ok(!('updateServerUrl' in out));
    assert.strictEqual(out.errorReportingEndpoint, 'https://ok.example/r');
    assert.strictEqual(out.chaveNova, 1);
    assert.strictEqual(sm._sanitize({ updateServerUrl: '' }).updateServerUrl, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('P29: start() duas vezes não duplica ouvintes; stop() remove', () => {
  const svc = require('../src/core/devices/SonyCameraService');
  svc.discovery.start = () => {};
  svc.discovery.stop = () => {};
  svc.start();
  svc.start();
  assert.strictEqual(svc.discovery.listenerCount('camera_discovered'), 1);
  assert.strictEqual(svc.discovery.listenerCount('camera_lost'), 1);
  svc.stop();
  assert.strictEqual(svc.discovery.listenerCount('camera_discovered'), 0);
});
