'use strict';

// Regressões de verificação das telas Home/Biblioteca/Projetos/Workspace/Dispositivos/LUTs e do shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('bootstrap usa this.appPaths ao iniciar o notificador de prazos (sem identificador solto)', () => {
  // O startup saiu do bootstrap.js para src/bootstrap/startup.js (recebe o contexto em `ctx`).
  const src = read('src/bootstrap/startup.js');
  assert.match(src, /setStateFile\(path\.join\(ctx\.appPaths\.dataDir, 'deadline-reminders\.json'\)\)/);
  assert.doesNotMatch(src, /[^.\w]appPaths\.dataDir, 'deadline-reminders/);
});

test('seletor de status do workspace usa os mesmos valores do formulário de Projetos', () => {
  const ws = read('renderer/screens/project_workspace.html');
  const form = read('renderer/screens/projects.html');
  const values = (html, id) => {
    const block = html.match(new RegExp(`id="${id}"[\\s\\S]*?</select>`))[0];
    return [...block.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  };
  const projectValues = values(form, 'projFormStatus');
  const wsValues = values(ws, 'wsProjectStatus');
  for (const v of projectValues) assert.ok(wsValues.includes(v), `workspace sem o status "${v}"`);
});

test('confiança da sincronização por áudio nunca passa de 100%', () => {
  const src = read('src/core/projects/AudioSyncService.js');
  assert.doesNotMatch(src, /parseFloat\(Math\.max\(0, bestScore\)\.toFixed\(4\)\)/);
  assert.match(src, /Math\.min\(1, Math\.max\(0, bestScore\)\)/);
});

test('painéis de informação do preview entendem o JSON do ffprobe ({ streams, format })', () => {
  for (const f of ['VideoPreview.js', 'AudioPreview.js']) {
    const src = read(`renderer/components/preview/${f}`);
    assert.match(src, /raw\.streams/, `${f} deve ler streams do ffprobe`);
    assert.match(src, /fmt\.duration/, `${f} deve ler a duração de format`);
  }
});

test('Home: ícone de pasta tem ação e não há botão "Mais opções" sem função', () => {
  const src = read('renderer/screens/home.js');
  assert.match(src, /job-open-folder/);
  assert.doesNotMatch(src, /more_vert/);
});
