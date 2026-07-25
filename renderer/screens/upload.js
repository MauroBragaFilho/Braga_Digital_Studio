export function initScreen() {
    console.log('Tela de Envio Manual (YouTube Studio) carregada.');
    
    // Podemos adicionar lógica extra aqui se necessário, como injetar CSS no webview.
    const webview = document.getElementById('youtubeStudioView');
    if (webview) {
        webview.addEventListener('dom-ready', () => {
            // Opcional: injetar um pequeno estilo para esconder barras desnecessárias se quiser
            // webview.insertCSS('...');
        });
    }
}
