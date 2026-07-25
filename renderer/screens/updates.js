import { els, escapeHtml, setStatus } from '../app.js';

export function initScreen() {
  // Vincula o evento de clique ao botão principal de verificação
  els.checkUpdatesButton.addEventListener('click', checkUpdates);

  // Nota: Se quiser que a tela tente procurar atualizações automaticamente 
  // assim que for aberta, pode descomentar a linha abaixo:
  // checkUpdates();
}

/**
 * Solicita ao processo Main a verificação do estado das ferramentas.
 */
async function checkUpdates() {
  // Proteção para garantir que o container existe na tela
  if (!els.updatesList) return;

  els.updatesList.innerHTML = '<p class="loading-text">A verificar atualizações...</p>';
  setStatus('A verificar atualizações das dependências...');

  try {
    const result = await window.bds.checkUpdates();
    renderUpdates(result);
    setStatus('Verificação de atualizações concluída.');
  } catch (error) {
    console.error('Erro ao verificar atualizações:', error);
    els.updatesList.innerHTML = `<p class="error-text">Erro: ${escapeHtml(error.message)}</p>`;
    setStatus('Falha ao verificar atualizações.');
  }
}

/**
 * Renderiza visualmente o estado de cada ferramenta (yt-dlp, FFmpeg, etc).
 * Esta função é exportada caso o app.js precise de a acionar remotamente (ex: no arranque do app).
 */
export function renderUpdates(result) {
  if (!els.updatesList || !result) return;

  // Transforma o objeto de resultado num array filtrando propriedades nulas
  const items = [result.ytDlp, result.ffmpeg].filter(Boolean);

  if (items.length === 0) {
    els.updatesList.innerHTML = '<p>Nenhuma ferramenta configurada para atualização.</p>';
    return;
  }

  // Gera o HTML dinâmico para cada dependência
  els.updatesList.innerHTML = items.map((item) => {
    const isInstalled = item.installed && item.installed !== 'não encontrada';
    const errorMarkup = item.error ? `<p class="tool-error">${escapeHtml(item.error)}</p>` : '';
    
    // Define o texto do botão: se precisa de atualizar ou apenas reinstalar/reparar
    const buttonText = item.needsUpdate ? 'Atualizar' : 'Reinstalar';
    
    return `
      <section class="update-item">
        <div class="tool-info">
          <h3>${escapeHtml(item.tool)}</h3>
          <p>Instalada: <span class="version-tag">${escapeHtml(item.installed || 'não encontrada')}</span></p>
          <p>Mais recente: <span class="version-tag">${escapeHtml(item.latest || 'indisponível')}</span></p>
          ${errorMarkup}
        </div>
        <div class="tool-actions">
          <button class="secondary" data-update-tool="${escapeHtml(item.tool)}" ${item.canUpdate ? '' : 'disabled'}>
            ${buttonText}
          </button>
        </div>
      </section>
    `;
  }).join('');

  // Vincula dinamicamente os eventos de clique para os botões gerados
  els.updatesList.querySelectorAll('[data-update-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      const toolName = button.dataset.updateTool;
      executeToolUpdate(button, toolName);
    });
  });
}

/**
 * Executa a rotina de atualização de uma ferramenta específica.
 */
async function executeToolUpdate(button, toolName) {
  button.disabled = true;
  button.textContent = 'A atualizar...';
  setStatus(`A atualizar ${toolName}, por favor aguarde...`);

  try {
    await window.bds.updateTool(toolName);
    setStatus(`${toolName} atualizado com sucesso!`);
    
    // Refaz a checagem local para atualizar as versões no ecrã
    const freshResult = await window.bds.checkUpdates();
    renderUpdates(freshResult);
  } catch (error) {
    console.error(`Erro ao atualizar a ferramenta ${toolName}:`, error);
    button.textContent = 'Erro';
    setStatus(`Falha ao atualizar ${toolName}: ${error.message}`);
    
    // Reabilita o botão após alguns segundos para permitir nova tentativa em caso de falha de rede
    setTimeout(() => {
      button.disabled = false;
      button.textContent = 'Tentar Novamente';
    }, 3000);
  }
}
