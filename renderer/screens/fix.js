const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'devices.js');
let content = fs.readFileSync(file, 'utf8');

// We will remove the direct binding inside initScreen
const startPattern = `  const btnMtpImport = document.getElementById('btnMtpImport');`;
const endPattern = `      updateMtpImportButton();\n    });\n  }`;

const startIndex = content.indexOf(startPattern);
if (startIndex !== -1) {
  const endIndex = content.indexOf(endPattern, startIndex) + endPattern.length;
  
  // Remove it from initScreen
  content = content.substring(0, startIndex) + content.substring(endIndex);
  
  // Now add it to the global document click listener at the bottom
  const globalListenerPattern = `// Attach event listener inside grid generation to "Explorar" button
document.addEventListener('click', (e) => {`;
  
  const newGlobalListener = `// Attach event listener inside grid generation to "Explorar" button
document.addEventListener('click', async (e) => {
  // MTP Import Button
  const mtpImportBtn = e.target.closest('#btnMtpImport');
  if (mtpImportBtn && !mtpImportBtn.hasAttribute('disabled')) {
    const eventName = await window.bdsModal.prompt('Digite o nome do Evento ou Pasta (ex: Casamento_Joao):');
    if (!eventName) return;

    const itemsToImport = Array.from(mtpSelectedItems);
    if (itemsToImport.length === 0) return;

    // Pegar configuracoes para saber o deviceFolder
    const settings = await window.bds.getSettings();
    const baseDest = settings.deviceFolder || 'C:/Users/Public/Videos/BDSM DEVICES'; // Fallback
    const finalDest = baseDest + '\\\\' + mtpCurrentDevice + '\\\\' + eventName;

    mtpImportBtn.setAttribute('disabled', 'true');
    mtpImportBtn.innerHTML = \`<span class="material-symbols-rounded" style="animation: spin 1s linear infinite;">sync</span> Importando...\`;

    try {
      const success = await window.bds.importMtpItems(mtpCurrentDevice, mtpCurrentPath, itemsToImport, finalDest);
      if (success) {
        window.bdsModal.alert('Importação Concluída');
        mtpSelectedItems.clear();
        loadMtpFolder();
      } else {
        window.bdsModal.alert('Houve um erro durante a importação.');
      }
    } catch(err) {
      window.bdsModal.alert('Erro ao importar itens.');
    }

    mtpImportBtn.innerHTML = \`<span class="material-symbols-rounded" style="font-size: 18px;">download</span> Importar Selecionados\`;
    updateMtpImportButton();
    return;
  }
`;
  
  content = content.replace(globalListenerPattern, newGlobalListener);

  fs.writeFileSync(file, content, 'utf8');
  console.log('Fixed btnMtpImport by using global delegation');
} else {
  console.log('Could not find startPattern');
}
