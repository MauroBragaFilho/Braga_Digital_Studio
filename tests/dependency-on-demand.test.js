'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DependencyManager } = require('../src/infrastructure/external-tools/DependencyManager');
const { toolUpdater } = require('../src/infrastructure/external-tools/ToolUpdater');

// RK-070: untrunc, Deno e spotDL são sob demanda — ausentes, não contam como atualização
// e não entram em "Atualizar tudo"; instalados, continuam sendo atualizados.
function setup(installed) {
  const checked = [];
  const original = toolUpdater.check;
  toolUpdater.check = async (tool) => {
    checked.push(tool);
    const isInstalled = installed.has(tool) || ['ffmpeg', 'ffprobe', 'ytdlp'].includes(tool);
    return { installed: isInstalled ? '1.0' : null, latest: '1.0', needsUpdate: false, hasBackup: false };
  };
  const dm = new DependencyManager();
  dm.isAvailable = (tool) => installed.has(tool) || ['ffmpeg', 'ffprobe', 'ytdlp'].includes(tool);
  return { dm, checked, restore: () => { toolUpdater.check = original; } };
}

test('sem untrunc/deno/spotdl instalados: não consulta nem conta atualização', async () => {
  const { dm, checked, restore } = setup(new Set());
  try {
    const r = await dm.checkSystemUpdates();
    assert.equal(r.hasUpdates, false);
    assert.equal(r.totalNeedingUpdate, 0);
    for (const t of ['untrunc', 'deno', 'spotdl']) assert.ok(!checked.includes(t), `${t} não deveria ser consultado`);
    const rec = r.components.find((c) => c.canonicalTool === 'untrunc');
    assert.equal(rec.onDemand, true);
    assert.equal(rec.isInstalled, false);
  } finally { restore(); }
});

test('componente sob demanda instalado continua sendo verificado', async () => {
  const { dm, checked, restore } = setup(new Set(['untrunc']));
  try {
    await dm.checkSystemUpdates();
    assert.ok(checked.includes('untrunc'));
    assert.ok(!checked.includes('deno'));
  } finally { restore(); }
});
