'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SettingsManager = require('../src/core/settings/SettingsManager');
const reg = require('../src/core/modules/ModuleRegistry');

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-mig-'));
  return { root, configDir: path.join(root, 'config'), dataDir: path.join(root, 'data') };
}

function manager(dirs) {
  fs.mkdirSync(dirs.configDir, { recursive: true });
  fs.mkdirSync(dirs.dataDir, { recursive: true });
  const m = new SettingsManager(dirs.configDir, dirs.dataDir);
  m.safeStorage = null;
  return m;
}

const readDisk = (dirs) => JSON.parse(fs.readFileSync(path.join(dirs.configDir, 'settings.json'), 'utf8'));

test('instalação nova (sem settings.json): todos os módulos desligados', () => {
  const dirs = tmpDirs();
  try {
    const s = manager(dirs).load();
    assert.equal(s.modulesMigrated, true);
    assert.deepEqual(s.enabledModules, {});
    const e = reg.resolveEnabled(s, { isDev: true });
    assert.ok(Object.values(e).every((v) => v === false));
    assert.equal(readDisk(dirs).modulesMigrated, true);
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});

test('instalação existente sem enabledModules: migra transcription, metadata e silence ligados', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ theme: 'light', accentColor: '#112233' }));
    const s = manager(dirs).load();
    assert.equal(s.theme, 'light');
    assert.equal(s.modulesMigrated, true);
    assert.deepEqual(s.enabledModules, { transcription: true, metadata: true, silence: true, recovery: false, montage: false, ai: false });
    const e = reg.resolveEnabled(s, { isDev: true });
    assert.deepEqual([e.transcription, e.metadata, e.silence, e.recovery, e.montage, e.ai], [true, true, true, false, false, false]);
    const disk = readDisk(dirs);
    assert.equal(disk.modulesMigrated, true);
    assert.equal(disk.enabledModules.silence, true);
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});

test('rodar duas vezes não sobrescreve a escolha do usuário', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const first = manager(dirs);
    first.load();
    first.save({ enabledModules: { transcription: false, metadata: true, silence: false } });

    // novo gerenciador = novo início do app, lendo o arquivo gravado
    const second = manager(dirs).load();
    assert.deepEqual(second.enabledModules, { transcription: false, metadata: true, silence: false });
    assert.equal(second.modulesMigrated, true);
    const third = manager(dirs).load();
    assert.deepEqual(third.enabledModules, { transcription: false, metadata: true, silence: false });
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});

test('enabledModules já existente sem a flag: preserva e só marca como migrado', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ enabledModules: { silence: false } }));
    const s = manager(dirs).load();
    assert.deepEqual(s.enabledModules, { silence: false });
    assert.equal(s.modulesMigrated, true);
    assert.equal(readDisk(dirs).modulesMigrated, true);
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});

test('settings.json ilegível é tratado como instalação existente (recursos preservados)', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), '{ quebrado');
    const s = manager(dirs).load();
    assert.equal(s.enabledModules.transcription, true);
    assert.equal(s.modulesMigrated, true);
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});
