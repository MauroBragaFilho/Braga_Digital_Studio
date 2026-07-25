import { escapeHtml } from '../app.js';

let currentView = 'downloads'; // Começa mostrando os downloads

/**
 * Inicializa os eventos da tela de Histórico.
 * Chamada automaticamente pelo orquestrador (app.js) ao carregar esta tela.
 */
export function initScreen() {
  const selectType = document.getElementById('historyTypeSelect');
  const btnClear = document.getElementById('clearHistoryButton');

  // Alterna a visão quando o usuário escolhe no Select
  selectType.addEventListener('change', (e) => {
    currentView = e.target.value;
    toggleTables();
    renderHistory();
  });

  // Vincula o evento de clique ao botão de limpar histórico
  btnClear.addEventListener('click', clearHistory);

  // Prepara e renderiza o estado inicial
  toggleTables();
  renderHistory();
}

/**
 * Controla qual tabela (HTML) fica visível na interface
 */
function toggleTables() {
  const dlTable = document.getElementById('downloadsTable');
  const cvTable = document.getElementById('conversionsTable');
  
  if (currentView === 'downloads') {
    dlTable.style.display = 'table';
    cvTable.style.display = 'none';
  } else {
    dlTable.style.display = 'none';
    cvTable.style.display = 'table';
  }
}

/**
 * Função global que decide qual banco carregar com base na aba ativa.
 */
export async function renderHistory() {
  if (currentView === 'downloads') {
    await renderDownloads();
  } else {
    await renderConversions();
  }
}

/**
 * Renderiza exclusivamente a tabela do banco de DOWNLOADS
 */
async function renderDownloads() {
  const tbody = document.getElementById('historyBody');
  if (!tbody) return;

  try {
    const rows = await window.bmd.listHistory();

    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--muted, #888);">Nenhum download registado.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((row) => {
      const statusClass = row.status ? row.status.toLowerCase() : '';
      return `
        <tr>
          <td><span class="media-title-cell" title="${escapeHtml(row.titulo)}">${escapeHtml(row.titulo)}</span></td>
          <td><span class="badge ${row.tipo.toLowerCase()}">${escapeHtml(row.tipo)}</span></td>
          <td>${escapeHtml(row.resolucao || '--')}</td>
          <td><span class="status-text ${statusClass}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.data_download)}</td>
          <td><span class="path-cell" title="${escapeHtml(row.pasta)}">${escapeHtml(row.pasta)}</span></td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Erro ao renderizar downloads:', error);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: red;">Erro ao carregar os dados do histórico.</td></tr>';
  }
}

/**
 * Renderiza exclusivamente a tabela do banco de CONVERSÕES
 */
async function renderConversions() {
  const tbody = document.getElementById('conversionsBody');
  if (!tbody) return;

  try {
    const rows = await window.bmd.listConversions();

    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--muted, #888);">Nenhuma conversão registada.</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((row) => {
      const statusClass = row.status ? row.status.toLowerCase() : '';
      
      // Extrai apenas o nome do arquivo para não poluir a tabela com caminhos C:\ inteiros
      const getFileName = (fullPath) => fullPath ? fullPath.split(/[\\/]/).pop() : '--';
      const fileOrigem = getFileName(row.arquivo_origem);
      const fileSaida = getFileName(row.arquivo_saida);

      return `
        <tr>
          <td><span class="media-title-cell" title="${escapeHtml(row.arquivo_origem)}">${escapeHtml(fileOrigem)}</span></td>
          <td><span class="media-title-cell" title="${escapeHtml(row.arquivo_saida || '')}">${escapeHtml(fileSaida)}</span></td>
          <td><span class="badge">${escapeHtml(row.formato)} / ${escapeHtml(row.encoder)}</span></td>
          <td><span class="status-text ${statusClass}">${escapeHtml(row.status)}</span></td>
          <td>${escapeHtml(row.data_conversao)}</td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Erro ao renderizar conversões:', error);
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: red;">Erro ao carregar o histórico de conversões.</td></tr>';
  }
}

/**
 * Solicita ao processo Main a limpeza da tabela ATIVA (Downloads ou Conversões).
 */
async function clearHistory() {
  const typeLabel = currentView === 'downloads' ? 'downloads' : 'conversões';
  const confirmar = confirm(`Tens a certeza que desejas limpar todo o histórico de ${typeLabel}?`);
  
  if (!confirmar) return;

  try {
    if (currentView === 'downloads') {
      await window.bmd.clearHistory();
    } else {
      await window.bmd.clearConversions();
    }
    renderHistory(); // Atualiza a tela vazia
  } catch (error) {
    console.error(`Erro ao limpar o histórico de ${typeLabel}:`, error);
    alert(`Não foi possível limpar o histórico de ${typeLabel}.`);
  }
}