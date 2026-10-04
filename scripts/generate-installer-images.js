'use strict';

/**
 * generate-installer-images.js — gera as imagens do instalador (installer/*.bmp) a partir da marca.
 *
 * Ferramenta de DESENVOLVIMENTO (não faz parte do app nem entra no instalador): usa o Electron já instalado para
 * renderizar HTML e capturar a imagem, sem adicionar dependências.
 *
 *   node_modules/electron/dist/electron.exe scripts/generate-installer-images.js [pasta-de-saida]
 *
 * Saída (BMP 24 bits, como o NSIS exige):
 *   installerSidebar.bmp / uninstallerSidebar.bmp   164 x 314  (páginas de boas-vindas e final)
 *   installerHeader.bmp                              150 x 57   (cabeçalho das demais páginas)
 * Marca: fundo preto, branco e vermelho #ff0000, ícone do app (assets/icon.png) e Montserrat/Inter do app.
 *
 * Os dados temporários do Electron vão para uma pasta temporária (apagada ao final): nunca para %APPDATA%.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(ROOT, 'installer'));
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bds-instimg-'));
app.setPath('userData', TMP_DATA);
app.setPath('sessionData', TMP_DATA);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* não encerra entre uma imagem e outra */ });

const fileUrl = (...p) => pathToFileURL(path.join(ROOT, ...p)).toString();
const FONT_CSS = `
  @font-face { font-family: 'Montserrat'; font-weight: 700; src: url('${fileUrl('renderer', 'assets', 'fonts', 'Montserrat-Bold.woff2')}'); }
  @font-face { font-family: 'Inter'; font-weight: 400; src: url('${fileUrl('renderer', 'assets', 'fonts', 'Inter-Regular.woff2')}'); }
  @font-face { font-family: 'Inter'; font-weight: 600; src: url('${fileUrl('renderer', 'assets', 'fonts', 'Inter-SemiBold.woff2')}'); }
`;
const ICON = fileUrl('assets', 'icon.png');

const SIDEBAR_HTML = `<!doctype html><meta charset="utf-8"><style>${FONT_CSS}
  html, body { margin: 0; width: 164px; height: 314px; overflow: hidden; background: #0b0b0b; }
  .bg { position: absolute; inset: 0; background:
        radial-gradient(120px 120px at 100% 0%, rgba(255,0,0,.30), transparent 70%),
        radial-gradient(160px 160px at 0% 100%, rgba(255,0,0,.20), transparent 70%),
        linear-gradient(180deg, #151515 0%, #080808 100%); }
  .bar { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: #ff0000; }
  .icon { position: absolute; left: 22px; top: 34px; width: 120px; height: 120px; border-radius: 22px;
          box-shadow: 0 8px 24px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
  .name { position: absolute; left: 0; right: 0; top: 176px; text-align: center; color: #fff;
          font: 700 15px/1.2 'Montserrat', sans-serif; letter-spacing: .5px; }
  .name b { color: #ff0000; font-weight: 700; }
  .line { position: absolute; left: 52px; right: 52px; top: 222px; height: 2px; background: #ff0000; }
  .tag { position: absolute; left: 14px; right: 14px; top: 236px; text-align: center; color: #bdbdbd;
         font: 400 11px/1.4 'Inter', sans-serif; }
  .foot { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; color: #7a7a7a;
          font: 600 9px/1 'Inter', sans-serif; letter-spacing: 1.5px; }
</style>
<div class="bg"></div><div class="bar"></div>
<img class="icon" src="${ICON}">
<div class="name">BRAGA <b>DIGITAL</b><br>STUDIO</div>
<div class="line"></div>
<div class="tag">Suíte de mídia e<br>produção digital</div>
<div class="foot">INSTALADOR</div>`;

const HEADER_HTML = `<!doctype html><meta charset="utf-8"><style>${FONT_CSS}
  html, body { margin: 0; width: 150px; height: 57px; overflow: hidden; background: #0b0b0b; }
  .bg { position: absolute; inset: 0; background: linear-gradient(90deg, #1a1a1a 0%, #0b0b0b 100%); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: #ff0000; }
  .icon { position: absolute; left: 8px; top: 8px; width: 38px; height: 38px; border-radius: 8px; }
  .t1 { position: absolute; left: 54px; top: 13px; color: #fff; font: 700 10px/1.15 'Montserrat', sans-serif; letter-spacing: .3px; }
  .t1 b { color: #ff0000; font-weight: 700; }
  .t2 { position: absolute; left: 54px; top: 38px; color: #9a9a9a; font: 400 8px/1 'Inter', sans-serif; }
</style>
<div class="bg"></div><div class="bar"></div>
<img class="icon" src="${ICON}">
<div class="t1">BRAGA <b>DIGITAL</b><br>STUDIO</div>
<div class="t2">Instalador</div>`;

/** BMP de 24 bits (de baixo para cima, linhas alinhadas em 4 bytes) a partir do bitmap BGRA do Electron. */
function toBmp24(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4;
    const dstRow = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 3;
      out[d] = bgra[s];         // B
      out[d + 1] = bgra[s + 1]; // G
      out[d + 2] = bgra[s + 2]; // R
    }
  }
  return out;
}

async function render(html, width, height) {
  const win = new BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, transparent: false, backgroundColor: '#0b0b0b',
    webPreferences: { offscreen: false, backgroundThrottling: false, sandbox: true }
  });
  win.webContents.setZoomFactor(1);
  const tmp = path.join(TMP_DATA, `page-${width}x${height}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 300));
  let img = await win.webContents.capturePage();
  const size = img.getSize();
  if (size.width !== width || size.height !== height) img = img.resize({ width, height, quality: 'best' });
  const bmp = toBmp24(img.toBitmap(), width, height);
  win.destroy();
  return bmp;
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const sidebar = await render(SIDEBAR_HTML, 164, 314);
    fs.writeFileSync(path.join(OUT_DIR, 'installerSidebar.bmp'), sidebar);
    fs.writeFileSync(path.join(OUT_DIR, 'uninstallerSidebar.bmp'), sidebar);
    fs.writeFileSync(path.join(OUT_DIR, 'installerHeader.bmp'), await render(HEADER_HTML, 150, 57));
    console.log(`Imagens do instalador geradas em ${OUT_DIR}`);
  } catch (err) {
    console.error('Falha ao gerar as imagens:', err && err.message);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) { /* noop */ }
    app.exit(process.exitCode || 0);
  }
});
