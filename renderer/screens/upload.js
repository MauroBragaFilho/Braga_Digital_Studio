export async function initScreen() {
    console.log('[UPLOAD] Inicializando tela do YouTube Studio...');

    const webview = document.getElementById('youtubeStudioWebview');

    if (webview) {
        // Auto-sincronizar cookies ao terminar de carregar uma página no studio.youtube.com
        webview.addEventListener('did-finish-load', () => {
            syncCookiesForYtDlp();
        });

        // Backup: garante a tentativa de sincronização ao abrir a tela, mesmo se o webview já estiver em cache
        webview.addEventListener('dom-ready', () => {
            syncCookiesForYtDlp();
        });
    }
}

async function syncCookiesForYtDlp() {
    const statusBar = document.getElementById('cookiesSyncStatusBar');
    const statusText = document.getElementById('cookiesSyncStatusText');

    try {
        if (window.bds && window.bds.exportYoutubeCookies) {
            const result = await window.bds.exportYoutubeCookies();

            if (result && result.success) {
                if (statusBar && statusText) {
                    statusText.textContent = '✓ Cookies sincronizados com sucesso. yt-dlp autenticado.';
                    statusBar.classList.add('active');
                    // Auto-hide após 5 segundos
                    setTimeout(() => statusBar.classList.remove('active'), 5000);
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