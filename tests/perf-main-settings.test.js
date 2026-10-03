'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  libraryFoldersChanged, hardwareSettingsChanged, notificationSettingsChanged, updateServerChanged
} = require('../src/core/settings/settingsChanges');
const SettingsManager = require('../src/core/settings/SettingsManager');

const base = {
  obsFolder: 'D:/obs', shadowplayFolder: '', deviceFolder: 'D:/dev',
  useHardwareAcceleration: true, preferredGpuVendor: 'auto',
  sidebarCollapsed: false, sidebarOrder: ['a'], windowBounds: null, theme: 'dark',
  notifyDownloads: true, updateServerUrl: ''
};

test('chaves de interface não disparam efeitos colaterais', () => {
  const next = { ...base, sidebarCollapsed: true, sidebarOrder: ['b', 'a'], theme: 'light', windowBounds: { x: 1 } };
  assert.equal(libraryFoldersChanged(base, next), false);
  assert.equal(hardwareSettingsChanged(base, next), false);
  assert.equal(notificationSettingsChanged(base, next), false);
  assert.equal(updateServerChanged(base, next), false);
});

test('pasta de biblioteca alterada é detectada', () => {
  assert.equal(libraryFoldersChanged(base, { ...base, obsFolder: 'E:/obs' }), true);
  assert.equal(libraryFoldersChanged(base, { ...base, shadowplayFolder: 'E:/sp' }), true);
  assert.equal(libraryFoldersChanged(base, { ...base, deviceFolder: '' }), true);
});

test('hardware e notificações: só as chaves relacionadas', () => {
  assert.equal(hardwareSettingsChanged(base, { ...base, preferredGpuVendor: 'nvidia' }), true);
  assert.equal(hardwareSettingsChanged(base, { ...base, useHardwareAcceleration: false }), true);
  assert.equal(notificationSettingsChanged(base, { ...base, notifyDownloads: false }), true);
  assert.equal(updateServerChanged(base, { ...base, updateServerUrl: 'https://x' }), true);
  assert.equal(libraryFoldersChanged(null, null), false);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-settings-'));
}

test('SettingsManager: cache sem TTL e gravação atômica', () => {
  const dir = tmpDir();
  try {
    const sm = new SettingsManager(dir, dir);
    const first = sm.load();
    // Alteração externa no disco NÃO é relida (o app é o único escritor)
    fs.writeFileSync(sm.settingsPath, JSON.stringify({ theme: 'externo' }), 'utf8');
    assert.equal(sm.load().theme, first.theme);

    const saved = sm.save({ theme: 'light', sidebarCollapsed: true });
    assert.equal(saved.theme, 'light');
    assert.equal(sm.load().sidebarCollapsed, true);
    assert.equal(JSON.parse(fs.readFileSync(sm.settingsPath, 'utf8')).theme, 'light');
    // Nenhum temporário sobrando
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SettingsManager: save({defer}) só grava no flush()', () => {
  const dir = tmpDir();
  try {
    const sm = new SettingsManager(dir, dir);
    sm.load();
    sm.save({ theme: 'light' });
    sm.save({ sidebarCollapsed: true }, { defer: true });
    // Cache já reflete, disco ainda não
    assert.equal(sm.load().sidebarCollapsed, true);
    assert.equal(JSON.parse(fs.readFileSync(sm.settingsPath, 'utf8')).sidebarCollapsed, false);
    sm.flush();
    assert.equal(JSON.parse(fs.readFileSync(sm.settingsPath, 'utf8')).sidebarCollapsed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
