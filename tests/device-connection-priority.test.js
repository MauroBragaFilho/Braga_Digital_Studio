'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const discovery = require('../src/core/devices/DeviceDiscoveryService');

const { pickPreferredConnection } = discovery;
const dev = (id, connection, physicalId, extra = {}) => ({ id, connection, physicalId, name: 'Celular', ...extra });

test('mesmo aparelho por USB e Wi-Fi: só a conexão USB é listada', () => {
  const out = pickPreferredConnection([
    dev('A_wifi', 'wifi', 'A', { ip: '192.168.0.9' }),
    dev('A_usb', 'usb', 'A', { ip: '127.0.0.1' })
  ]);
  assert.deepEqual(out.map((d) => d.id), ['A_usb']);
});

test('sem USB, a Wi-Fi continua listada (e a USB, se aparecer depois, assume)', () => {
  const wifiOnly = [dev('A_wifi', 'wifi', 'A')];
  assert.deepEqual(pickPreferredConnection(wifiOnly).map((d) => d.id), ['A_wifi']);
});

test('aparelhos diferentes não se escondem entre si e a ordem é preservada', () => {
  const out = pickPreferredConnection([
    dev('A_wifi', 'wifi', 'A'),
    dev('B_wifi', 'wifi', 'B'),
    dev('A_usb', 'usb', 'A'),
    dev('C_usb', 'usb', 'C')
  ]);
  assert.deepEqual(out.map((d) => d.id), ['B_wifi', 'A_usb', 'C_usb']);
});

test('sem identificador do aparelho, nada é escondido', () => {
  const out = pickPreferredConnection([dev('x_wifi', 'wifi', undefined), dev('y_usb', 'usb', undefined)]);
  assert.equal(out.length, 2);
});

test('getDevices usa a regra e a UI recebe o aparelho uma vez só', () => {
  discovery.devices.clear();
  discovery.registerDevice({ id: 'Z_wifi', physicalId: 'Z', connection: 'wifi', name: 'Cel', ip: '10.0.0.2', port: 8080, last_seen: Date.now() });
  discovery.registerDevice({ id: 'Z_usb', physicalId: 'Z', connection: 'usb', name: 'Cel', ip: '127.0.0.1', port: 8080, last_seen: Date.now() });
  assert.deepEqual(discovery.getDevices().map((d) => d.id), ['Z_usb']);
  discovery.devices.delete('Z_usb'); // cabo retirado: a Wi-Fi volta a aparecer
  assert.deepEqual(discovery.getDevices().map((d) => d.id), ['Z_wifi']);
  discovery.devices.clear();
});
