import { setStatus, escapeHtml } from '../app.js';

let corruptFilePath = null;
let referenceFilePath = null;
let customOutputDir = null;
let lastRecoveredPath = null;
let isRecovering = false;

export function initScreen() {
  bindEvents();
  setupDragAndDrop();
  setupRecoveryListeners();
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
    }
  } catch (err) {
    console.error('Erro na recuperação:', err);
    showError(err.message || 'Não foi possível concluir a recuperação do vídeo.');
    setStatus('Falha na recuperação.');
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

