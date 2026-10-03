'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FailureCooldown = require('../src/core/FailureCooldown');
const hwSingleton = require('../src/core/HardwareDetectionService');
const HardwareDetectionService = hwSingleton.constructor;

test('FailureCooldown: silencia após falha e expira', () => {
  const c = new FailureCooldown(1000);
  assert.equal(c.shouldSkip(0), false);
  c.markFailure(100);
  assert.equal(c.shouldSkip(500), true);
  assert.equal(c.shouldSkip(1100), false);
  c.markFailure(2000);
  c.reset();
  assert.equal(c.shouldSkip(2001), false);
});

test('WMI com falha não é repetido (cache negativo) e sobrevive a invalidateCache', { skip: process.platform !== 'win32' }, async () => {
  const hw = new HardwareDetectionService();
  let psCalls = 0;
  hw._runPowerShell = async () => { psCalls++; throw new Error('PowerShell timeout'); };
  hw._gpuFromNvidiaSmi = async () => [];
  hw._gpusFromRegistry = async () => []; // sem fontes rápidas: cai no WMI (último recurso)

  await hw.getGraphicsInfo({ force: true });
  await hw.getGraphicsInfo({ force: true });
  hw.invalidateCache();
  await hw.getGraphicsInfo({ force: true });
  assert.equal(psCalls, 1, 'a consulta que falhou não deve ser repetida durante o cooldown');
});

test('WMI como último recurso (sem nvidia-smi nem registro) mantém o resultado', { skip: process.platform !== 'win32' }, async () => {
  const hw = new HardwareDetectionService();
  hw._runPowerShell = async () => JSON.stringify({
    Name: 'NVIDIA GeForce GTX 1650', DriverVersion: '1.2', AdapterRAM: 4294967296,
    VideoModeDescription: '1920 x 1080', PNPDeviceID: 'PCI\\VEN_10DE&DEV_1'
  });
  hw._gpuFromNvidiaSmi = async () => [];
  hw._gpusFromRegistry = async () => [];
  const gpus = await hw.getGraphicsInfo({ force: true });
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].source, 'wmi');
  assert.equal(gpus[0].model, 'GeForce GTX 1650');
});

test('resultado do mini-encode é persistido em disco por versão do ffmpeg', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-hw-'));
  try {
    const fakeFfmpeg = process.execPath; // qualquer arquivo existente serve como "ffmpeg"
    const make = () => {
      const hw = new HardwareDetectionService();
      hw.setCacheDir(dir);
      hw.listEncoders = async () => new Set(['h264_nvenc']);
      hw.runs = 0;
      hw._runEncoderTest = async () => { hw.runs++; return true; };
      return hw;
    };

    const a = make();
    assert.equal(await a.testEncoder(fakeFfmpeg, 'h264_nvenc'), true);
    assert.equal(await a.testEncoder(fakeFfmpeg, 'h264_nvenc'), true);
    assert.equal(a.runs, 1, 'segunda chamada vem do cache em memória');

    // Mesmo invalidando o cache de "melhor encoder", o teste não é refeito
    a.invalidateCache();
    assert.equal(await a.testEncoder(fakeFfmpeg, 'h264_nvenc'), true);
    assert.equal(a.runs, 1);

    // Espera a gravação assíncrona e simula novo processo
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'hw-encoder-tests.json')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const b = make();
    assert.equal(await b.testEncoder(fakeFfmpeg, 'h264_nvenc'), true);
    assert.equal(b.runs, 0, 'novo processo reaproveita o resultado do disco');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
