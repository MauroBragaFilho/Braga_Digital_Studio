import { setStatus, setAppStatus, escapeHtml } from '../app.js';

let corruptFilePath = null;
let referenceFilePath = null;
let customOutputDir = null;
let lastRecoveredPath = null;
let isRecovering = false;

// --- Estado RAW ---
let rawCorruptFilePath = null;
let rawReferenceFilePath = null;
let rawCustomOutputDir = null;
let rawLastRecoveredPath = null;
let isRawRecovering = false;

export function initScreen() {
  bindEvents();
  setupDragAndDrop();
  setupRecoveryListeners();
  setupTabs();

  bindRawEvents();
  setupRawDragAndDrop();
  setupRawRecoveryListeners();
}

function setupTabs() {
  const btnVideo = document.getElementById('recoveryTabBtnVideo');
  const btnRaw = document.getElementById('recoveryTabBtnRaw');
  const panelVideo = document.getElementById('recoveryPanelVideo');
  const panelRaw = document.getElementById('recoveryPanelRaw');

  const activate = (tab) => {
    const isVideo = tab === 'video';
    btnVideo?.classList.toggle('active', isVideo);
    btnRaw?.classList.toggle('active', !isVideo);
    panelVideo?.classList.toggle('active', isVideo);
    panelRaw?.classList.toggle('active', !isVideo);
  };

  btnVideo?.addEventListener('click', () => activate('video'));
  btnRaw?.addEventListener('click', () => activate('raw'));
}

function bindEvents() {
  // Seleção de Arquivo Danificado
  document.getElementById('btnSelectCorruptFile')?.addEventListener('click', selectCorruptFile);
  document.getElementById('btnClearCorruptFile')?.addEventListener('click', clearCorruptFile);

  // Seleção de Arquivo de Referência
  document.getElementById('btnSelectReferenceFile')?.addEventListener('click', selectReferenceFile);
  document.getElementById('btnClearReferenceFile')?.addEventListener('click', clearReferenceFile);

  // Seleção de Pasta de Saída
  document.getElementById('btnSelectOutputDir')?.addEventListener('click', selectOutputDir);

  // Ações de Execução e Cancelamento
  document.getElementById('btnStartRecovery')?.addEventListener('click', startRecovery);
  document.getElementById('btnCancelRecovery')?.addEventListener('click', cancelRecovery);

  // Botões do Card de Sucesso
  document.getElementById('btnPlayRecoveredVideo')?.addEventListener('click', () => {
    if (lastRecoveredPath && window.bdsFloatingPlayer) {
      window.bdsFloatingPlayer.play(lastRecoveredPath, 'Vídeo Recuperado');
    }
  });

  document.getElementById('btnOpenRecoveredFolder')?.addEventListener('click', () => {
    if (lastRecoveredPath && window.bds?.openLocalPath) {
      const folder = customOutputDir || lastRecoveredPath.substring(0, Math.max(lastRecoveredPath.lastIndexOf('\\'), lastRecoveredPath.lastIndexOf('/')));
      window.bds.openLocalPath(folder);
    }
  });

  document.getElementById('btnRecoverAnother')?.addEventListener('click', resetForm);

  // Fechar Banner de Erro
  document.getElementById('btnCloseRecoveryError')?.addEventListener('click', () => {
    document.getElementById('recoveryErrorBanner')?.classList.add('hidden');
  });
}

function setupDragAndDrop() {
  const corruptDropzone = document.getElementById('corruptDropzone');
  const referenceDropzone = document.getElementById('referenceDropzone');

  const handleDrag = (el, onDrop) => {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('dragover');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const path = window.bds.getPathForFile ? window.bds.getPathForFile(files[0]) : files[0].path;
        if (path) onDrop(path);
      }
    });
  };

  handleDrag(corruptDropzone, (path) => setCorruptFile(path));
  handleDrag(referenceDropzone, (path) => setReferenceFile(path));
}

function setupRecoveryListeners() {
  if (window.bds?.recovery?.onProgress) {
    window.bds.recovery.onProgress((data) => {
      updateProgressUI(data);
      if (data.percent) setAppStatus(`Recuperando ${Math.round(data.percent)}%...`, 'info');
    });
  }
}

async function selectCorruptFile() {
  try {
    const files = await window.bds.selectFiles({
      title: 'Selecionar Vídeo Danificado ou Corrompido',
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'ts', 'mts', '3gp'] }],
      properties: ['openFile']
    });
    if (files && files.length > 0) {
      await setCorruptFile(files[0]);
    }
  } catch (err) {
    showError('Erro ao selecionar arquivo: ' + err.message);
  }
}

async function selectReferenceFile() {
  try {
    const files = await window.bds.selectFiles({
      title: 'Selecionar Vídeo de Referência (Gravado pela mesma câmera)',
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'ts', 'mts', '3gp'] }],
      properties: ['openFile']
    });
    if (files && files.length > 0) {
      await setReferenceFile(files[0]);
    }
  } catch (err) {
    showError('Erro ao selecionar referência: ' + err.message);
  }
}

async function setCorruptFile(filePath) {
  corruptFilePath = filePath;
  hideError();

  const dropzone = document.getElementById('corruptDropzone');
  const details = document.getElementById('corruptFileDetails');
  const btnClear = document.getElementById('btnClearCorruptFile');
  const fileNameEl = document.getElementById('corruptFileName');
  const sizeEl = document.getElementById('corruptFileSize');
  const badgeEl = document.getElementById('corruptSeverityBadge');
  const structEl = document.getElementById('corruptStructureInfo');
  const btnStart = document.getElementById('btnStartRecovery');

  if (dropzone) dropzone.classList.add('hidden');
  if (details) details.classList.remove('hidden');
  if (btnClear) btnClear.classList.remove('hidden');
  if (btnStart) btnStart.disabled = false;

  const baseName = filePath.split(/[\\/]/).pop();
  if (fileNameEl) fileNameEl.textContent = baseName;
  if (badgeEl) {
    badgeEl.textContent = 'Analisando...';
    badgeEl.className = 'badge badge-yellow';
  }

  // Executar diagnóstico
  await runDiagnosis();
}

async function setReferenceFile(filePath) {
  referenceFilePath = filePath;
  hideError();

  const dropzone = document.getElementById('referenceDropzone');
  const details = document.getElementById('referenceFileDetails');
  const btnClear = document.getElementById('btnClearReferenceFile');
  const fileNameEl = document.getElementById('referenceFileName');

  if (dropzone) dropzone.classList.add('hidden');
  if (details) details.classList.remove('hidden');
  if (btnClear) btnClear.classList.remove('hidden');

  const baseName = filePath.split(/[\\/]/).pop();
  if (fileNameEl) fileNameEl.textContent = baseName;

  // Executar diagnóstico comparativo
  await runDiagnosis();
}

function clearCorruptFile() {
  corruptFilePath = null;
  const dropzone = document.getElementById('corruptDropzone');
  const details = document.getElementById('corruptFileDetails');
  const btnClear = document.getElementById('btnClearCorruptFile');
  const btnStart = document.getElementById('btnStartRecovery');

  if (dropzone) dropzone.classList.remove('hidden');
  if (details) details.classList.add('hidden');
  if (btnClear) btnClear.classList.add('hidden');
  if (btnStart) btnStart.disabled = true;

  clearReferenceCompatibility();
}

function clearReferenceFile() {
  referenceFilePath = null;
  const dropzone = document.getElementById('referenceDropzone');
  const details = document.getElementById('referenceFileDetails');
  const btnClear = document.getElementById('btnClearReferenceFile');
  const refVideo = document.getElementById('referenceVideoPreview');

  if (dropzone) dropzone.classList.remove('hidden');
  if (details) details.classList.add('hidden');
  if (btnClear) btnClear.classList.add('hidden');
  if (refVideo) {
    refVideo.pause();
    refVideo.src = '';
  }

  clearReferenceCompatibility();
}

function clearReferenceCompatibility() {
  const compatBadge = document.getElementById('referenceCompatBadge');
  const compatMsg = document.getElementById('referenceCompatMessage');
  if (compatBadge) {
    compatBadge.textContent = '-';
    compatBadge.className = 'badge';
  }
  if (compatMsg) compatMsg.textContent = '-';
}

async function selectOutputDir() {
  try {
    const dir = await window.bds.selectFolder();
    if (dir) {
      customOutputDir = dir;
      const pathEl = document.getElementById('recoveryOutputPath');
      if (pathEl) pathEl.textContent = dir;
    }
  } catch (err) {
    console.error('Erro ao selecionar pasta de saída:', err);
  }
}

async function runDiagnosis() {
  if (!corruptFilePath) return;

  try {
    const diag = await window.bds.recovery.diagnose(corruptFilePath, referenceFilePath);
    renderDiagnosticResults(diag);
  } catch (err) {
    console.error('Erro no diagnóstico:', err);
    showError('Falha ao analisar o arquivo: ' + err.message);
  }
}

function renderDiagnosticResults(diag) {
  const { corrupted, reference, compatibility } = diag;

  // Informações do Danificado
  const sizeEl = document.getElementById('corruptFileSize');
  const badgeEl = document.getElementById('corruptSeverityBadge');
  const structEl = document.getElementById('corruptStructureInfo');

  if (sizeEl) sizeEl.textContent = formatBytes(corrupted.sizeBytes);
  if (structEl) structEl.textContent = `${corrupted.codec} | ${corrupted.resolution}`;

  if (badgeEl) {
    if (corrupted.severity.includes('CRÍTICA')) {
      badgeEl.textContent = 'Danos Estruturais (Moov Ausente)';
      badgeEl.className = 'badge badge-red';
    } else if (corrupted.severity.includes('MODERADA')) {
      badgeEl.textContent = 'Índices Corrompidos';
      badgeEl.className = 'badge badge-yellow';
    } else {
      badgeEl.textContent = 'Danos Leves';
      badgeEl.className = 'badge badge-green';
    }
  }

  // Informações e Preview da Referência
  if (reference) {
    const refSpecs = document.getElementById('referenceSpecs');
    const compatBadge = document.getElementById('referenceCompatBadge');
    const compatMsg = document.getElementById('referenceCompatMessage');
    const refVideo = document.getElementById('referenceVideoPreview');

    if (refSpecs) refSpecs.textContent = `${reference.codec} | ${reference.resolution} | ${formatBytes(reference.sizeBytes)}`;

    if (compatBadge) {
      compatBadge.textContent = compatibility.badge;
      if (compatibility.status === 'ALTA') compatBadge.className = 'badge badge-green';
      else if (compatibility.status === 'MEDIA') compatBadge.className = 'badge badge-yellow';
      else compatBadge.className = 'badge badge-red';
    }

    if (compatMsg) compatMsg.textContent = compatibility.message;

    if (refVideo && reference.path) {
      refVideo.src = `file:///${reference.path.replace(/\\/g, '/')}`;
    }
  }
}

async function startRecovery() {
  if (!corruptFilePath || isRecovering) return;

  isRecovering = true;
  hideError();

  const progressCard = document.getElementById('recoveryProgressCard');
  const successCard = document.getElementById('recoverySuccessCard');
  const btnStart = document.getElementById('btnStartRecovery');
  const btnCancel = document.getElementById('btnCancelRecovery');

  if (progressCard) progressCard.classList.remove('hidden');
  if (successCard) successCard.classList.add('hidden');
  if (btnStart) btnStart.classList.add('hidden');
  if (btnCancel) btnCancel.classList.remove('hidden');

  setStatus('Recuperando vídeo...');
  setAppStatus('Recuperando vídeo...', 'warning');
  updateProgressUI({ percent: 5, message: 'Iniciando diagnóstico e recuperação...' });

  try {
    const result = await window.bds.recovery.start({
      corruptPath: corruptFilePath,
      referencePath: referenceFilePath,
      outputDir: customOutputDir,
      preferredLevel: 'AUTO'
    });

    if (result && result.success) {
      lastRecoveredPath = result.outputPath;
      renderSuccessResult(result);
      setStatus('Vídeo recuperado com sucesso!');
      setAppStatus('Pronto', 'success');
    }
  } catch (err) {
    console.error('Erro na recuperação:', err);
    showError(err.message || 'Não foi possível concluir a recuperação do vídeo.');
    setStatus('Falha na recuperação.');
    setAppStatus('Erro na recuperação', 'error');
  } finally {
    isRecovering = false;
    if (progressCard) progressCard.classList.add('hidden');
    if (btnStart) btnStart.classList.remove('hidden');
    if (btnCancel) btnCancel.classList.add('hidden');
  }
}

async function cancelRecovery() {
  if (!isRecovering) return;
  try {
    await window.bds.recovery.cancel();
    setStatus('Recuperação cancelada.');
    setAppStatus('Pronto', 'info');
  } catch (err) {
    console.error('Erro ao cancelar:', err);
  }
}

function updateProgressUI(data) {
  const fill = document.getElementById('recoveryProgressFill');
  const percentEl = document.getElementById('recoveryProgressPercent');
  const stepEl = document.getElementById('recoveryProgressStep');

  const pct = data.percent || 0;
  if (fill) fill.style.width = `${pct}%`;
  if (percentEl) percentEl.textContent = `${pct}%`;
  if (stepEl && data.message) stepEl.textContent = data.message;
}

function renderSuccessResult(result) {
  const successCard = document.getElementById('recoverySuccessCard');
  const fileNameEl = document.getElementById('resultFileName');
  const methodEl = document.getElementById('resultMethod');
  const resolutionEl = document.getElementById('resultResolution');
  const sizeEl = document.getElementById('resultSize');
  const durationEl = document.getElementById('resultDuration');
  const videoPlayer = document.getElementById('recoveryResultVideoPlayer');

  if (fileNameEl) fileNameEl.textContent = result.fileName;
  if (methodEl) methodEl.textContent = result.methodUsed;
  if (resolutionEl) resolutionEl.textContent = `${result.resolution} (${result.codec})`;
  if (sizeEl) sizeEl.textContent = formatBytes(result.sizeBytes);
  if (durationEl) durationEl.textContent = formatDuration(result.durationSec);

  // Injetar URL do vídeo no player de preview embutido
  if (videoPlayer && result.outputPath) {
    videoPlayer.src = `file:///${result.outputPath.replace(/\\/g, '/')}`;
    videoPlayer.load();
  }

  if (successCard) {
    successCard.classList.remove('hidden');
    successCard.scrollIntoView({ behavior: 'smooth' });
  }
}

function resetForm() {
  clearCorruptFile();
  clearReferenceFile();
  lastRecoveredPath = null;
  const videoPlayer = document.getElementById('recoveryResultVideoPlayer');
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.src = '';
  }
  document.getElementById('recoverySuccessCard')?.classList.add('hidden');
  document.getElementById('recoveryProgressCard')?.classList.add('hidden');
  hideError();
}

function showError(msg) {
  const banner = document.getElementById('recoveryErrorBanner');
  const msgEl = document.getElementById('recoveryErrorMessage');
  if (banner && msgEl) {
    msgEl.textContent = msg;
    banner.classList.remove('hidden');
  }
}

function hideError() {
  document.getElementById('recoveryErrorBanner')?.classList.add('hidden');
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '-';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  const mb = bytes / (1024 ** 2);
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  const kb = bytes / 1024;
  return kb.toFixed(0) + ' KB';
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return 'Indisponível';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}h ${remMins}m ${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

/* ===================================================================== */
/* ============================  RAW FLOW  =============================== */
/* ===================================================================== */

function bindRawEvents() {
  // Seleção de Arquivo Danificado
  document.getElementById('btnSelectRawCorruptFile')?.addEventListener('click', selectRawCorruptFile);
  document.getElementById('btnClearRawCorruptFile')?.addEventListener('click', clearRawCorruptFile);

  // Seleção de Arquivo de Referência
  document.getElementById('btnSelectRawReferenceFile')?.addEventListener('click', selectRawReferenceFile);
  document.getElementById('btnClearRawReferenceFile')?.addEventListener('click', clearRawReferenceFile);

  // Seleção de Pasta de Saída
  document.getElementById('btnSelectRawOutputDir')?.addEventListener('click', selectRawOutputDir);

  // Ações de Execução e Cancelamento
  document.getElementById('btnStartRawRecovery')?.addEventListener('click', startRawRecovery);
  document.getElementById('btnCancelRawRecovery')?.addEventListener('click', cancelRawRecovery);

  // Botões do Card de Sucesso
  document.getElementById('btnOpenRawRecoveredFolder')?.addEventListener('click', () => {
    if (rawLastRecoveredPath && window.bds?.openLocalPath) {
      const folder = rawCustomOutputDir || rawLastRecoveredPath.substring(0, Math.max(rawLastRecoveredPath.lastIndexOf('\\'), rawLastRecoveredPath.lastIndexOf('/')));
      window.bds.openLocalPath(folder);
    }
  });

  document.getElementById('btnRecoverAnotherRaw')?.addEventListener('click', resetRawForm);

  // Fechar Banner de Erro
  document.getElementById('btnCloseRawError')?.addEventListener('click', () => {
    document.getElementById('rawErrorBanner')?.classList.add('hidden');
  });
}

function setupRawDragAndDrop() {
  const corruptDropzone = document.getElementById('rawCorruptDropzone');
  const referenceDropzone = document.getElementById('rawReferenceDropzone');

  const handleDrag = (el, onDrop) => {
    if (!el) return;
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('dragover');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const path = window.bds.getPathForFile ? window.bds.getPathForFile(files[0]) : files[0].path;
        if (path) onDrop(path);
      }
    });
  };

  handleDrag(corruptDropzone, (path) => setRawCorruptFile(path));
  handleDrag(referenceDropzone, (path) => setRawReferenceFile(path));
}

function setupRawRecoveryListeners() {
  if (window.bds?.recovery?.raw?.onProgress) {
    window.bds.recovery.raw.onProgress((data) => {
      updateRawProgressUI(data);
      if (data.percent) setAppStatus(`Recuperando RAW ${Math.round(data.percent)}%...`, 'info');
    });
  }
}

async function selectRawCorruptFile() {
  try {
    const files = await window.bds.selectFiles({
      title: 'Selecionar Arquivo RAW Danificado ou Corrompido',
      filters: [{ name: 'RAW', extensions: ['cr2', 'arw', 'nef'] }],
      properties: ['openFile']
    });
    if (files && files.length > 0) {
      await setRawCorruptFile(files[0]);
    }
  } catch (err) {
    showRawError('Erro ao selecionar arquivo: ' + err.message);
  }
}

async function selectRawReferenceFile() {
  try {
    const files = await window.bds.selectFiles({
      title: 'Selecionar RAW de Referência (Gravado pela mesma câmera)',
      filters: [{ name: 'RAW', extensions: ['cr2', 'arw', 'nef'] }],
      properties: ['openFile']
    });
    if (files && files.length > 0) {
      await setRawReferenceFile(files[0]);
    }
  } catch (err) {
    showRawError('Erro ao selecionar referência: ' + err.message);
  }
}

async function setRawCorruptFile(filePath) {
  rawCorruptFilePath = filePath;
  hideRawError();

  const dropzone = document.getElementById('rawCorruptDropzone');
  const details = document.getElementById('rawCorruptFileDetails');
  const btnClear = document.getElementById('btnClearRawCorruptFile');
  const badgeEl = document.getElementById('rawCorruptSeverityBadge');
  const btnStart = document.getElementById('btnStartRawRecovery');

  if (dropzone) dropzone.classList.add('hidden');
  if (details) details.classList.remove('hidden');
  if (btnClear) btnClear.classList.remove('hidden');
  if (btnStart) btnStart.disabled = false;

  const baseName = filePath.split(/[\\/]/).pop();
  const fileNameEl = document.getElementById('rawCorruptFileName');
  if (fileNameEl) fileNameEl.textContent = baseName;
  if (badgeEl) {
    badgeEl.textContent = 'Analisando...';
    badgeEl.className = 'badge badge-yellow';
  }

  await runRawDiagnosis();
}

async function setRawReferenceFile(filePath) {
  rawReferenceFilePath = filePath;
  hideRawError();

  const dropzone = document.getElementById('rawReferenceDropzone');
  const details = document.getElementById('rawReferenceFileDetails');
  const btnClear = document.getElementById('btnClearRawReferenceFile');
  const fileNameEl = document.getElementById('rawReferenceFileName');

  if (dropzone) dropzone.classList.add('hidden');
  if (details) details.classList.remove('hidden');
  if (btnClear) btnClear.classList.remove('hidden');

  const baseName = filePath.split(/[\\/]/).pop();
  if (fileNameEl) fileNameEl.textContent = baseName;

  await runRawDiagnosis();
}

function clearRawCorruptFile() {
  rawCorruptFilePath = null;
  const dropzone = document.getElementById('rawCorruptDropzone');
  const details = document.getElementById('rawCorruptFileDetails');
  const btnClear = document.getElementById('btnClearRawCorruptFile');
  const btnStart = document.getElementById('btnStartRawRecovery');

  if (dropzone) dropzone.classList.remove('hidden');
  if (details) details.classList.add('hidden');
  if (btnClear) btnClear.classList.add('hidden');
  if (btnStart) btnStart.disabled = true;

  clearRawReferenceCompatibility();
}

function clearRawReferenceFile() {
  rawReferenceFilePath = null;
  const dropzone = document.getElementById('rawReferenceDropzone');
  const details = document.getElementById('rawReferenceFileDetails');
  const btnClear = document.getElementById('btnClearRawReferenceFile');

  if (dropzone) dropzone.classList.remove('hidden');
  if (details) details.classList.add('hidden');
  if (btnClear) btnClear.classList.add('hidden');

  clearRawReferenceCompatibility();
}

function clearRawReferenceCompatibility() {
  const compatBadge = document.getElementById('rawReferenceCompatBadge');
  const compatMsg = document.getElementById('rawReferenceCompatMessage');
  if (compatBadge) {
    compatBadge.textContent = '-';
    compatBadge.className = 'badge';
  }
  if (compatMsg) compatMsg.textContent = '-';
}

async function selectRawOutputDir() {
  try {
    const dir = await window.bds.selectFolder();
    if (dir) {
      rawCustomOutputDir = dir;
      const pathEl = document.getElementById('rawOutputPath');
      if (pathEl) pathEl.textContent = dir;
    }
  } catch (err) {
    console.error('Erro ao selecionar pasta de saída (RAW):', err);
  }
}

async function runRawDiagnosis() {
  if (!rawCorruptFilePath) return;

  try {
    const diag = await window.bds.recovery.raw.diagnose(rawCorruptFilePath, rawReferenceFilePath);
    renderRawDiagnosticResults(diag);
  } catch (err) {
    console.error('Erro no diagnóstico RAW:', err);
    showRawError('Falha ao analisar o arquivo: ' + err.message);
  }
}

function renderRawDiagnosticResults(diag) {
  const { corrupted, reference, compatibility } = diag;

  const sizeEl = document.getElementById('rawCorruptFileSize');
  const badgeEl = document.getElementById('rawCorruptSeverityBadge');
  const structEl = document.getElementById('rawCorruptStructureInfo');

  if (sizeEl) sizeEl.textContent = formatBytes(corrupted.sizeBytes);
  if (structEl) structEl.textContent = `${corrupted.manufacturer} ${corrupted.camera !== 'Desconhecido' ? corrupted.camera : ''}`.trim() || corrupted.format;

  if (badgeEl) {
    if (corrupted.severity.includes('CRÍTICA')) {
      badgeEl.textContent = 'Assinatura Ausente';
      badgeEl.className = 'badge badge-red';
    } else if (corrupted.severity.includes('MODERADA')) {
      badgeEl.textContent = 'Dados Parcialmente Legíveis';
      badgeEl.className = 'badge badge-yellow';
    } else {
      badgeEl.textContent = 'Danos Leves';
      badgeEl.className = 'badge badge-green';
    }
  }

  if (reference) {
    const refSpecs = document.getElementById('rawReferenceSpecs');
    const compatBadge = document.getElementById('rawReferenceCompatBadge');
    const compatMsg = document.getElementById('rawReferenceCompatMessage');

    if (refSpecs) refSpecs.textContent = `${reference.manufacturer} ${reference.camera !== 'Desconhecido' ? reference.camera : ''} | ${reference.format}`.trim();

    if (compatBadge) {
      compatBadge.textContent = compatibility.badge;
      if (compatibility.status === 'ALTA') compatBadge.className = 'badge badge-green';
      else if (compatibility.status === 'MEDIA') compatBadge.className = 'badge badge-yellow';
      else compatBadge.className = 'badge badge-red';
    }

    if (compatMsg) compatMsg.textContent = compatibility.message;
  }
}

async function startRawRecovery() {
  if (!rawCorruptFilePath || isRawRecovering) return;

  isRawRecovering = true;
  hideRawError();

  const progressCard = document.getElementById('rawProgressCard');
  const successCard = document.getElementById('rawSuccessCard');
  const btnStart = document.getElementById('btnStartRawRecovery');
  const btnCancel = document.getElementById('btnCancelRawRecovery');

  if (progressCard) progressCard.classList.remove('hidden');
  if (successCard) successCard.classList.add('hidden');
  if (btnStart) btnStart.classList.add('hidden');
  if (btnCancel) btnCancel.classList.remove('hidden');

  setStatus('Recuperando arquivo RAW...');
  setAppStatus('Recuperando arquivo RAW...', 'warning');
  updateRawProgressUI({ percent: 5, message: 'Iniciando diagnóstico e recuperação...' });

  try {
    const result = await window.bds.recovery.raw.start({
      corruptPath: rawCorruptFilePath,
      referencePath: rawReferenceFilePath,
      outputDir: rawCustomOutputDir,
    });

    if (result && result.success) {
      rawLastRecoveredPath = result.outputPath;
      renderRawSuccessResult(result);
      setStatus('Arquivo RAW recuperado com sucesso!');
      setAppStatus('Pronto', 'success');
    }
  } catch (err) {
    console.error('Erro na recuperação RAW:', err);
    showRawError(err.message || 'Não foi possível concluir a recuperação do RAW.');
    setStatus('Falha na recuperação RAW.');
    setAppStatus('Erro na recuperação RAW', 'error');
  } finally {
    isRawRecovering = false;
    if (progressCard) progressCard.classList.add('hidden');
    if (btnStart) btnStart.classList.remove('hidden');
    if (btnCancel) btnCancel.classList.add('hidden');
  }
}

async function cancelRawRecovery() {
  if (!isRawRecovering) return;
  try {
    await window.bds.recovery.raw.cancel();
    setStatus('Recuperação RAW cancelada.');
    setAppStatus('Pronto', 'info');
  } catch (err) {
    console.error('Erro ao cancelar recuperação RAW:', err);
  }
}

function updateRawProgressUI(data) {
  const fill = document.getElementById('rawProgressFill');
  const percentEl = document.getElementById('rawProgressPercent');
  const stepEl = document.getElementById('rawProgressStep');

  const pct = data.percent || 0;
  if (fill) fill.style.width = `${pct}%`;
  if (percentEl) percentEl.textContent = `${pct}%`;
  if (stepEl && data.message) stepEl.textContent = data.message;
}

function renderRawSuccessResult(result) {
  const successCard = document.getElementById('rawSuccessCard');
  const fileNameEl = document.getElementById('rawResultFileName');
  const methodEl = document.getElementById('rawResultMethod');
  const typeEl = document.getElementById('rawResultType');
  const cameraEl = document.getElementById('rawResultCamera');
  const sizeEl = document.getElementById('rawResultSize');
  const qualityEl = document.getElementById('rawResultQuality');

  if (fileNameEl) fileNameEl.textContent = result.fileName;
  if (methodEl) methodEl.textContent = result.methodUsed;
  if (typeEl) typeEl.textContent = result.outputType;
  if (cameraEl) cameraEl.textContent = [result.camera, result.resolution].filter(Boolean).join(' | ') || '-';
  if (sizeEl) sizeEl.textContent = formatBytes(result.sizeBytes);
  if (qualityEl) qualityEl.textContent = result.resultQuality;

  if (successCard) {
    successCard.classList.remove('hidden');
    successCard.scrollIntoView({ behavior: 'smooth' });
  }
}

function resetRawForm() {
  clearRawCorruptFile();
  clearRawReferenceFile();
  rawLastRecoveredPath = null;
  document.getElementById('rawSuccessCard')?.classList.add('hidden');
  document.getElementById('rawProgressCard')?.classList.add('hidden');
  hideRawError();
}

function showRawError(msg) {
  const banner = document.getElementById('rawErrorBanner');
  const msgEl = document.getElementById('rawErrorMessage');
  if (banner && msgEl) {
    msgEl.textContent = msg;
    banner.classList.remove('hidden');
  }
}

function hideRawError() {
  document.getElementById('rawErrorBanner')?.classList.add('hidden');
}

