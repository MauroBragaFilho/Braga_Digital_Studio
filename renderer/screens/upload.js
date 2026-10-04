let statusTimer = null;

export function onLeave() {
    clearTimeout(statusTimer);
    statusTimer = null;
}

export async function initScreen() {
    console.log('[UPLOAD] Inicializando tela do YouTube Studio...');

    const webview = document.getElementById('youtubeStudioWebview');

    const overlay = document.getElementById('uploadOverlay');
    const setOverlay = (state, title, text) => {
        if (!overlay) return;
        overlay.classList.toggle('visible', state !== 'hidden');
        overlay.classList.toggle('is-error', state === 'error');
        document.getElementById('btnUploadRetry')?.classList.toggle('hidden', state !== 'error');
        if (title) document.getElementById('uploadOverlayTitle').textContent = title;
        if (text) document.getElementById('uploadOverlayText').textContent = text;
    };
    document.getElementById('btnUploadRetry')?.addEventListener('click', () => {
        setOverlay('loading', 'Carregando o YouTube Studio…', 'Se demorar, verifique sua conexão com a internet.');
        try { webview?.reload(); } catch (_) { try { webview.src = 'https://studio.youtube.com'; } catch (__) { /* sem webview */ } }
    });

    if (webview) {
        webview.addEventListener('did-start-loading', () => setOverlay('loading', 'Carregando o YouTube Studio…', 'Se demorar, verifique sua conexão com a internet.'));
        webview.addEventListener('did-stop-loading', () => setOverlay('hidden'));
        webview.addEventListener('did-fail-load', (e) => {
            // -3 = carregamento interrompido por uma nova navegação (não é erro); só importa a página principal
            if (e && (e.errorCode === -3 || e.isMainFrame === false)) return;
            setOverlay('error', 'Não foi possível abrir o YouTube Studio', 'Verifique sua conexão com a internet e tente novamente.');
        });
        // Auto-sincronizar cookies ao terminar de carregar uma página no studio.youtube.com
        webview.addEventListener('did-finish-load', () => {
            syncYoutubeSession();
        });

        // Backup: garante a tentativa de sincronização ao abrir a tela, mesmo se o webview já estiver em cache
        webview.addEventListener('dom-ready', () => {
            syncYoutubeSession();
        });
    }
}

async function syncYoutubeSession() {
    const statusBar = document.getElementById('cookiesSyncStatusBar');
    const statusText = document.getElementById('cookiesSyncStatusText');

    try {
        if (window.bds && window.bds.exportYoutubeCookies) {
            const result = await window.bds.exportYoutubeCookies();

            if (result && result.success) {
                if (statusBar && statusText) {
                    statusText.textContent = '✓ Sessão do YouTube conectada. Seus downloads agora podem usar a sua conta.';
                    statusBar.classList.add('active');
                    // Auto-hide após 5 segundos
                    clearTimeout(statusTimer);
                    statusTimer = setTimeout(() => statusBar.classList.remove('active'), 5000);
                }
                console.log('[UPLOAD] Cookies sincronizados com sucesso.');
            } else {
                // Silencioso: usuário sem conta conectada não vê nenhuma mensagem de erro
                console.log('[UPLOAD] Auto-sync: nenhum cookie ativo encontrado (usuário não logado).');
            }
        }
    } catch (err) {
        // Silencioso: erros ficam apenas no console, sem poluir a tela
        console.error('[UPLOAD] Erro ao sincronizar cookies:', err);
    }
}