'use strict';

// Detecção automática das pastas de gravação (OBS Studio por perfil e NVIDIA App/ShadowPlay) e o plano de
// sincronização das bibliotecas fixas a partir dela.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectObs, detectShadowPlay, parseIni, normalizeObsPath, obsConfigDirs, recordingPathFromProfile, decodeRegBinaryUtf16,
  RecordingFolderDetector
} = require('../src/core/library/RecordingFolderDetector');
const { planLibrarySync } = require('../src/bootstrap/libraries');

/** Último trecho de um caminho, com barra normal ou invertida (no Linux path.basename não separa '\'). */
const leaf = (p) => String(p).split(/[\\/]/).pop();

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bds-rec-')); }

/** Monta uma pasta de configuração do OBS com perfis. */
function obsConfig(root, { active, profiles, legacy = false }) {
  const cfg = path.join(root, 'obs-studio');
  fs.mkdirSync(path.join(cfg, 'basic', 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(cfg, legacy ? 'global.ini' : 'user.ini'), `[General]\nLanguage=pt-BR\n\n[Basic]\nProfile=${active}\nProfileDir=${active}\n`);
  for (const p of profiles) {
    const dir = path.join(cfg, 'basic', 'profiles', p.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'basic.ini'), p.ini);
  }
  return cfg;
}

// ---------------------------------------------------------------- INI e caminhos

test('parseIni: seções, chaves, comentários e valores com "="', () => {
  const ini = parseIni('; comentário\n[Output]\nMode=Advanced\n\n[AdvOut]\nRecFilePath=D:/REC/00 - OBS\nX=a=b\n#x\n');
  assert.equal(ini.Output.Mode, 'Advanced');
  assert.equal(ini.AdvOut.RecFilePath, 'D:/REC/00 - OBS');
  assert.equal(ini.AdvOut.X, 'a=b');
});

test('normalizeObsPath: desfaz "\\\\" do OBS, aceita barras normais e tira a barra final', () => {
  const p = normalizeObsPath('C:\\\\Users\\\\mauri\\\\Videos\\\\');
  assert.equal(leaf(p), 'Videos');
  assert.ok(!/[\\/]$/.test(p));
  assert.equal(normalizeObsPath(''), '');
});

test('recordingPathFromProfile: Simples usa FilePath; Avançado usa RecFilePath ou FFFilePath (FFmpeg)', () => {
  const simple = parseIni('[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=C:\\\\V\\\\S\n[AdvOut]\nRecFilePath=C:\\\\V\\\\A\n');
  assert.equal(leaf(recordingPathFromProfile(simple).path), 'S');
  const adv = parseIni('[Output]\nMode=Advanced\n[SimpleOutput]\nFilePath=C:\\\\V\\\\S\n[AdvOut]\nRecType=Standard\nRecFilePath=C:\\\\V\\\\A\nFFFilePath=C:\\\\V\\\\F\n');
  assert.equal(leaf(recordingPathFromProfile(adv).path), 'A');
  const ff = parseIni('[Output]\nMode=Advanced\n[AdvOut]\nRecType=FFmpeg\nRecFilePath=C:\\\\V\\\\A\nFFFilePath=C:\\\\V\\\\F\n');
  assert.equal(leaf(recordingPathFromProfile(ff).path), 'F');
  assert.equal(recordingPathFromProfile(parseIni('')).mode, 'Simple');
});

test('obsConfigDirs: Windows (APPDATA), macOS e Linux (XDG + Flatpak)', () => {
  assert.ok(obsConfigDirs('win32', { APPDATA: 'C:\\AD' }, 'C:\\U')[0].includes('obs-studio'));
  assert.ok(obsConfigDirs('darwin', {}, '/Users/x')[0].includes('Application Support'));
  const lin = obsConfigDirs('linux', {}, '/home/x');
  assert.equal(lin.length, 2);
  assert.ok(lin[1].includes('com.obsproject.Studio'));
});

// ---------------------------------------------------------------- OBS

test('detectObs: perfil ativo pelo user.ini, uma pasta por perfil, só pastas existentes, ativo primeiro', () => {
  const root = tmp();
  const recA = path.join(root, 'REC', '00 - OBS');
  const recB = path.join(root, 'Videos');
  fs.mkdirSync(recA, { recursive: true });
  fs.mkdirSync(recB, { recursive: true });
  const esc = (p) => p.replace(/\\/g, '\\\\');
  const cfg = obsConfig(root, {
    active: 'Gameplay',
    profiles: [
      { dir: 'Serie_e_Anime', ini: `[General]\nName=Serie e Anime\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${esc(recB)}\n` },
      { dir: 'Gameplay', ini: `[General]\nName=Gameplay\n[Output]\nMode=Advanced\n[AdvOut]\nRecType=Standard\nRecFilePath=${recA.replace(/\\/g, '/')}\n` },
      { dir: 'Sumiu', ini: `[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${esc(path.join(root, 'nao-existe'))}\n` },
      { dir: 'Duplicado', ini: `[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${esc(recB)}\n` }
    ]
  });
  const r = detectObs({ configDirs: [path.join(root, 'nada'), cfg] });
  assert.equal(r.configDir, cfg);
  assert.equal(r.activeProfile, 'Gameplay');
  assert.deepEqual(r.profiles.map((p) => [p.profile, p.active, p.mode]), [['Gameplay', true, 'Advanced'], ['Serie e Anime', false, 'Simple']]);
  assert.equal(path.normalize(r.profiles[0].path), path.normalize(recA));
  fs.rmSync(root, { recursive: true, force: true });
});

test('detectObs: global.ini antigo também serve; sem OBS devolve vazio sem erro', () => {
  const root = tmp();
  const rec = path.join(root, 'V');
  fs.mkdirSync(rec);
  const cfg = obsConfig(root, { legacy: true, active: 'Padrao', profiles: [{ dir: 'Padrao', ini: `[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${rec.replace(/\\/g, '\\\\')}\n` }] });
  const r = detectObs({ configDirs: [cfg] });
  assert.equal(r.activeProfile, 'Padrao');
  assert.equal(r.profiles.length, 1);
  assert.deepEqual(detectObs({ configDirs: [path.join(root, 'nada')] }), { configDir: null, activeProfile: null, profiles: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- NVIDIA App / ShadowPlay

test('decodeRegBinaryUtf16: saída do reg query vira o caminho', () => {
  const hex = Buffer.from('C:\\Users\\mauri\\Videos\\NVIDIA\0', 'utf16le').toString('hex').toUpperCase();
  const out = `\r\nHKEY_CURRENT_USER\\...\\NVSPCAPS\r\n    DefaultPathW    REG_BINARY    ${hex}\r\n\r\n`;
  assert.equal(decodeRegBinaryUtf16(out), 'C:\\Users\\mauri\\Videos\\NVIDIA');
  assert.equal(decodeRegBinaryUtf16('ERRO: chave não encontrada'), '');
});

test('detectShadowPlay: registro primeiro, GallerySettings.json como reserva, nada fora do Windows', async () => {
  const root = tmp();
  const rec = path.join(root, 'NVIDIA');
  fs.mkdirSync(rec);
  const hex = Buffer.from(rec + '\0', 'utf16le').toString('hex');
  const viaReg = await detectShadowPlay({ platform: 'win32', regQuery: async () => `DefaultPathW REG_BINARY ${hex}`, exists: fs.existsSync });
  assert.deepEqual(viaReg, { path: path.normalize(rec), source: 'registry' });

  const lad = path.join(root, 'Local');
  fs.mkdirSync(path.join(lad, 'NVIDIA Corporation', 'NVIDIA Overlay'), { recursive: true });
  fs.writeFileSync(path.join(lad, 'NVIDIA Corporation', 'NVIDIA Overlay', 'GallerySettings.json'), JSON.stringify({ currentDirectoryV2: rec + path.sep }));
  const viaGallery = await detectShadowPlay({ platform: 'win32', regQuery: async () => '', localAppData: lad, exists: fs.existsSync });
  assert.deepEqual(viaGallery, { path: path.normalize(rec), source: 'gallery' });

  assert.equal(await detectShadowPlay({ platform: 'win32', regQuery: async () => '', localAppData: path.join(root, 'x'), exists: fs.existsSync }), null);
  assert.equal(await detectShadowPlay({ platform: 'linux' }), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('RecordingFolderDetector.refresh guarda o último resultado e nunca lança', async () => {
  const d = new RecordingFolderDetector();
  const r = await d.refresh({ obs: { configDirs: ['/nao/existe'] }, shadowplay: { platform: 'linux' } });
  assert.deepEqual(r.obs, { configDir: null, activeProfile: null, profiles: [] });
  assert.equal(r.shadowplay, null);
  assert.equal(d.last, r);
});

// ---------------------------------------------------------------- plano de sincronização

test('plano: pasta manual vence a detecção e reaproveita a biblioteca do tipo', () => {
  const existing = [{ id: 1, name: 'OBS Studio', type: 'OBS', path: 'C:\\antiga' }];
  const plan = planLibrarySync(existing, { obsFolder: 'C:\\manual' }, { obs: { profiles: [{ profile: 'X', path: 'C:\\detectada' }] } });
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.update, [{ id: 1, path: 'C:\\manual' }]);
});

test('plano: sem pasta manual, uma biblioteca por perfil do OBS; um perfil só vira "OBS Studio"', () => {
  const detected = { obs: { profiles: [{ profile: 'Gameplay', path: 'D:\\REC' }, { profile: 'Serie', path: 'C:\\Videos' }] } };
  const plan = planLibrarySync([], {}, detected);
  assert.deepEqual(plan.add, [
    { name: 'OBS Studio (Gameplay)', type: 'OBS', path: 'D:\\REC' },
    { name: 'OBS Studio (Serie)', type: 'OBS', path: 'C:\\Videos' }
  ]);
  const one = planLibrarySync([], {}, { obs: { profiles: [{ profile: 'Gameplay', path: 'D:\\REC' }] } });
  assert.deepEqual(one.add, [{ name: 'OBS Studio', type: 'OBS', path: 'D:\\REC' }]);
});

test('plano: bibliotecas existentes casam pela pasta (renomeia), pasta que mudou reaproveita a sobra, nada é removido', () => {
  const existing = [
    { id: 1, name: 'OBS Studio', type: 'OBS', path: 'D:\\REC' },
    { id: 2, name: 'OBS Studio (Velho)', type: 'OBS', path: 'C:\\velha' },
    { id: 9, name: 'NVIDIA ShadowPlay', type: 'SHADOWPLAY', path: 'C:\\NV' }
  ];
  const detected = { obs: { profiles: [{ profile: 'Gameplay', path: 'D:\\REC' }, { profile: 'Serie', path: 'C:\\Videos' }] }, shadowplay: { path: 'C:\\NV' } };
  const plan = planLibrarySync(existing, {}, detected);
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.update, [
    { id: 1, name: 'OBS Studio (Gameplay)' },
    { id: 2, name: 'OBS Studio (Serie)', path: 'C:\\Videos' }
  ]);
});

test('plano: ShadowPlay detectado cria/atualiza a biblioteca; detecção desligada ou ausente não faz nada', () => {
  assert.deepEqual(planLibrarySync([], {}, { shadowplay: { path: 'C:\\NV' } }).add, [{ name: 'NVIDIA ShadowPlay', type: 'SHADOWPLAY', path: 'C:\\NV' }]);
  assert.deepEqual(planLibrarySync([], { shadowplayFolderAuto: false, obsFolderAuto: false }, { shadowplay: { path: 'C:\\NV' }, obs: { profiles: [{ profile: 'X', path: 'C:\\x' }] } }), { add: [], update: [] });
  assert.deepEqual(planLibrarySync([], {}, {}), { add: [], update: [] });
  assert.deepEqual(planLibrarySync([], { deviceFolder: 'C:\\BDSM' }, {}).add, [{ name: 'BDSM Devices', type: 'BDSM_DEVICE', path: 'C:\\BDSM' }]);
});
