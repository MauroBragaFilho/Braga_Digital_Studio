'use strict';

// Biblioteca própria das importações de dispositivos (câmera Sony, Organizador). Antes os arquivos iam
// para a primeira biblioteca de dispositivo ou, sem ela, para qualquer uma (P12). É interna, sem pasta
// (não tem watcher) e não aparece nas fontes personalizadas. Dados já importados não são mexidos.
const DEVICE_IMPORT_TYPE = 'DEVICE_IMPORT';
const DEVICE_IMPORT_NAME = 'Importações de dispositivos';

/** Devolve a biblioteca de importação de dispositivos, criando-a na primeira vez. */
function getDeviceImportLibrary(db) {
  let lib = db.prepare('SELECT * FROM libraries WHERE type = ? ORDER BY id LIMIT 1').get(DEVICE_IMPORT_TYPE);
  if (!lib) {
    const info = db.prepare('INSERT INTO libraries (name, type, path) VALUES (?, ?, ?)').run(DEVICE_IMPORT_NAME, DEVICE_IMPORT_TYPE, null);
    lib = { id: info.lastInsertRowid, name: DEVICE_IMPORT_NAME, type: DEVICE_IMPORT_TYPE, path: null };
  }
  return lib;
}

module.exports = { getDeviceImportLibrary, DEVICE_IMPORT_TYPE, DEVICE_IMPORT_NAME };
