'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { budget } = require('./helpers/timing');
const hwSingleton = require('../src/core/HardwareDetectionService');
const HardwareDetectionService = hwSingleton.constructor;

// ---- Detecção da placa sem WMI (nvidia-smi + registro do Windows) ----
const CLASS = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';

const REG_INTEL = [
  '',
  `${CLASS}\\0001`,
  '    DriverDesc    REG_SZ    Intel(R) Iris(R) Xe Graphics',
  '    ProviderName    REG_SZ    Intel Corporation',
  '    DriverVersion    REG_SZ    32.0.101.7092',
  '    MatchingDeviceId    REG_SZ    PCI\\VEN_8086&DEV_9A49',
  '    HardwareInformation.MemorySize    REG_BINARY    00F0FF7F'
].join('\r\n');

const REG_NVIDIA = [
  `${CLASS}\\0002`,
  '    DriverDesc    REG_SZ    NVIDIA GeForce GTX 1650',
  '    DriverVersion    REG_SZ    32.0.15.6094',
  '    MatchingDeviceId    REG_SZ    PCI\\VEN_10DE&DEV_1F99',
  '    HardwareInformation.qwMemorySize    REG_QWORD    0x100000000'
].join('\r\n');

const REG_VIRTUAL = [
  `${CLASS}\\0003`,
  '    DriverDesc    REG_SZ    spacedesk Graphics Adapter',
  '    MatchingDeviceId    REG_SZ    root\\spacedeskdisplay'
].join('\r\n');

test('registro: lê nome, driver, fabricante e memória de um adaptador', () => {
  const hw = new HardwareDetectionService();
  const intel = hw._parseRegistryAdapter(REG_INTEL);
  assert.equal(intel.name, 'Intel(R) Iris(R) Xe Graphics');
  assert.equal(intel.vendor, 'intel');
  assert.equal(intel.driverVersion, '32.0.101.7092');
  assert.equal(intel.vramMB, 2048); // 0x7FFFF000 bytes (binário little-endian)
  assert.equal(intel.source, 'registry');

  const nvidia = hw._parseRegistryAdapter(REG_NVIDIA);
  assert.equal(nvidia.vendor, 'nvidia');
  assert.equal(nvidia.vramMB, 4096); // QWORD 0x100000000
});

test('registro: ignora adaptadores virtuais (sem ID PCI) e saída vazia', () => {
  const hw = new HardwareDetectionService();
  assert.equal(hw._parseRegistryAdapter(REG_VIRTUAL), null); // ex.: spacedesk
  assert.equal(hw._parseRegistryAdapter(''), null);
  assert.equal(hw._parseRegistryAdapter(null), null);
});

test('junção: nvidia-smi vem primeiro e o registro só completa com as outras marcas', () => {
  const hw = new HardwareDetectionService();
  const smi = [{ name: 'NVIDIA GeForce GTX 1650', vendor: 'nvidia', source: 'nvidia-smi' }];
  const reg = [
    { name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', source: 'registry' },
    { name: 'NVIDIA GeForce GTX 1650', vendor: 'nvidia', source: 'registry' }
  ];
  const gpus = hw._mergeGpuSources(smi, reg);
  assert.deepEqual(gpus.map((g) => g.vendor), ['nvidia', 'intel']);
  assert.equal(gpus[0].source, 'nvidia-smi');
  // sem nvidia-smi, a NVIDIA vem do registro
  assert.deepEqual(hw._mergeGpuSources([], reg).map((g) => g.vendor), ['intel', 'nvidia']);
});

test('com fontes rápidas o WMI nem é consultado (não espera o driver travado)', { skip: process.platform !== 'win32' }, async () => {
  const hw = new HardwareDetectionService();
  let psCalls = 0;
  hw._runPowerShell = async () => { psCalls++; throw new Error('PowerShell timeout'); };
  hw._gpuFromNvidiaSmi = async () => [{ name: 'NVIDIA GeForce GTX 1650', vendor: 'nvidia', source: 'nvidia-smi' }];
  hw._gpusFromRegistry = async () => [{ name: 'Intel(R) Iris(R) Xe Graphics', vendor: 'intel', source: 'registry' }];
  const gpus = await hw.getGraphicsInfo({ force: true });
  assert.equal(gpus.length, 2);
  assert.equal(psCalls, 0);
});

test('máquina real (Windows): o registro lista as placas rapidamente, sem WMI', { skip: process.platform !== 'win32' }, async () => {
  const hw = new HardwareDetectionService();
  const t0 = Date.now();
  const gpus = await hw._gpusFromRegistry();
  assert.ok(Date.now() - t0 < budget(15000), 'a leitura do registro não deve depender do WMI (que leva vários segundos)');
  for (const g of gpus) {
    assert.ok(g.name && ['nvidia', 'amd', 'intel', 'other'].includes(g.vendor));
    assert.equal(g.source, 'registry');
  }
});
