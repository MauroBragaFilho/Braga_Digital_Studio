        </div>
        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
          <div style="width: ${dev.storageInfo.percent}%; height: 100%; background: #4caf50; border-radius: 3px;"></div>
        </div>
      </div>
    `;
  }

  return '';
}

function handleCardAction(action, devId) {
  const dev = devicesData.find(d => d.id === devId);
  if (!dev) return;

  if (action === 'explore') {
    if (dev.type === 'mtp') {
      if (typeof window.openMtpExplorer === 'function') {
        window.openMtpExplorer(devId);
      }
    } else {
      window.bdsModal.alert(`Abrindo navegador de arquivos para: ${dev.title}`);
    }
  } else if (action === 'eject') {
    window.bdsModal.alert(`Ejetando o dispositivo com segurança: ${dev.title}`);
  } else if (action === 'configure') {
    window.bdsModal.alert(`Abrindo configurações avançadas de FTP para: ${dev.title}`);
  } else if (action === 'import') {
    window.bdsModal.alert(`Iniciando importação rápida de fotos e vídeos de: ${dev.title}`);
  } else if (action === 'more') {
    window.bdsModal.alert(`Opções adicionais para: ${dev.title}`);
  }
}

function renderInspector() {
