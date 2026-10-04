/**
 * VideoPreview — Visualizador de vídeo profissional para o BDS.
 * Dark, minimalista, cinematográfico, video-first.
 * Painel de áudio expansível com waveforms reais por track.
 */
import { WaveformRenderer } from './WaveformRenderer.js';

import { escapeHtml as _e } from '../../utils/escape.js';
import { toFileUrl } from '../../utils/fileUrl.js';
const _fps = r => { const [n,d]=String(r||'').split('/').map(Number); const v=d?n/d:n; return v>0&&isFinite(v)?String(Math.round(v*100)/100):''; };
const _sz = b => b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB';
const _t = s => { if(!s||isNaN(s))return'00:00'; return String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0'); };
const _f = fp => toFileUrl(fp);
const _u = (m,fp) => { if(m&&m.uuid)return m.uuid; let h=0; const s=String(fp||'').toLowerCase(); for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;} return 'v_'+Math.abs(h).toString(36); };

export class VideoPreview {
  constructor(opts={}) {
    this.onClose=opts.onClose||(()=>{}); this.dom={};
    this.media=null; this.collection=[]; this.ci=-1; this.duration=0;
    this.aStreams=[]; this.tRenderers=[]; this.tPlayheads=[];
    this.tAudioEls=[]; this.tMuted=[]; this.isAudOpen=false; this.isInfoOpen=false;
    this.isScrub=false; this._raf=null; this._idleT=null;
    this._kb=this._handleKey.bind(this);
    this._mmh=this._handleMouseMove.bind(this);
    this._muh=this._handleMouseUp.bind(this);
    this._fsh=this._onFsChange.bind(this);
  }
  mount(el){ this.parent=el; this._init(); this._bind(); }
  unmount(){ this._unbind(); this.dom.root?.remove(); }
  open(media,coll=[],opts={}) {
    this._autoplay=!!opts.autoplay;
    this.media=media; this.collection=coll.length?coll:[media];
    this.ci=this.collection.findIndex(m=>(m.filepath||m.path)===(media.filepath||media.path));
    if(this.ci<0)this.ci=0;
    this._load(this.collection[this.ci]);
    this.dom.root.classList.remove('hidden');
  }
  close(){ this._stopAll(); this.dom.root?.classList.add('hidden'); this.onClose(); }

  // ── Bind / Unbind ──
  _bind() {
    const { video, btnPlay, btnMute, vol, btnFs, btnAud, btnInfo, btnCls, videoArea, timeline } = this.dom;
    btnPlay?.addEventListener('click', ()=>this._togglePlay());
    videoArea?.addEventListener('click', e=>{ if(e.target===video||e.target===videoArea) this._togglePlay(); });
    btnMute?.addEventListener('click', ()=>this._toggleMute());
    vol?.addEventListener('input', ()=>this._volChange());
    btnFs?.addEventListener('click', ()=>this._toggleFs());
    btnAud?.addEventListener('click', ()=>this._toggleAudioPanel());
    btnInfo?.addEventListener('click', ()=>this._toggleInfo());
    btnCls?.addEventListener('click', ()=>this.close());
    timeline?.addEventListener('mousedown', e=>this._startScrub(e));
    video?.addEventListener('play', ()=>this._onPlay());
    video?.addEventListener('pause', ()=>this._onPause());
    video?.addEventListener('ended', ()=>this._onEnd());
    video?.addEventListener('loadedmetadata', ()=>this._onMeta());
    video?.addEventListener('error', ()=>this._onMediaError());
    video?.addEventListener('timeupdate', ()=>this._onTimeUpdate());
    document.addEventListener('keydown', this._kb);
    document.addEventListener('fullscreenchange', this._fsh);
    this._rootMove=()=>this._resetIdle();
    this.dom.root?.addEventListener('mousemove', this._rootMove);
  }

  _unbind() {
    document.removeEventListener('mousemove', this._mmh);
    document.removeEventListener('mouseup', this._muh);
    document.removeEventListener('keydown', this._kb);
    document.removeEventListener('fullscreenchange', this._fsh);
    if(this._rootMove) this.dom.root?.removeEventListener('mousemove', this._rootMove);
    clearTimeout(this._idleT); this._idleT=null;
  }

  // ── Load / Probe ──
  async _load(media) {
    this._stopAll(); if(!media) return;
    const fp=media.filepath||media.path||media.url||'';
    const ext=(fp.split('.').pop()||'').toUpperCase();
    this.dom.badge.textContent=ext||'VIDEO';
    this.dom.title.textContent=media.filename||media.name||fp.split(/[/\\]/).pop()||'Video';
    this.media=media; this.duration=0; this._infoFetched=false; this._infoData=null;
    if(this.dom.infoGrid) this.dom.infoGrid.innerHTML='';
    if(this.isInfoOpen) this._fetchInfo(); // painel já aberto: mostra os dados da nova mídia
    this.dom.curTime.textContent='00:00'; this.dom.dur.textContent='00:00';
    this.dom.tlFill.style.width='0%'; this.dom.tlHead.style.left='0%';
    this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='play_arrow';
    this._showError('');
    const gen=this._loadGen; // token de sequência: descarta a sondagem de uma mídia já substituída/fechada
    const v=this.dom.video; v.src=_f(fp); v.load();
    const streams=await this._probeAudio(fp);
    if(gen!==this._loadGen) return;
    this.aStreams=streams; this._buildAudioPanel(media);
  }

  // Mídia ausente/corrompida/formato não suportado: avisa em vez de ficar com a tela preta
  _onMediaError() {
    const v=this.dom.video; if(!v||!v.getAttribute('src')) return;
    const code=v.error&&v.error.code;
    const msg=code===3?'Não foi possível decodificar este vídeo.'
      :code===4?'Arquivo ausente ou formato não suportado.'
      :'Não foi possível carregar este vídeo.';
    this._showError(msg);
  }

  _showError(msg) {
    const area=this.dom.videoArea; if(!area) return;
    if(!this.dom.err){
      const el=document.createElement('div'); el.className='vp-error';
      el.style.cssText='position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:24px;color:#fca5a5;font-size:14px;pointer-events:none';
      if(getComputedStyle(area).position==='static') area.style.position='relative';
      area.appendChild(el); this.dom.err=el;
    }
    this.dom.err.textContent=msg||''; this.dom.err.style.display=msg?'flex':'none';
  }

  _stopAll() {
    const v=this.dom.video;
    if(v){ v.pause(); v.removeAttribute('src'); try{v.load();}catch(_){} }
    this._loadGen=(this._loadGen||0)+1; // invalida callbacks assíncronos de trilhas da mídia anterior
    this.tAudioEls.forEach(a=>{ try{ a.pause(); a.removeAttribute('src'); a.load(); }catch(_){} });
    this.tRenderers.forEach(r=>{ try{ r.destroy(); }catch(_){} });
    this.tAudioEls=[]; this.tRenderers=[]; this.tMuted=[]; this.aStreams=[];
    if(this._raf){ cancelAnimationFrame(this._raf); this._raf=null; }
    clearTimeout(this._idleT); this._idleT=null;
  }

  async _probeAudio(fp) {
    this.aStreams=[];
    try{ if(window.bds?.probeAudioStreams){ const s=await window.bds.probeAudioStreams(fp); return Array.isArray(s)?s:[]; } }catch(_){ /* sem trilhas */ }
    return [];
  }

  _init() {
    const r=document.createElement('div'); r.className='video-preview-overlay hidden';
    r.innerHTML=`<div class="vp-header"><div class="vp-header-left"><span class="vp-format-badge" id="vpBdg">MP4</span><span class="vp-title" id="vpTtl">Video</span></div><div class="vp-header-right"><button class="vp-header-btn" id="vpInfo" title="Info (I)"><span class="material-symbols-rounded">info</span></button><button class="vp-header-btn" id="vpCls"><span class="material-symbols-rounded">close</span></button></div></div><div class="vp-content"><div class="vp-video-area" id="vpVA"><video id="vpVid" preload="auto" playsinline></video></div><div class="vp-audio-panel hidden" id="vpAP"></div></div><div class="vp-info-panel hidden" id="vpIP"><div class="vp-info-grid" id="vpIG"></div></div><div class="vp-controls"><div class="vp-timeline" id="vpTL"><div class="vp-timeline-track" id="vpTLT"><div class="vp-timeline-fill" id="vpTLF"></div><div class="vp-timeline-playhead" id="vpTLH"></div></div></div><div class="vp-controls-row"><div class="vp-controls-left"><button class="vp-ctrl-btn play-btn" id="vpPlay"><span class="material-symbols-rounded">play_arrow</span></button><span class="vp-time" id="vpCur">00:00</span><span class="vp-time-sep">/</span><span class="vp-time vp-time-duration" id="vpDur">00:00</span></div><div class="vp-controls-right"><button class="vp-ctrl-btn" id="vpBAud"><span class="material-symbols-rounded">graphic_eq</span></button><button class="vp-ctrl-btn" id="vpMute"><span class="material-symbols-rounded">volume_up</span></button><input type="range" class="vp-volume-slider" id="vpVol" min="0" max="1" step="0.01" value="1"><button class="vp-ctrl-btn" id="vpFS"><span class="material-symbols-rounded">fullscreen</span></button></div></div></div>`;
    this.parent.appendChild(r);
    this.dom={ root:r, badge:r.querySelector('#vpBdg'), title:r.querySelector('#vpTtl'),
      btnInfo:r.querySelector('#vpInfo'), btnCls:r.querySelector('#vpCls'),
      videoArea:r.querySelector('#vpVA'), video:r.querySelector('#vpVid'),
      audioPanel:r.querySelector('#vpAP'), infoPanel:r.querySelector('#vpIP'),
      infoGrid:r.querySelector('#vpIG'), controls:r.querySelector('.vp-controls'),
      header:r.querySelector('.vp-header'), timeline:r.querySelector('#vpTL'),
      tlTrack:r.querySelector('#vpTLT'), tlFill:r.querySelector('#vpTLF'),
      tlHead:r.querySelector('#vpTLH'), btnPlay:r.querySelector('#vpPlay'),
      curTime:r.querySelector('#vpCur'), dur:r.querySelector('#vpDur'),
      btnAud:r.querySelector('#vpBAud'), btnMute:r.querySelector('#vpMute'),
      vol:r.querySelector('#vpVol'), btnFs:r.querySelector('#vpFS') };
  }

// ── Audio panel ──
  _buildAudioPanel(media) {
    const panel=this.dom.audioPanel; if(!panel)return;
    const gen=this._loadGen;
    panel.innerHTML='';
    const fp=media.filepath||media.path||''; const uid=_u(media,fp);
    const count=Math.max(1,this.aStreams.length);
    for(let i=0;i<count;i++){
      const info=this.aStreams[i]||{};
      const label=info.label||(info.codec_name?`${info.codec_name.toUpperCase()} Ch${info.channels||'?'}`:`Track ${i}`);
      const row=document.createElement('div'); row.className='vp-track-row';
      row.innerHTML=`<span class="vp-track-label">T${i}</span><div class="vp-track-info">${_e(label)}</div><div class="vp-track-waveform-wrap"><canvas></canvas></div><button class="vp-track-mute-btn" data-idx="${i}" title="Mudo T${i}"><span class="material-symbols-rounded">volume_up</span></button>`;
      panel.appendChild(row);
      const canvas=row.querySelector('canvas');
      const renderer=new WaveformRenderer(canvas,{color:'rgba(120,180,255,0.85)'});
      this.tRenderers.push(renderer); this.tMuted.push(false);
      if(window.bds?.getMediaWaveform){
        window.bds.getMediaWaveform({uuid:uid,filePath:fp,peaksPerSecond:80,streamIndex:i})
          .then(wf=>{ if(wf?.peaks)renderer.setPeaks(wf.peaks,wf.duration||this.duration); }).catch(()=>{});
      }
      row.querySelector('.vp-track-mute-btn')?.addEventListener('click',()=>this._toggleTrackMute(i));
      if(i>0 && window.bds?.getTrackAudioPath){
        window.bds.getTrackAudioPath({uuid:uid,filePath:fp,streamIndex:i}).then(url=>{
          if(gen!==this._loadGen) return; // a mídia mudou/fechou enquanto o caminho era resolvido
          const a=new Audio(); a.preload='metadata'; a.src=url; this.tAudioEls[i]=a; a.volume=parseFloat(this.dom.vol?.value||1);
        }).catch(()=>{});
      }
    }
  }

  _toggleTrackMute(idx) {
    if(idx<0||idx>=this.tMuted.length)return;
    this.tMuted[idx]=!this.tMuted[idx];
    const a=this.tAudioEls[idx]; if(a)a.muted=this.tMuted[idx];
    const row=this.dom.audioPanel?.querySelectorAll('.vp-track-row')?.[idx];
    const btn=row?.querySelector('.vp-track-mute-btn');
    if(btn){ btn.classList.toggle('muted',this.tMuted[idx]); btn.querySelector('.material-symbols-rounded').textContent=this.tMuted[idx]?'volume_off':'volume_up'; }
  }
// ── Playback ──
  _togglePlay() {
    const v=this.dom.video; if(!v||!v.src)return;
    v.paused?v.play().catch(()=>{}):v.pause();
  }

  _onPlay() {
    this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='pause';
    this.tAudioEls.forEach(a=>{ if(a)a.play().catch(()=>{}); });
    this._startLoop(); this._resetIdle();
  }

  _onPause() {
    this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='play_arrow';
    if(this._raf){ cancelAnimationFrame(this._raf); this._raf=null; }
    this.dom.header?.classList.remove('idle-hidden');
    this.dom.controls?.classList.remove('idle-hidden');
  }

  _onEnd(){ this._onPause(); }

  _onMeta() {
    this.duration=this.dom.video.duration||0;
    this.dom.dur.textContent=_t(this.duration);
    if(this._autoplay){ this._autoplay=false; this.dom.video.play().catch(()=>{}); }
  }

  _onTimeUpdate() {
    if(this.isScrub)return;
    const v=this.dom.video; const ct=v.currentTime||0;
    this.dom.curTime.textContent=_t(ct);
    const pct=this.duration>0?(ct/this.duration)*100:0;
    this.dom.tlFill.style.width=pct+'%'; this.dom.tlHead.style.left=pct+'%';
    this.tAudioEls.forEach(a=>{ if(a&&Math.abs(a.currentTime-ct)>0.3)a.currentTime=ct; });
    const progress=this.duration>0?ct/this.duration:0;
    this.tRenderers.forEach(r=>{ try{r.updatePlayhead(progress);}catch(_){} });
  }

  _startLoop() {
    const loop=()=>{ this._onTimeUpdate(); this._raf=requestAnimationFrame(loop); };
    this._raf=requestAnimationFrame(loop);
  }
// ── Scrub / Seek ──
  _startScrub(e) {
    e.preventDefault(); this.isScrub=true;
    // mousemove/mouseup globais só existem durante o arraste
    document.addEventListener('mousemove', this._mmh);
    document.addEventListener('mouseup', this._muh);
    this.dom.timeline?.classList.add('scrubbing');
    this._scrubMove(e);
  }

  _scrubMove(e) {
    if(!this.isScrub)return;
    const rect=this.dom.tlTrack?.getBoundingClientRect(); if(!rect)return;
    const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    this._lastScrubPct=pct;
    this.dom.tlFill.style.width=(pct*100)+'%'; this.dom.tlHead.style.left=(pct*100)+'%';
    this.dom.curTime.textContent=_t(pct*this.duration);
  }

  _handleMouseMove(e){ this._scrubMove(e); }

  _handleMouseUp() {
    if(!this.isScrub)return;
    this.isScrub=false; this.dom.timeline?.classList.remove('scrubbing');
    document.removeEventListener('mousemove', this._mmh);
    document.removeEventListener('mouseup', this._muh);
    const t=this._lastScrubPct*this.duration;
    this.dom.video.currentTime=t;
    this.tAudioEls.forEach(a=>{ if(a)a.currentTime=t; });
  }

  // ── Volume ──
  _toggleMute() {
    const v=this.dom.video; if(!v)return;
    v.muted=!v.muted;
    this.dom.btnMute.querySelector('.material-symbols-rounded').textContent=v.muted?'volume_off':'volume_up';
  }

  _volChange() {
    const val=parseFloat(this.dom.vol?.value||1);
    this.dom.video.volume=val;
    this.tAudioEls.forEach(a=>{ if(a)a.volume=val; });
  }

  // ── Fullscreen ──
  _toggleFs() {
    if(document.fullscreenElement){ document.exitFullscreen().catch(()=>{}); }
    else{ this.dom.root?.requestFullscreen().catch(()=>{}); }
  }

  _onFsChange() {
    const isFs=!!document.fullscreenElement;
    this.dom.btnFs.querySelector('.material-symbols-rounded').textContent=isFs?'fullscreen_exit':'fullscreen';
  }

  // ── Panels ──
  _toggleAudioPanel() {
    this.isAudOpen=!this.isAudOpen;
    this.dom.audioPanel?.classList.toggle('hidden',!this.isAudOpen);
    this.dom.btnAud?.classList.toggle('active',this.isAudOpen);
  }

  async _toggleInfo() {
    this.isInfoOpen=!this.isInfoOpen;
    this.dom.infoPanel?.classList.toggle('hidden',!this.isInfoOpen);
    this.dom.btnInfo?.classList.toggle('active',this.isInfoOpen);
    if(this.isInfoOpen&&!this._infoFetched) await this._fetchInfo();
  }

  async _fetchInfo() {
    const fp=this.media?.filepath||this.media?.path||'';
    if(!fp||!window.bds?.probeMetadataFile)return;
    try{
      const data=await window.bds.probeMetadataFile(fp);
      this._infoData=data; this._infoFetched=true; this._renderInfo(data);
    }catch(err){ console.error('[PREVIEW] Falha ao ler informações da mídia:',err); }
  }

  _renderInfo(raw) {
    const grid=this.dom.infoGrid; if(!grid||!raw)return;
    grid.innerHTML='';
    // 'metadata:probe' devolve o JSON do ffprobe ({ streams, format }); aceita também um objeto já achatado.
    const streams=Array.isArray(raw.streams)?raw.streams:[];
    const vs=streams.find(s=>s.codec_type==='video')||{};
    const as=streams.find(s=>s.codec_type==='audio')||{};
    const fmt=raw.format||{};
    const data=streams.length||raw.format?{...raw,...vs,fps:_fps(vs.avg_frame_rate||vs.r_frame_rate),audio_codec:as.codec_name,channels:as.channels,
      duration:fmt.duration||vs.duration,bit_rate:fmt.bit_rate||vs.bit_rate,size:fmt.size}:raw;
    const fields=[
      ['Codec',data.codec_name||'-'],
      ['Resolução',data.width&&data.height?`${data.width}×${data.height}`:'-'],
      ['FPS',data.fps||'-'],
      ['Duração',_t(parseFloat(data.duration)||this.duration)],
      ['Bitrate',data.bit_rate?`${(parseInt(data.bit_rate)/1000).toFixed(0)} kbps`:'-'],
      ['Áudio',data.audio_codec||'-'],
      ['Canais',data.channels||'-'],
      ['Tamanho',data.size?_sz(parseInt(data.size)):'-'],
    ];
    fields.forEach(([label,value])=>{
      const item=document.createElement('div'); item.className='vp-info-item';
      item.innerHTML=`<span class="vp-info-label">${_e(label)}</span><span class="vp-info-value">${_e(value)}</span>`;
      grid.appendChild(item);
    });
  }
// ── Idle ──
  _resetIdle() {
    this._lastAct=performance.now();
    if(this._idleHidden){
      this._idleHidden=false;
      this.dom.header?.classList.remove('idle-hidden');
      this.dom.controls?.classList.remove('idle-hidden');
    }
    if(!this._idleT) this._scheduleIdle(3000); // um único timer; mousemove só atualiza o timestamp
  }

  _scheduleIdle(ms) {
    this._idleT=setTimeout(()=>{
      this._idleT=null;
      const left=3000-(performance.now()-this._lastAct);
      if(left>5){ this._scheduleIdle(left); return; }
      this._hideIdle();
    },ms);
  }

  _hideIdle() {
    if(!this.dom.video||this.dom.video.paused)return;
    this.dom.header?.classList.add('idle-hidden');
    this.dom.controls?.classList.add('idle-hidden');
    this._idleHidden=true;
  }

  // ── Keyboard ──
  _handleKey(e) {
    if(e.target?.tagName==='INPUT'||e.target?.tagName==='TEXTAREA')return;
    if(!this.dom.root||this.dom.root.classList.contains('hidden'))return;
    switch(e.key){
      case ' ': e.preventDefault(); this._togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); this.dom.video.currentTime=Math.max(0,this.dom.video.currentTime-(e.shiftKey?10:5)); break;
      case 'ArrowRight': e.preventDefault(); this.dom.video.currentTime=Math.min(this.duration,this.dom.video.currentTime+(e.shiftKey?10:5)); break;
      case 'm': case 'M': this._toggleMute(); break;
      case 'f': case 'F': this._toggleFs(); break;
      case 'i': case 'I': this._toggleInfo(); break;
      case 'a': case 'A': this._toggleAudioPanel(); break;
      case 'Escape': this.close(); break;
    }
  }
}