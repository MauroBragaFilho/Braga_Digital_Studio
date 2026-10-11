'use strict';

// Módulos sob demanda no processo principal: serviços criados no primeiro uso e tarefas de fundo que só
// existem com o módulo ligado (e começam/param ao ligar/desligar).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { lazyService, isCreated, liveService, onceCreated } = require('../src/core/modules/lazyService');
const { ModuleRuntime } = require('../src/bootstrap/moduleRuntime');
const { buildBackgroundSteps } = require('../src/bootstrap/startup');

test('lazyService: só constrói no primeiro uso; then/símbolos/JSON não acordam o serviço', async () => {
  let built = 0;
  const svc = lazyService(() => { built++; return Object.assign(new EventEmitter(), { value: 7, double() { return this.value * 2; } }); });
  assert.equal(isCreated(svc), false);
  await Promise.resolve(svc); // await lê .then: não pode construir
  JSON.stringify({ svc });
  assert.equal(built, 0);
  assert.equal(liveService(svc), null);
  assert.equal(svc.double(), 14, 'método ligado à instância real');
  assert.equal(built, 1);
  svc.value = 10;
  assert.equal(svc.double(), 20);
  assert.equal(liveService(svc), svc);
  assert.equal(built, 1, 'construído uma única vez');
});

test('onceCreated: roda quando o serviço passa a existir; com objeto comum roda na hora', () => {
  const calls = [];
  const svc = lazyService(() => new EventEmitter());
  onceCreated(svc, (real) => { calls.push('ligado'); assert.ok(real instanceof EventEmitter); });
  assert.deepEqual(calls, []);
  svc.emit('x'); // primeiro uso
  assert.deepEqual(calls, ['ligado']);
  onceCreated({ plain: true }, () => calls.push('comum'));
  assert.deepEqual(calls, ['ligado', 'comum']);
});

function runtimeWith(enabled, started = [], stopped = []) {
  const rt = new ModuleRuntime();
  rt.setContext({ settingsManager: { load: () => ({ enabledModules: enabled }) }, services: {} });
  const hooks = rt.hooks();
  // troca as ações reais por espiãs (sem tocar em disco, rede ou dispositivos)
  for (const id of ['library', 'devices', 'projects', 'luts', 'download']) {
    hooks[id] = { ...hooks[id], start: () => started.push(id), stop: () => { stopped.push(id); } };
  }
  return rt;
}

test('moduleRuntime: start/stop são idempotentes e toggle liga/desliga o módulo', async () => {
  const started = []; const stopped = [];
  const rt = runtimeWith({}, started, stopped);
  await rt.toggle('library', true);
  await rt.toggle('library', true);
  assert.deepEqual(started, ['library']);
  await rt.toggle('library', false);
  await rt.toggle('library', false);
  assert.deepEqual(stopped, ['library']);
  await rt.toggle('library', true);
  assert.deepEqual(started, ['library', 'library'], 'pode religar');
  await rt.toggle('inexistente', true); // id desconhecido é ignorado
  await rt.stopAll();
  assert.deepEqual(stopped, ['library', 'library']);
});

test('moduleRuntime: whenOn adia a ação até o módulo ligar pela primeira vez', async () => {
  const rt = runtimeWith({});
  const calls = [];
  rt.whenOn('devices', () => calls.push('a'));
  assert.deepEqual(calls, []);
  rt.start('devices');
  assert.deepEqual(calls, ['a']);
  rt.whenOn('devices', () => calls.push('b'));
  assert.deepEqual(calls, ['a', 'b'], 'já ligado: roda na hora');
});

test('etapas de segundo plano: com os módulos desligados nada é iniciado (e o diagnóstico é concluído)', () => {
  const { moduleRuntime } = require('../src/bootstrap/moduleRuntime');
  const startedIds = [];
  const orig = moduleRuntime.start.bind(moduleRuntime);
  moduleRuntime.start = (id) => { startedIds.push(id); return false; };
  try {
    const ctx = { services: {}, paths: {}, appPaths: {}, settingsManager: { load: () => ({ enabledModules: {} }) }, getMainWindow: () => null };
    moduleRuntime.setContext(ctx);
    for (const [name, fn] of buildBackgroundSteps(ctx)) if (name !== 'cache-maintenance') fn();
    assert.deepEqual(startedIds, [], 'Biblioteca, Dispositivos e Projetos desligados: nada inicia');

    const on = { ...ctx, settingsManager: { load: () => ({ enabledModules: { library: true, devices: true, projects: true } }) } };
    moduleRuntime.setContext(on);
    for (const [name, fn] of buildBackgroundSteps(on)) if (name === 'watchers' || name === 'discovery' || name === 'deadlines') fn();
    assert.deepEqual(startedIds, ['library', 'devices', 'projects']);
  } finally { moduleRuntime.start = orig; moduleRuntime.setContext({ settingsManager: null }); }
});
