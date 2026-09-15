/**
 * PhotoPreview — Visualizador fotográfico profissional para o BDS.
 * Suporta: RAW (CR2, CR3, ARW, NEF, DNG, RAF, ORF, RW2), JPG, PNG, TIFF, WEBP.
 * Não altera arquivos originais.
 */

export class PhotoPreview {
  constructor(options = {}) {
    this.container = options.container || null;
    this.onClose = options.onClose || (() => {});
    this.onNavigate = options.onNavigate || (() => {});

    // Estado interno do viewport
    this.currentMedia = null;
    this.collection = [];
    this.currentIndex = -1;

    // Viewport transforms
    this.scale = 1;
    this.fitScale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.rotation = 0; // 0, 90, 180, 270

    // Painéis opcionais
    this.showFilmstrip = false;
    this.showMetadata = false;
    this.showHistogram = false;
    this.showGrid = false;
    this.isFullscreen = false;

    // Histograma canal ativo: 'rgb', 'r', 'g', 'b'
    this.histChannel = 'rgb';

    // Drag / Pan
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.startTranslateX = 0;
    this.startTranslateY = 0;

    // Inatividade do mouse (auto-hide dos controles)
    this.idleTimer = null;
    this.isIdle = false;

    // Image cache
    this.imageCache = new Map(); // path -> Image

    this._boundKeyHandler = this._handleKeyDown.bind(this);
    this._boundMouseMove = this._handleMouseMove.bind(this);
    this._boundMouseUp = this._handleMouseUp.bind(this);
    this._boundWheel = this._handleWheel.bind(this);
    this._boundResize = this._handleResize.bind(this);
  }

  mount(parentEl) {
    this.parent = parentEl;
    this.render();
    this.bindEvents();
  }

  unmount() {
    this.unbindEvents();
    if (this.dom && this.dom.root) {
      this.dom.root.remove();
    }
  }

  render() {
    const root = document.createElement('div');
    root.className = 'photo-preview-overlay';
    root.innerHTML = `
      <!-- Header -->
      <div class="photo-preview-header" id="photoHeader">
        <div class="photo-header-left">
          <span class="photo-format-badge" id="photoBadge">FORMAT</span>
          <span class="photo-file-title" id="photoTitle" title="">Sem arquivo</span>
          <span class="photo-counter" id="photoCounter">0 / 0</span>
        </div>

        <div class="photo-header-center">
          <button class="photo-tool-btn" id="photoBtnZoomOut" title="Zoom Out (-)">
            <span class="material-symbols-rounded">zoom_out</span>
          </button>
          <span class="photo-zoom-indicator" id="photoZoomIndicator" title="Clique para alternar Fit / 100%">100%</span>
          <button class="photo-tool-btn" id="photoBtnZoomIn" title="Zoom In (+)">
            <span class="material-symbols-rounded">zoom_in</span>
          </button>
          <div class="photo-tool-divider"></div>
          <button class="photo-tool-btn" id="photoBtnFit" title="Ajustar à Tela (0)">
            <span class="material-symbols-rounded">fit_screen</span>
          </button>
          <button class="photo-tool-btn" id="photoBtn100" title="100% Tamanho Real (1)">
            <span class="material-symbols-rounded">density_small</span>
          </button>
          <div class="photo-tool-divider"></div>
          <button class="photo-tool-btn" id="photoBtnRotateCcw" title="Girar 90° Anti-horário">
            <span class="material-symbols-rounded">rotate_left</span>
          </button>
          <button class="photo-tool-btn" id="photoBtnRotateCw" title="Girar 90° Horário (R)">
            <span class="material-symbols-rounded">rotate_right</span>
          </button>
          <div class="photo-tool-divider"></div>
          <button class="photo-tool-btn" id="photoBtnGrid" title="Grade de Composição 3x3 (G)">
            <span class="material-symbols-rounded">grid_3x3</span>
          </button>
          <button class="photo-tool-btn" id="photoBtnHistogram" title="Histograma RGB (H)">
            <span class="material-symbols-rounded">equalizer</span>
          </button>
          <button class="photo-tool-btn" id="photoBtnInfo" title="Informações Técnicas / EXIF (I)">
            <span class="material-symbols-rounded">info</span>
          </button>
          <button class="photo-tool-btn" id="photoBtnFilmstrip" title="Miniaturas / Filmstrip">
            <span class="material-symbols-rounded">view_carousel</span>
          </button>
        </div>

        <div class="photo-header-right">
          <button class="photo-tool-btn" id="photoBtnFullscreen" title="Tela Cheia (F)">
            <span class="material-symbols-rounded" id="photoFsIcon">fullscreen</span>
          </button>
          <button class="photo-close-btn" id="photoBtnClose" title="Fechar Preview (Esc)">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      </div>

      <!-- Main Viewport -->
      <div class="photo-viewport-wrap" id="photoViewportWrap">
        <div class="photo-viewport-container" id="photoViewport">
          <img class="photo-canvas-layer" id="photoImage" draggable="false" alt="" />
        </div>

        <!-- Composition Grid Overlay -->
        <div class="photo-grid-overlay" id="photoGrid">
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
          <div class="photo-grid-cell"></div>
        </div>

        <!-- Navigation Arrows -->
        <button class="photo-nav-arrow prev" id="photoBtnPrev" title="Imagem Anterior (←)">
          <span class="material-symbols-rounded">chevron_left</span>
        </button>
        <button class="photo-nav-arrow next" id="photoBtnNext" title="Próxima Imagem (→)">
          <span class="material-symbols-rounded">chevron_right</span>
        </button>

        <!-- Loading Indicator -->
        <div class="photo-loading-spinner hidden" id="photoLoading">
          <div class="photo-spinner-ring"></div>
          <span class="photo-loading-text" id="photoLoadingText">Carregando imagem...</span>
        </div>

        <!-- Metadata / EXIF Panel -->
        <div class="photo-floating-panel photo-metadata-panel hidden" id="photoMetaPanel">
          <div class="photo-panel-header">
            <span>Metadados / EXIF</span>
            <button class="photo-panel-close" id="photoBtnCloseMeta">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <div class="photo-panel-body" id="photoMetaBody">
            <div style="color: #8e8e93; font-style: italic;">Carregando metadados...</div>
          </div>
        </div>

        <!-- Histograma Panel -->
        <div class="photo-floating-panel photo-histogram-panel hidden" id="photoHistPanel">
          <div class="photo-panel-header">
            <span>Histograma</span>
            <button class="photo-panel-close" id="photoBtnCloseHist">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
          <div style="padding-top: 10px;">
            <div class="photo-hist-channels">
              <button class="photo-hist-btn active" data-channel="rgb">RGB</button>
              <button class="photo-hist-btn" data-channel="r">R</button>
              <button class="photo-hist-btn" data-channel="g">G</button>
              <button class="photo-hist-btn" data-channel="b">B</button>
            </div>
            <canvas class="photo-hist-canvas" id="photoHistCanvas" width="266" height="120"></canvas>
            <div class="photo-hist-clipping">
              <span class="photo-clip-indicator">
                <span class="photo-clip-dot" id="photoClipShadow"></span> Sombras
              </span>
              <span class="photo-clip-indicator">
                <span class="photo-clip-dot" id="photoClipHighlight"></span> Altas Luzes
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Filmstrip Panel (Bottom) -->
      <div class="photo-filmstrip-panel hidden" id="photoFilmstrip"></div>
    `;

    this.parent.appendChild(root);

    // Salva elementos no dom
    this.dom = {
      root,
      header: root.querySelector('#photoHeader'),
      badge: root.querySelector('#photoBadge'),
      title: root.querySelector('#photoTitle'),
      counter: root.querySelector('#photoCounter'),
      viewportWrap: root.querySelector('#photoViewportWrap'),
      viewport: root.querySelector('#photoViewport'),
      image: root.querySelector('#photoImage'),
      grid: root.querySelector('#photoGrid'),
      prevBtn: root.querySelector('#photoBtnPrev'),
      nextBtn: root.querySelector('#photoBtnNext'),
      zoomIndicator: root.querySelector('#photoZoomIndicator'),
      zoomInBtn: root.querySelector('#photoBtnZoomIn'),
      zoomOutBtn: root.querySelector('#photoBtnZoomOut'),
      fitBtn: root.querySelector('#photoBtnFit'),
      btn100: root.querySelector('#photoBtn100'),
      rotateCw: root.querySelector('#photoBtnRotateCw'),
      rotateCcw: root.querySelector('#photoBtnRotateCcw'),
      gridBtn: root.querySelector('#photoBtnGrid'),
      histBtn: root.querySelector('#photoBtnHistogram'),
      infoBtn: root.querySelector('#photoBtnInfo'),
      filmstripBtn: root.querySelector('#photoBtnFilmstrip'),
      fullscreenBtn: root.querySelector('#photoBtnFullscreen'),
      fsIcon: root.querySelector('#photoFsIcon'),
      closeBtn: root.querySelector('#photoBtnClose'),
      loading: root.querySelector('#photoLoading'),
      loadingText: root.querySelector('#photoLoadingText'),
      metaPanel: root.querySelector('#photoMetaPanel'),
      metaBody: root.querySelector('#photoMetaBody'),
      closeMetaBtn: root.querySelector('#photoBtnCloseMeta'),
      histPanel: root.querySelector('#photoHistPanel'),
      closeHistBtn: root.querySelector('#photoBtnCloseHist'),
      histCanvas: root.querySelector('#photoHistCanvas'),
      clipShadow: root.querySelector('#photoClipShadow'),
      clipHighlight: root.querySelector('#photoClipHighlight'),
      filmstrip: root.querySelector('#photoFilmstrip'),
    };
  }

  bindEvents() {
    window.addEventListener('keydown', this._boundKeyHandler);
    window.addEventListener('resize', this._boundResize);

    // Zoom buttons
    this.dom.zoomInBtn.addEventListener('click', () => this.zoomStep(1.25));
    this.dom.zoomOutBtn.addEventListener('click', () => this.zoomStep(0.8));
    this.dom.fitBtn.addEventListener('click', () => this.resetToFit());
    this.dom.btn100.addEventListener('click', () => this.zoomTo(1));
    this.dom.zoomIndicator.addEventListener('click', () => {
      if (Math.abs(this.scale - this.fitScale) < 0.05) this.zoomTo(1);
      else this.resetToFit();
    });

    // Rotation
    this.dom.rotateCw.addEventListener('click', () => this.rotate(90));
    this.dom.rotateCcw.addEventListener('click', () => this.rotate(-90));

    // Panels toggles
    this.dom.gridBtn.addEventListener('click', () => this.toggleGrid());
    this.dom.infoBtn.addEventListener('click', () => this.toggleMetadata());
    this.dom.histBtn.addEventListener('click', () => this.toggleHistogram());
    this.dom.filmstripBtn.addEventListener('click', () => this.toggleFilmstrip());
    this.dom.closeMetaBtn.addEventListener('click', () => this.toggleMetadata(false));
    this.dom.closeHistBtn.addEventListener('click', () => this.toggleHistogram(false));

    // Channels de histograma
    this.dom.histPanel.querySelectorAll('.photo-hist-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.dom.histPanel.querySelectorAll('.photo-hist-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.histChannel = e.target.dataset.channel;
        this.drawHistogram();
      });
    });

    // Fullscreen / Close
    this.dom.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.dom.closeBtn.addEventListener('click', () => this.close());

    // Navigation
    this.dom.prevBtn.addEventListener('click', () => this.prev());
    this.dom.nextBtn.addEventListener('click', () => this.next());

    // Viewport Wheel (Zoom com cursor centrado)
    this.dom.viewportWrap.addEventListener('wheel', this._boundWheel, { passive: false });

    // Drag / Pan
    this.dom.viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Apenas botão esquerdo
      if (this.scale > this.fitScale) {
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.startTranslateX = this.translateX;
        this.startTranslateY = this.translateY;
        this.dom.viewport.classList.add('is-dragging');
      }
    });

    window.addEventListener('mousemove', this._boundMouseMove);
    window.addEventListener('mouseup', this._boundMouseUp);

    // Duplo clique: Fit <-> 100%
    this.dom.viewport.addEventListener('dblclick', (e) => {
      if (Math.abs(this.scale - this.fitScale) < 0.05) {
        // Zoom para 100% focado na coordenada clicada
        const rect = this.dom.viewport.getBoundingClientRect();
        const clickX = e.clientX - rect.left - rect.width / 2;
        const clickY = e.clientY - rect.top - rect.height / 2;
        this.scale = 1;
        this.translateX = -clickX * (1 / this.fitScale - 1);
        this.translateY = -clickY * (1 / this.fitScale - 1);
        this.applyTransform();
      } else {
        this.resetToFit();
      }
    });

    // Reset idle timer on mouse activity
    this.dom.root.addEventListener('mousemove', () => this._resetIdleTimer());
    this._resetIdleTimer();
  }

  unbindEvents() {
    window.removeEventListener('keydown', this._boundKeyHandler);
    window.removeEventListener('resize', this._boundResize);
    window.removeEventListener('mousemove', this._boundMouseMove);
    window.removeEventListener('mouseup', this._boundMouseUp);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  _resetIdleTimer() {
    if (this.isIdle) {
      this.isIdle = false;
      this.dom.header.classList.remove('idle-hidden');
      this.dom.prevBtn.classList.remove('idle-hidden');
      this.dom.nextBtn.classList.remove('idle-hidden');
      this.dom.filmstrip.classList.remove('idle-hidden');
      this.dom.viewport.style.cursor = '';
    }

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Esconde controles se não estiver arrastando ou com painéis abertos
      if (!this.isDragging && !this.showMetadata && !this.showHistogram) {
        this.isIdle = true;
        this.dom.header.classList.add('idle-hidden');
        this.dom.prevBtn.classList.add('idle-hidden');
        this.dom.nextBtn.classList.add('idle-hidden');
        this.dom.filmstrip.classList.add('idle-hidden');
        this.dom.viewport.style.cursor = 'none';
      }
    }, 2800);
  }

  _handleWheel(e) {
    e.preventDefault();
    this._resetIdleTimer();

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const oldScale = this.scale;
    let newScale = oldScale * zoomFactor;

    // Limites de zoom (25% a 800%)
    newScale = Math.max(0.1, Math.min(8.0, newScale));

    // Manter o ponto sob o cursor
    const rect = this.dom.viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    this.translateX = mouseX - (mouseX - this.translateX) * (newScale / oldScale);
    this.translateY = mouseY - (mouseY - this.translateY) * (newScale / oldScale);
    this.scale = newScale;

    this.applyTransform();
  }

  _handleMouseMove(e) {
    if (this.isDragging) {
      this.translateX = this.startTranslateX + (e.clientX - this.dragStartX);
      this.translateY = this.startTranslateY + (e.clientY - this.dragStartY);
      this.applyTransform();
    }
  }

  _handleMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      this.dom.viewport.classList.remove('is-dragging');
    }
  }

  _handleResize() {
    if (this.dom.image.naturalWidth) {
      this._calculateFitScale();
      if (Math.abs(this.scale - this.fitScale) < 0.05) {
        this.resetToFit();
      }
    }
  }

  _handleKeyDown(e) {
    // Não interceptar se o usuário estiver digitando em input
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.prev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.next();
        break;
      case 'Home':
        e.preventDefault();
        this.goToIndex(0);
        break;
      case 'End':
        e.preventDefault();
        this.goToIndex(this.collection.length - 1);
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomStep(1.25);
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomStep(0.8);
        break;
      case '0':
        e.preventDefault();
        this.resetToFit();
        break;
      case '1':
        e.preventDefault();
        this.zoomTo(1.0);
        break;
      case '2':
        e.preventDefault();
        this.zoomTo(2.0);
        break;
      case 'i':
      case 'I':
        e.preventDefault();
        this.toggleMetadata();
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        this.toggleHistogram();
        break;
      case 'g':
      case 'G':
        e.preventDefault();
        this.toggleGrid();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        this.rotate(90);
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        this.toggleFullscreen();
        break;
      case 'Escape':
        e.preventDefault();
        if (this.isFullscreen) {
          this.toggleFullscreen(false);
        } else {
          this.close();
        }
        break;
    }
  }

  /**
   * Abre a mídia especificada dentro do contexto de uma coleção opcional.
   */
  async open(media, collection = []) {
    this.collection = Array.isArray(collection) && collection.length > 0 ? collection : [media];
    
    // Normalizar objeto de mídia
    const targetPath = typeof media === 'string' ? media : (media.filepath || media.path || '');
    this.currentIndex = this.collection.findIndex(m => {
      const p = typeof m === 'string' ? m : (m.filepath || m.path || '');
      return p === targetPath;
    });
    if (this.currentIndex === -1) this.currentIndex = 0;

    this.showFilmstrip = false;
    this.dom.filmstrip.classList.add('hidden');
    this.dom.filmstripBtn.classList.remove('active');

    await this.loadMedia(this.collection[this.currentIndex]);
    this.buildFilmstrip();
  }

  async loadMedia(media) {
    if (!media) return;
    this.currentMedia = media;

    const filePath = typeof media === 'string' ? media : (media.filepath || media.path);
    const fileName = typeof media === 'string' ? filePath.split(/[/\\]/).pop() : (media.filename || filePath.split(/[/\\]/).pop());

    this.dom.title.textContent = fileName;
    this.dom.title.title = filePath;
    this.dom.counter.textContent = `${this.currentIndex + 1} / ${this.collection.length}`;

    // Detectar RAW pelo nome
    const isRaw = !!filePath.match(/\.(cr2|cr3|arw|nef|dng|raf|orf|rw2|pef|srw)$/i);
    const ext = (filePath.split('.').pop() || '').toUpperCase();
    
    this.dom.badge.textContent = isRaw ? 'RAW' : ext;
    this.dom.badge.className = `photo-format-badge ${isRaw ? 'badge-raw' : ''}`;

    // Reset de rotação e carregamento da imagem
    this.rotation = 0;
    this.showLoading(true, 'Carregando...');

    try {
      let renderSrc = null;

      // 1. Tenta obter caminho renderizável do backend
      if (window.bds && window.bds.photoGetRenderablePath) {
        const res = await window.bds.photoGetRenderablePath(filePath);
        renderSrc = 'file:///' + res.renderablePath.replace(/\\/g, '/');
      } else {
        renderSrc = 'file:///' + filePath.replace(/\\/g, '/');
      }

      await this._setImageSrc(renderSrc);
      this.showLoading(false);

      // Carregar metadados se o painel estiver aberto
      if (this.showMetadata) {
        this.fetchAndRenderMetadata();
      }

      // Calcular histograma se o painel estiver aberto
      if (this.showHistogram) {
        this.drawHistogram();
      }

      // Prefetch de imagens vizinhas (anterior e próxima)
      this.prefetchNeighbors();

      // Destaque no filmstrip
      this.updateFilmstripActive();
    } catch (err) {
      console.error('[PhotoPreview] Erro ao carregar imagem:', err);
      this.showLoading(false);
      this.dom.title.textContent = `${fileName} (Erro na decodificação)`;
    }
  }

  _setImageSrc(src) {
    return new Promise((resolve, reject) => {
      const img = this.dom.image;
      img.onload = () => {
        this._calculateFitScale();
        this.resetToFit();
        resolve();
      };
      img.onerror = (e) => reject(e);
      img.src = src;
    });
  }

  _calculateFitScale() {
    const wrap = this.dom.viewportWrap;
    const img = this.dom.image;
    if (!wrap || !img.naturalWidth) return;

    // Dimensões do wrap considerando rotação
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;

    const isFlipped = this.rotation === 90 || this.rotation === 270;
    const imgW = isFlipped ? img.naturalHeight : img.naturalWidth;
    const imgH = isFlipped ? img.naturalWidth : img.naturalHeight;

    const scaleX = (wrapW * 0.96) / imgW;
    const scaleY = (wrapH * 0.96) / imgH;

    this.fitScale = Math.min(scaleX, scaleY, 1.0); // Fit nunca estoura 100% na tela vazia se for menor
  }

  resetToFit() {
    this._calculateFitScale();
    this.scale = this.fitScale;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  zoomTo(targetScale) {
    this.scale = targetScale;
    this.applyTransform();
  }

  zoomStep(multiplier) {
    this.scale = Math.max(0.1, Math.min(8.0, this.scale * multiplier));
    this.applyTransform();
  }

  rotate(deltaDeg) {
    this.rotation = (this.rotation + deltaDeg + 360) % 360;
    this._calculateFitScale();
    this.applyTransform();
  }

  applyTransform() {
    const img = this.dom.image;
    if (!img) return;

    img.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;

    // Atualiza classe de drag no viewport
    if (this.scale > this.fitScale) {
      this.dom.viewport.classList.add('can-drag');
    } else {
      this.dom.viewport.classList.remove('can-drag');
    }

    // Indicador numérico
    const pct = Math.round(this.scale * 100);
    this.dom.zoomIndicator.textContent = `${pct}%`;
  }

  prev() {
    if (this.collection.length <= 1) return;
    this.currentIndex = (this.currentIndex - 1 + this.collection.length) % this.collection.length;
    this.loadMedia(this.collection[this.currentIndex]);
    if (this.onNavigate) this.onNavigate(this.collection[this.currentIndex], this.currentIndex);
  }

  next() {
    if (this.collection.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.collection.length;
    this.loadMedia(this.collection[this.currentIndex]);
    if (this.onNavigate) this.onNavigate(this.collection[this.currentIndex], this.currentIndex);
  }

  goToIndex(idx) {
    if (idx < 0 || idx >= this.collection.length || idx === this.currentIndex) return;
    this.currentIndex = idx;
    this.loadMedia(this.collection[this.currentIndex]);
    if (this.onNavigate) this.onNavigate(this.collection[this.currentIndex], this.currentIndex);
  }

  prefetchNeighbors() {
    const neighbors = [];
    if (this.currentIndex > 0) neighbors.push(this.collection[this.currentIndex - 1]);
    if (this.currentIndex < this.collection.length - 1) neighbors.push(this.collection[this.currentIndex + 1]);

    neighbors.forEach(item => {
      const p = typeof item === 'string' ? item : (item.filepath || item.path);
      if (!p || this.imageCache.has(p)) return;

      const isRaw = !!p.match(/\.(cr2|cr3|arw|nef|dng|raf|orf|rw2)$/i);
      if (!isRaw) {
        const preImg = new Image();
        preImg.src = 'file:///' + p.replace(/\\/g, '/');
        this.imageCache.set(p, preImg);
      } else if (window.bds && window.bds.photoGetRenderablePath) {
        // Pré-gera o cache em background para o RAW vizinho
        window.bds.photoGetRenderablePath(p).then(res => {
          const preImg = new Image();
          preImg.src = 'file:///' + res.renderablePath.replace(/\\/g, '/');
          this.imageCache.set(p, preImg);
        }).catch(() => {});
      }
    });
  }

  // --- Filmstrip ---
  async buildFilmstrip() {
    const fs = this.dom.filmstrip;
    fs.innerHTML = '';

    // Diretorio de thumbnails do BDS (cacheado apos a 1a chamada)
    let thumbsBase = this._thumbsBase;
    if (!thumbsBase && window.bds && typeof window.bds.getThumbDir === 'function') {
      try {
        const rawDir = await window.bds.getThumbDir();
        thumbsBase = 'file:///' + String(rawDir).replace(/\\/g, '/');
        this._thumbsBase = thumbsBase;
      } catch (_) {
        thumbsBase = '';
      }
    }

    this.collection.forEach((item, index) => {
      const p = typeof item === 'string' ? item : (item.filepath || item.path);
      const name = typeof item === 'string' ? p.split(/[/\\]/).pop() : (item.filename || p.split(/[/\\]/).pop());
      
      const thumbEl = document.createElement('div');
      thumbEl.className = `photo-filmstrip-item ${index === this.currentIndex ? 'active' : ''}`;
      thumbEl.dataset.index = index;
      thumbEl.title = name;

      const img = document.createElement('img');
      img.loading = 'lazy';
      // Se tiver thumbnail pré-computado na mídia (da biblioteca)
      if (item.thumbnail && typeof item.thumbnail === 'string') {
        if (item.thumbnail.startsWith('file:') || item.thumbnail.startsWith('http') || item.thumbnail.startsWith('/')) {
          img.src = item.thumbnail;
        } else if (thumbsBase) {
          img.src = `${thumbsBase}/${item.thumbnail}`;
        }
      }

      // Fallback: caminho renderizavel (RAW sem thumbnail / fontes externas)
      if (!img.src) {
        if (window.bds && window.bds.photoGetRenderablePath) {
          window.bds.photoGetRenderablePath(p).then(res => {
            if (res && res.renderablePath) {
              img.src = 'file:///' + String(res.renderablePath).replace(/\\/g, '/');
            }
          }).catch(() => {});
        } else {
          img.src = 'file:///' + p.replace(/\\/g, '/');
        }
      }

      thumbEl.appendChild(img);
      thumbEl.addEventListener('click', () => this.goToIndex(index));
      fs.appendChild(thumbEl);
    });
  }

  updateFilmstripActive() {
    const items = this.dom.filmstrip.querySelectorAll('.photo-filmstrip-item');
    items.forEach((it, idx) => {
      const isActive = idx === this.currentIndex;
      it.classList.toggle('active', isActive);
      if (isActive) {
        it.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });
  }

  toggleFilmstrip(forceState) {
    this.showFilmstrip = typeof forceState === 'boolean' ? forceState : !this.showFilmstrip;
    this.dom.filmstrip.classList.toggle('hidden', !this.showFilmstrip);
    this.dom.filmstripBtn.classList.toggle('active', this.showFilmstrip);
    setTimeout(() => this._handleResize(), 150);
  }

  // --- Painel EXIF / Metadados ---
  toggleMetadata(forceState) {
    this.showMetadata = typeof forceState === 'boolean' ? forceState : !this.showMetadata;
    this.dom.metaPanel.classList.toggle('hidden', !this.showMetadata);
    this.dom.infoBtn.classList.toggle('active', this.showMetadata);
    if (this.showMetadata) {
      this.fetchAndRenderMetadata();
    }
  }

  async fetchAndRenderMetadata() {
    if (!this.currentMedia) return;
    const filePath = typeof this.currentMedia === 'string' ? this.currentMedia : (this.currentMedia.filepath || this.currentMedia.path);
    const body = this.dom.metaBody;
    body.innerHTML = '<div style="color: #8e8e93; font-style: italic;">Carregando metadados...</div>';

    try {
      if (!window.bds || !window.bds.photoGetMetadata) {
        body.innerHTML = '<div style="color: #8e8e93;">Metadados não disponíveis.</div>';
        return;
      }

      const meta = await window.bds.photoGetMetadata(filePath);
      let html = '';

      const renderSection = (title, entries) => {
        const valid = entries.filter(e => e.val !== null && e.val !== undefined && e.val !== '');
        if (valid.length === 0) return '';
        return `
          <div class="photo-meta-section">
            <span class="photo-meta-sec-title">${title}</span>
            ${valid.map(e => `
              <div class="photo-meta-row">
                <span class="photo-meta-label">${e.label}</span>
                <span class="photo-meta-value">${e.val}</span>
              </div>
            `).join('')}
          </div>
        `;
      };

      // 1. Arquivo
      html += renderSection('Arquivo', [
        { label: 'Nome', val: meta.file?.name },
        { label: 'Formato', val: meta.file?.format },
        { label: 'Tamanho', val: this._formatBytes(meta.file?.sizeBytes) },
        { label: 'Software', val: meta.file?.software }
      ]);

      // 2. Câmera
      html += renderSection('Câmera', [
        { label: 'Fabricante', val: meta.camera?.make },
        { label: 'Modelo', val: meta.camera?.model },
        { label: 'Lente', val: meta.camera?.lens }
      ]);

      // 3. Captura
      html += renderSection('Captura', [
        { label: 'Distância Focal', val: meta.capture?.focalLength ? `${meta.capture.focalLength}mm` : null },
        { label: 'Abertura', val: meta.capture?.aperture },
        { label: 'Velocidade', val: meta.capture?.shutterSpeed },
        { label: 'ISO', val: meta.capture?.iso ? `ISO ${meta.capture.iso}` : null },
        { label: 'Data/Hora', val: meta.capture?.dateTime }
      ]);

      // 4. Imagem
      html += renderSection('Imagem', [
        { label: 'Dimensões', val: meta.image?.width && meta.image?.height ? `${meta.image.width} × ${meta.image.height}` : null },
        { label: 'Espaço de Cor', val: meta.image?.colorSpace },
        { label: 'Profundidade', val: meta.image?.bitDepth ? `${meta.image.bitDepth} bits` : null }
      ]);

      // 5. Localização
      if (meta.location) {
        html += renderSection('Localização', [
          { label: 'Latitude', val: meta.location.latitude },
          { label: 'Longitude', val: meta.location.longitude }
        ]);
      }

      body.innerHTML = html || '<div style="color: #8e8e93;">Nenhum metadado EXIF detalhado encontrado.</div>';
    } catch (err) {
      body.innerHTML = `<div style="color: #ef4444;">Erro ao extrair metadados: ${err.message}</div>`;
    }
  }

  // --- Histograma ---
  toggleHistogram(forceState) {
    this.showHistogram = typeof forceState === 'boolean' ? forceState : !this.showHistogram;
    this.dom.histPanel.classList.toggle('hidden', !this.showHistogram);
    this.dom.histBtn.classList.toggle('active', this.showHistogram);
    if (this.showHistogram) {
      this.drawHistogram();
    }
  }

  drawHistogram() {
    const canvas = this.dom.histCanvas;
    const img = this.dom.image;
    if (!canvas || !img || !img.naturalWidth) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Amostragem eficiente da imagem em canvas offscreen reduzido (180x120)
    const offCanvas = document.createElement('canvas');
    const sampleW = 180;
    const sampleH = 120;
    offCanvas.width = sampleW;
    offCanvas.height = sampleH;
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    
    try {
      offCtx.drawImage(img, 0, 0, sampleW, sampleH);
      const imgData = offCtx.getImageData(0, 0, sampleW, sampleH).data;

      const rBins = new Array(256).fill(0);
      const gBins = new Array(256).fill(0);
      const bBins = new Array(256).fill(0);

      let shadowClipped = false;
      let highlightClipped = false;

      for (let i = 0; i < imgData.length; i += 4) {
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        rBins[r]++;
        gBins[g]++;
        bBins[b]++;

        if (r === 0 && g === 0 && b === 0) shadowClipped = true;
        if (r === 255 && g === 255 && b === 255) highlightClipped = true;
      }

      // Detecção de clipping
      this.dom.clipShadow.classList.toggle('clipped-shadow', shadowClipped);
      this.dom.clipHighlight.classList.toggle('clipped-highlight', highlightClipped);

      // Max bin para escala vertical (ignora o pico extremo de 0 e 255 para curva suave)
      let maxVal = 1;
      for (let i = 1; i < 255; i++) {
        if (rBins[i] > maxVal) maxVal = rBins[i];
        if (gBins[i] > maxVal) maxVal = gBins[i];
        if (bBins[i] > maxVal) maxVal = bBins[i];
      }

      // Desenhar curva do canal selecionado
      const drawChannelCurve = (bins, color, fillStyle) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x < 256; x++) {
          const binVal = Math.min(bins[x], maxVal * 1.5);
          const y = h - (binVal / maxVal) * (h * 0.9);
          const plotX = (x / 255) * w;
          ctx.lineTo(plotX, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      };

      ctx.globalCompositeOperation = 'screen';

      if (this.histChannel === 'rgb' || this.histChannel === 'r') {
        drawChannelCurve(rBins, 'rgba(239, 68, 68, 0.9)', 'rgba(239, 68, 68, 0.25)');
      }
      if (this.histChannel === 'rgb' || this.histChannel === 'g') {
        drawChannelCurve(gBins, 'rgba(34, 197, 94, 0.9)', 'rgba(34, 197, 94, 0.25)');
      }
      if (this.histChannel === 'rgb' || this.histChannel === 'b') {
        drawChannelCurve(bBins, 'rgba(59, 130, 246, 0.9)', 'rgba(59, 130, 246, 0.25)');
      }

      ctx.globalCompositeOperation = 'source-over';
    } catch (e) {
      // CORS ou problema de leitura
      ctx.fillStyle = '#71717a';
      ctx.font = '11px sans-serif';
      ctx.fillText('Histograma indisponível', 10, h / 2);
    }
  }

  // --- Grid 3x3 ---
  toggleGrid(forceState) {
    this.showGrid = typeof forceState === 'boolean' ? forceState : !this.showGrid;
    this.dom.grid.classList.toggle('active', this.showGrid);
    this.dom.gridBtn.classList.toggle('active', this.showGrid);
  }

  // --- Fullscreen ---
  toggleFullscreen(forceState) {
    const shouldFs = typeof forceState === 'boolean' ? forceState : !document.fullscreenElement;
    if (shouldFs) {
      if (this.dom.root.requestFullscreen) {
        this.dom.root.requestFullscreen().then(() => {
          this.isFullscreen = true;
          this.dom.fsIcon.textContent = 'fullscreen_exit';
        }).catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen().then(() => {
          this.isFullscreen = false;
          this.dom.fsIcon.textContent = 'fullscreen';
        }).catch(() => {});
      }
    }
  }

  showLoading(show, text = 'Carregando...') {
    this.dom.loading.classList.toggle('hidden', !show);
    this.dom.loadingText.textContent = text;
  }

  _formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes;
    let u = 0;
    while (val >= 1024 && u < units.length - 1) {
      val /= 1024;
      u++;
    }
    return `${val.toFixed(1)} ${units[u]}`;
  }

  close() {
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (_) {}
    }
    this.dom.image.src = '';
    this.dom.root.classList.add('hidden');
    if (this.onClose) this.onClose();
  }
}
