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

test('instalação nova (sem settings.json): módulos pesados desligados e assistente de IA ligado (padrão)', () => {
  const dirs = tmpDirs();
  try {
    const s = manager(dirs).load();
    assert.equal(s.modulesMigrated, true);
    assert.deepEqual(s.enabledModules, {});
    for (const isDev of [true, false]) {
      const e = reg.resolveEnabled(s, { isDev });
      assert.deepEqual(Object.entries(e).filter(([, v]) => v).map(([k]) => k), ['ai'], `só o assistente ligado (isDev=${isDev})`);
    }
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
    // 'ai' fica ausente de propósito: quem nunca escolheu recebe o padrão do módulo (ligado)
    assert.deepEqual(s.enabledModules, { transcription: true, metadata: true, silence: true, recovery: false, montage: false });
    const e = reg.resolveEnabled(s, { isDev: true });
    assert.deepEqual([e.transcription, e.metadata, e.silence, e.recovery, e.montage, e.ai], [true, true, true, false, false, true]);
    assert.equal(reg.resolveEnabled(s, { isDev: false }).ai, true, 'também no app empacotado');
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

test('assistente de IA: o que o usuário já escolheu (inclusive ai: false) nunca é alterado; só quem nunca escolheu recebe o padrão', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({
      modulesMigrated: true,
      enabledModules: { transcription: true, metadata: true, silence: false, recovery: false, montage: false, ai: false }
    }));
    const s = manager(dirs).load();
    assert.equal(s.enabledModules.ai, false, 'a escolha gravada tem prioridade');
    assert.equal(s.enabledModules.silence, false, 'as outras escolhas ficam');
    assert.equal(reg.isEnabled('ai', s, { isDev: false }), false);
    assert.equal('assistantDefaultMigrated' in readDisk(dirs), false, 'sem flag de migração do assistente');

    // quem nunca escolheu (chave ausente) recebe o padrão do módulo: ligado
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ modulesMigrated: true, enabledModules: { metadata: true } }));
    const novo = manager(dirs).load();
    assert.equal('ai' in novo.enabledModules, false);
    assert.equal(reg.isEnabled('ai', novo, { isDev: false }), true);

    // desligar de propósito é respeitado e não volta a ligar sozinho
    const m1 = manager(dirs);
    m1.load();
    m1.save({ enabledModules: { ...novo.enabledModules, ai: false } });
    const again = manager(dirs).load();
    assert.equal(again.enabledModules.ai, false);
    assert.equal(reg.isEnabled('ai', again, { isDev: false }), false);
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});

test('assistente de IA: quem já tinha escolhido ligar (ai: true) continua ligado; a escolha explícita de outros módulos não muda', () => {
  const dirs = tmpDirs();
  try {
    fs.mkdirSync(dirs.configDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.configDir, 'settings.json'), JSON.stringify({ modulesMigrated: true, enabledModules: { ai: true, metadata: true } }));
    const s = manager(dirs).load();
    assert.deepEqual(s.enabledModules, { ai: true, metadata: true });
  } finally { fs.rmSync(dirs.root, { recursive: true, force: true }); }
});
