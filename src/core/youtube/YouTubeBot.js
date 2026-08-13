const logger = require('../../../services/logService');
const puppeteer = require('puppeteer-core');
const { BrowserWindow } = require('electron');

class YouTubeBot {
  constructor() {
    this.browser = null;
    this.debugPort = 8315; // A porta exposta no main.js
  }

  /**
   * Conecta o Puppeteer à instância do Electron em execução
   */
  async connect() {
    if (this.browser) return this.browser;
    try {
      const browserURL = `http://localhost:${this.debugPort}`;
      this.browser = await puppeteer.connect({ browserURL });
      return this.browser;
    } catch (e) {
      logger.error('Falha ao conectar Puppeteer. O Electron foi iniciado com a flag --remote-debugging-port?', e);
      throw e;
    }
  }

  /**
   * Ponto de entrada para disparar o upload de um vídeo
   */
  async uploadVideo(videoPath, title, description, isPublic = true) {
    await this.connect();
    
    // 1. Criar uma nova janela visível para a automação
    // Como estamos rodando no processo Node (main), podemos invocar o BrowserWindow nativo
    const uploadWin = new BrowserWindow({
      width: 1024,
      height: 768,
      show: true, // Modo visível (para desenvolvimento)
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:youtube'
      }
    });

    // 2. Navegar para o YouTube Studio
    await uploadWin.loadURL('https://studio.youtube.com');

    // 3. Pegar a página correspondente no Puppeteer
    const targets = await this.browser.targets();
    const target = targets.find(t => t.url().includes('studio.youtube.com'));
    
    if (!target) {
      throw new Error("Não foi possível encontrar a página do YouTube Studio no Puppeteer.");
    }
    
    const page = await target.page();
    
    // (A LÓGICA DE CLICAR E INJETAR)
    try {
      // Tempo extra para garantir que a página carregou
      await page.waitForTimeout(3000); 

      // 1. Clicar no botão 'Criar'
      await page.waitForSelector('#create-icon', { timeout: 15000 });
      await page.click('#create-icon');
      
      // 2. Clicar em 'Enviar vídeo'
      await page.waitForSelector('#text-item-0', { timeout: 5000 });
      await page.click('#text-item-0');
      
      // 3. Aguardar o input de arquivo e enviar o caminho do vídeo
      await page.waitForSelector('input[type="file"][name="Filedata"]', { timeout: 10000 });
      const fileInput = await page.$('input[type="file"][name="Filedata"]');
      await fileInput.uploadFile(videoPath);
      
      // 4. Aguardar a janela de edição de detalhes abrir (TÍTULO e DESCRIÇÃO)
      // O YouTube usa contenteditable divs (#textbox)
      await page.waitForSelector('#textbox', { timeout: 15000 });
      await page.waitForTimeout(2000); // Esperar a animação da janela
      
      const textboxes = await page.$$('#textbox');
      // [0] Título, [1] Descrição
      
      if (title && textboxes.length > 0) {
        // Limpar título atual (Ctrl+A, Delete)
        await textboxes[0].click();
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(title, { delay: 10 });
      }
      
      if (description && textboxes.length > 1) {
        await textboxes[1].click();
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(description, { delay: 5 });
      }

      // 5. Rolar para baixo e marcar "Não é conteúdo para crianças"
      await page.waitForSelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', { timeout: 10000 });
      await page.click('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]');

      // 6. Avançar pelas etapas (Detalhes -> Elementos -> Verificações -> Visibilidade)
      const nextButtonSelector = '#next-button';
      for (let i = 0; i < 3; i++) {
        await page.waitForSelector(nextButtonSelector, { visible: true });
        await page.click(nextButtonSelector);
        await page.waitForTimeout(1000); // Esperar transição
      }

      // 7. Tela de Visibilidade: Selecionar Público ou Privado
      if (isPublic) {
        await page.waitForSelector('tp-yt-paper-radio-button[name="PUBLIC"]', { visible: true });
        await page.click('tp-yt-paper-radio-button[name="PUBLIC"]');
      } else {
        await page.waitForSelector('tp-yt-paper-radio-button[name="PRIVATE"]', { visible: true });
        await page.click('tp-yt-paper-radio-button[name="PRIVATE"]');
      }

      // 8. Clicar em "Salvar/Publicar"
      await page.waitForSelector('#done-button', { visible: true });
      await page.click('#done-button');

      // 9. Esperar o modal de confirmação (pode demorar se o vídeo for pesado)
      // O YouTube mostra um diálogo informando que está processando ou foi concluído
      await page.waitForSelector('ytcp-video-upload-progress', { timeout: 60000 });

      // Opcional: fechar a aba após terminar
      await uploadWin.close();

      return true;
    } catch (err) {
      console.error("Erro na automação do Puppeteer:", err);
      throw err;
    }
  }
}

module.exports = new YouTubeBot();
