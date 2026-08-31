// Script de correção: remover listeners duplicados de status-update do Sony
const fs = require('fs');
const filePath = 'd:/Projetos/Braga Digital Studio/src/bootstrap.js';

let c = fs.readFileSync(filePath, 'utf8');

// Remover o listener duplicado 'status-update' (nunca emitido pelo SonyCameraService)
c = c.replace(
  "    sonyCameraService.on('status-update', (d) => this.mainWindow?.webContents.send('sony-camera:status-update', d));\n",
  ""
);

// Remover o listener 'download-progress' duplicado
c = c.replace(
  "    sonyCameraService.on('download-progress', (d) => this.mainWindow?.webContents.send('sony-camera:download-progress', d));\n",
  ""
);

fs.writeFileSync(filePath, c, 'utf8');
console.log('OK');
