'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getDeviceImportLibrary, DEVICE_IMPORT_TYPE } = require('../src/ipc/deviceImportLibrary');
const { parseDriveList } = require('../src/ipc/localDrives');

// Banco falso mínimo: só as duas consultas usadas pelo helper.
function fakeDb(rows) {
  return {
    prepare(sql) {
      return {
        get: (type) => (/WHERE type = \?/.test(sql) ? rows.filter((r) => r.type === type)[0] : undefined),
        run: (name, type, p) => { const id = rows.length + 1; rows.push({ id, name, type, path: p }); return { lastInsertRowid: id }; }
      };
    }
  };
}

test('P12: cria a biblioteca própria de importação uma vez e a reaproveita', () => {
  const rows = [{ id: 1, name: 'OBS Studio', type: 'OBS', path: 'C:\\obs' }];
  const db = fakeDb(rows);
  const a = getDeviceImportLibrary(db);
  const b = getDeviceImportLibrary(db);
  assert.strictEqual(a.type, DEVICE_IMPORT_TYPE);
  assert.strictEqual(a.path, null);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(a.id, 1);
});

test('P13: lê as letras dos discos fixos', () => {
  assert.deepStrictEqual(parseDriveList('C:\r\nD:\r\n\r\ne:\nlixo\nC:\n'), ['C:\\', 'D:\\', 'E:\\']);
  assert.deepStrictEqual(parseDriveList(''), []);
});
