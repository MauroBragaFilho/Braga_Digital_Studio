'use strict';

/**
 * Seletores da página do YouTube Studio usados pelo envio automático (YoutubeStudioDriver).
 *
 * O Studio muda sem aviso: quando o envio automático parar de achar um elemento, o ajuste é SÓ aqui.
 * Cada chave aceita uma lista de seletores CSS; o driver usa o primeiro que existir na página.
 * Textos (regex) são usados para reconhecer estados do diálogo em qualquer idioma da interface.
 */
const STUDIO_SELECTORS = Object.freeze({
  // Botão "Criar" (canto superior direito) e o item "Enviar vídeos" do menu que ele abre
  createButton: ['ytcp-button#create-icon', '#create-icon', 'ytcp-button[aria-label*="Criar"]', 'ytcp-button[aria-label*="Create"]'],
  uploadMenuItem: ['tp-yt-paper-item#text-item-0', '#text-item-0', 'tp-yt-paper-item[test-id="upload-beta"]'],

  // Diálogo de envio e o seletor de arquivo
  uploadDialog: ['ytcp-uploads-dialog'],
  fileInput: ['ytcp-uploads-dialog input[type="file"]', 'ytcp-uploads-file-picker input[type="file"]', 'input[type="file"]'],

  // Detalhes. Um seletor pode terminar em "@@n" = n-ésimo elemento que casa (querySelectorAll)[n]: no Studio o título é
  // o primeiro #textbox do diálogo e a descrição o segundo, quando os ids dos contêineres não existem.
  titleBox: [
    'ytcp-uploads-dialog #title-textbox #textbox', 'ytcp-uploads-dialog ytcp-social-suggestions-textbox#title-textbox #textbox',
    'ytcp-uploads-dialog #title-textbox [contenteditable]', 'ytcp-video-metadata-editor #title-textbox #textbox',
    'ytcp-uploads-dialog #textbox@@0', 'ytcp-video-metadata-editor #textbox@@0', '#textbox@@0'
  ],
  descriptionBox: [
    'ytcp-uploads-dialog #description-textbox #textbox', 'ytcp-uploads-dialog #description-textbox [contenteditable]',
    'ytcp-video-metadata-editor #description-textbox #textbox',
    'ytcp-uploads-dialog #textbox@@1', 'ytcp-video-metadata-editor #textbox@@1', '#textbox@@1'
  ],
  // Miniatura (campo de arquivo do editor de miniaturas, na etapa Detalhes)
  thumbnailInput: [
    'ytcp-uploads-dialog ytcp-thumbnails-compact-editor-uploader input#file-loader', 'ytcp-uploads-dialog ytcp-thumbnails-compact-editor-uploader input[type="file"]',
    'ytcp-uploads-dialog ytcp-thumbnail-uploader input[type="file"]', 'ytcp-uploads-dialog #file-loader', 'ytcp-uploads-dialog input#file-loader[type="file"]'
  ],
  // Playlist: gatilho do menu, diálogo com a lista (cada item tem um rótulo com o nome) e botão Concluído
  playlistTrigger: [
    'ytcp-uploads-dialog ytcp-video-metadata-playlists ytcp-text-dropdown-trigger', 'ytcp-uploads-dialog ytcp-video-metadata-playlists ytcp-dropdown-trigger',
    'ytcp-video-metadata-playlists #dropdown-trigger', 'ytcp-video-metadata-playlists ytcp-dropdown-trigger'
  ],
  playlistDialog: ['ytcp-playlist-dialog'],
  playlistItems: [
    'ytcp-playlist-dialog ytcp-checkbox-group li', 'ytcp-playlist-dialog li.ytcp-checkbox-group', 'ytcp-playlist-dialog ytcp-checkbox-lit',
    'ytcp-playlist-dialog tp-yt-paper-checkbox', 'ytcp-playlist-dialog [role="checkbox"]'
  ],
  playlistItemLabel: ['.label', 'span.checkbox-label', '#checkbox-label', '.checkbox-label'],
  playlistDone: ['ytcp-playlist-dialog .done-button', 'ytcp-playlist-dialog ytcp-button.done-button', 'ytcp-playlist-dialog #done-button'],
  playlistCancel: ['ytcp-playlist-dialog .cancel-button', 'ytcp-playlist-dialog ytcp-button.cancel-button'],
  notMadeForKids: ['ytcp-uploads-dialog tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]', 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'],

  // Navegação do diálogo
  nextButton: ['ytcp-uploads-dialog #next-button', '#next-button'],
  doneButton: ['ytcp-uploads-dialog #done-button', '#done-button'],
  closeButton: ['ytcp-uploads-dialog #close-button', 'ytcp-uploads-still-processing-dialog #close-button'],
  stillProcessingDialog: ['ytcp-uploads-still-processing-dialog'],

  // Visibilidade (última etapa)
  visibility: {
    private: ['tp-yt-paper-radio-button[name="PRIVATE"]'],
    unlisted: ['tp-yt-paper-radio-button[name="UNLISTED"]'],
    public: ['tp-yt-paper-radio-button[name="PUBLIC"]']
  },

  // Progresso ("Enviando 43%…", "Upload concluído", "Verificações concluídas") e erros do diálogo
  progressLabel: ['ytcp-uploads-dialog .progress-label', 'ytcp-uploads-dialog span.progress-label', 'ytcp-video-upload-progress .progress-label'],
  errorLabel: ['ytcp-uploads-dialog .error-short', 'ytcp-uploads-dialog #error-message', 'ytcp-uploads-dialog ytcp-uploads-error'],
  videoLink: ['ytcp-uploads-dialog ytcp-video-info a.ytcp-video-info', 'ytcp-uploads-dialog a[href*="youtu.be/"]', 'ytcp-uploads-dialog a[href*="youtube.com/watch"]'],

  // Página de login/verificação do Google (fora do Studio) — pede atenção do usuário
  attentionHosts: ['accounts.google.com', 'myaccount.google.com'],
  attentionText: /confirme que (é|e) voc(ê|e)|verify it'?s you|verifique sua identidade|verify your identity|digite sua senha|enter your password|c[óo]digo de verifica|verification code|2-step|duas etapas/i,
  limitText: /limite di[áa]rio|daily (upload )?limit|limit(e)? de (envios|uploads)|reached your (daily )?limit/i
});

/** Regex que reconhece a porcentagem do envio no rótulo de progresso ("Enviando 43%", "43% uploaded"). */
const PERCENT_RE = /(\d{1,3})\s*%/;
/** Rótulo que indica que o upload do arquivo em si terminou (o YouTube pode seguir processando). */
const UPLOADED_RE = /conclu[íi]d|complete|processando|processing|verifica|check/i;

module.exports = { STUDIO_SELECTORS, PERCENT_RE, UPLOADED_RE };
