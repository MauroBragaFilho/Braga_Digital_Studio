/**
 * AudioPreview — Visualizador de áudio profissional para o BDS.
 * Dark, minimalista, gráfico, audio-first.
 * Atalhos: Space, ←→, Shift+←→, I, M, F, Esc.
 */
import { WaveformRenderer } from './WaveformRenderer.js';

import { escapeHtml as _e } from '../../utils/escape.js';
import { toFileUrl } from '../../utils/fileUrl.js';
const _sz = b => b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB';
const _t = s => { if(!s||isNaN(s))return'00:00'; return String(Math.floor(s/60)).padStart(2,'0')+':'+String(Math.floor(s%60)).padStart(2,'0'); };
const _f = fp => toFileUrl(fp);
const _u = (m,fp) => { if(m&&m.uuid)return m.uuid; let h=0; const s=String(fp||'').toLowerCase(); for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;} return 'a_'+Math.abs(h).toString(36); };

export class AudioPreview {
  constructor(opts={}) {
    this.onClose=opts.onClose||(()=>{}); this.dom={};
    this.media=null; this.collection=[]; this.ci=-1; this.duration=0;
    this.tRenderers=[]; this.tMuted=[]; this.isInfoOpen=false; this.isScrub=false;
    this._infoFetched=false; this._infoData=null; this._lastScrubPct=0;
    this._audioEls=[]; this._masterAudio=null;
    this._raf=null; this._idleT=null;
    this._kb=this._handleKey.bind(this);
    this._mmh=this._handleMouseMove.bind(this);
    this._muh=this._handleMouseUp.bind(this);
    this._fsh=this._onFsChange.bind(this);
  }

  mount(el){ this.parent=el; this._init(); this._bind(); }
  unmount(){ this._unbind(); this.dom.root?.remove(); }
  open(media,coll=[]) {
    this.media=media; this.collection=coll.length?coll:[media];
    this.ci=this.collection.findIndex(m=>(m.filepath||m.path)===(media.filepath||media.path));
    if(this.ci<0)this.ci=0;
    this._load(this.collection[this.ci]);
    this.dom.root.classList.remove('hidden');
  }
  close(){ this._stopAll(); this.dom.root?.classList.add('hidden'); this.onClose(); }

  _init() {
    const r=document.createElement('div'); r.className='audio-preview-overlay hidden';
    r.innerHTML=`<div class="ap-header"><div class="ap-header-left"><span class="ap-format-badge" id="apBdg">MP3</span><span class="ap-title" id="apTtl">Audio</span></div><div class="ap-header-right"><button class="ap-header-btn" id="apInfo" title="Info (I)"><span class="material-symbols-rounded">info</span></button><button class="ap-header-btn" id="apCls"><span class="material-symbols-rounded">close</span></button></div></div><div class="ap-content"><div class="ap-waveform-area" id="apWA"></div></div><div class="ap-info-panel hidden" id="apIP"><div class="ap-info-grid" id="apIG"></div></div><div class="ap-controls"><div class="ap-timeline" id="apTL"><div class="ap-timeline-track" id="apTLT"><div class="ap-timeline-fill" id="apTLF"></div><div class="ap-timeline-playhead" id="apTLH"></div></div></div><div class="ap-controls-row"><div class="ap-controls-left"><button class="ap-ctrl-btn play-btn" id="apPlay"><span class="material-symbols-rounded">play_arrow</span></button><span class="ap-time" id="apCur">00:00</span><span class="ap-time-sep">/</span><span class="ap-time ap-time-duration" id="apDur">00:00</span></div><div class="ap-controls-right"><button class="ap-ctrl-btn" id="apMute"><span class="material-symbols-rounded">volume_up</span></button><input type="range" class="ap-volume-slider" id="apVol" min="0" max="1" step="0.01" value="1"><button class="ap-ctrl-btn" id="apFS"><span class="material-symbols-rounded">fullscreen</span></button></div></div></div>`;
    this.parent.appendChild(r);
    this.dom={ root:r, badge:r.querySelector('#apBdg'), title:r.querySelector('#apTtl'),
      btnInfo:r.querySelector('#apInfo'), btnCls:r.querySelector('#apCls'),
      waveArea:r.querySelector('#apWA'), infoPanel:r.querySelector('#apIP'),
      infoGrid:r.querySelector('#apIG'), controls:r.querySelector('.ap-controls'),
      header:r.querySelector('.ap-header'), timeline:r.querySelector('#apTL'),
      tlTrack:r.querySelector('#apTLT'), tlFill:r.querySelector('#apTLF'),
      tlHead:r.querySelector('#apTLH'), btnPlay:r.querySelector('#apPlay'),
      curTime:r.querySelector('#apCur'), dur:r.querySelector('#apDur'),
      btnMute:r.querySelector('#apMute'), vol:r.querySelector('#apVol'),
      btnFs:r.querySelector('#apFS') };
  }
// ── Bind / Unbind ──
  _bind() {
    const { btnPlay, btnMute, vol, btnFs, btnInfo, btnCls, timeline } = this.dom;
    btnPlay?.addEventListener('click', ()=>this._togglePlay());
    btnMute?.addEventListener('click', ()=>this._toggleMute());
    vol?.addEventListener('input', ()=>this._volChange());
    btnFs?.addEventListener('click', ()=>this._toggleFs());
    btnInfo?.addEventListener('click', ()=>this._toggleInfo());
    btnCls?.addEventListener('click', ()=>this.close());
    timeline?.addEventListener('mousedown', e=>this._startScrub(e));
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

  // ── Load ──
  async _load(media) {
    this._stopAll(); if(!media) return;
    const fp=media.filepath||media.path||media.url||'';
    const ext=(fp.split('.').pop()||'').toUpperCase();
    this.dom.badge.textContent=ext||'AUDIO';
    this.dom.title.textContent=media.filename||media.name||fp.split(/[/\\]/).pop()||'Audio';
    this.media=media; this.duration=0; this._infoFetched=false; this._infoData=null;
    if(this.dom.infoGrid) this.dom.infoGrid.innerHTML='';
    if(this.isInfoOpen) this._fetchInfo(); // painel já aberto: mostra os dados da nova mídia
    this.dom.curTime.textContent='00:00'; this.dom.dur.textContent='00:00';
    this.dom.tlFill.style.width='0%'; this.dom.tlHead.style.left='0%';
    this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='play_arrow';
    await this._buildAudio(media);
  }

  _stopAll() {
    this._audioEls.forEach(a=>{ try{ a.pause(); a.removeAttribute('src'); a.load(); }catch(_){} });
    this.tRenderers.forEach(r=>{ try{ r.destroy(); }catch(_){} });
    this._audioEls=[]; this._masterAudio=null;
    this.tRenderers=[]; this.tMuted=[];
    if(this._raf){ cancelAnimationFrame(this._raf); this._raf=null; }
    clearTimeout(this._idleT); this._idleT=null;
  }

  async _buildAudio(media) {
    const area=this.dom.waveArea; if(!area)return;
    area.innerHTML=''; const fp=media.filepath||media.path||''; const uid=_u(media,fp);
    const audioEl=document.createElement('audio');
    audioEl.src=_f(fp); audioEl.preload='metadata';
    audioEl.addEventListener('loadedmetadata', ()=>{ this.duration=audioEl.duration||0; this.dom.dur.textContent=_t(this.duration); });
    audioEl.addEventListener('error', ()=>{
      // Arquivo ausente/corrompido/formato não suportado: avisa no título em vez de um player mudo
      if(!audioEl.getAttribute('src')||this._masterAudio!==audioEl) return;
      this.dom.title.textContent=(media.filename||media.name||fp.split(/[/\\]/).pop()||'Audio')+' — não foi possível carregar o áudio';
      this.dom.dur.textContent='--:--';
    });
    audioEl.addEventListener('timeupdate', ()=>this._onTimeUpdate());
    audioEl.addEventListener('play', ()=>this._onPlay());
    audioEl.addEventListener('pause', ()=>this._onPause());
    audioEl.addEventListener('ended', ()=>this._onEnd());
    this._audioEls=[audioEl]; this._masterAudio=audioEl;

    const row=document.createElement('div'); row.className='ap-track-row';
    row.innerHTML=`<span class="ap-track-label">A</span><div class="ap-track-waveform-wrap" style="flex:1"><canvas></canvas></div><button class="ap-track-mute-btn" title="Mudo"><span class="material-symbols-rounded">volume_up</span></button>`;
    area.appendChild(row);
    const canvas=row.querySelector('canvas');
    const renderer=new WaveformRenderer(canvas,{color:'rgba(168,85,247,0.85)',playheadColor:'#a855f7'});
    this.tRenderers.push(renderer); this.tMuted.push(false);
    if(window.bds?.getMediaWaveform){
      window.bds.getMediaWaveform({uuid:uid,filePath:fp,peaksPerSecond:100,streamIndex:0})
        .then(wf=>{ if(wf?.peaks)renderer.setPeaks(wf.peaks,wf.duration||this.duration); }).catch(()=>{});
    }
    row.querySelector('.ap-track-mute-btn')?.addEventListener('click', ()=>{
      if(this._masterAudio){ this._masterAudio.muted=!this._masterAudio.muted; this.tMuted[0]=this._masterAudio.muted; }
      row.querySelector('.ap-track-mute-btn')?.classList.toggle('muted',this.tMuted[0]);
      row.querySelector('.ap-track-mute-btn .material-symbols-rounded').textContent=this.tMuted[0]?'volume_off':'volume_up';
    });
  }
// ── Playback ──
  _togglePlay() { const a=this._masterAudio; if(!a)return; a.paused?a.play().catch(()=>{}):a.pause(); }
  _onPlay() { this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='pause'; this._resetIdle(); }
  _onPause() { this.dom.btnPlay.querySelector('.material-symbols-rounded').textContent='play_arrow'; this.dom.header?.classList.remove('idle-hidden'); this.dom.controls?.classList.remove('idle-hidden'); }
  _onEnd(){ this._onPause(); }

  _onTimeUpdate() {
    if(this.isScrub)return; const a=this._masterAudio; if(!a)return;
    const ct=a.currentTime||0; this.dom.curTime.textContent=_t(ct);
    const pct=this.duration>0?(ct/this.duration)*100:0;
    this.dom.tlFill.style.width=pct+'%'; this.dom.tlHead.style.left=pct+'%';
    const progress=this.duration>0?ct/this.duration:0;
    this.tRenderers.forEach(r=>{ try{r.updatePlayhead(progress);}catch(_){} });
  }

  // ── Scrub ──
  _startScrub(e) {
    e.preventDefault(); this.isScrub=true;
    // mousemove/mouseup globais só existem durante o arraste
    document.addEventListener('mousemove', this._mmh);
    document.addEventListener('mouseup', this._muh);
    this.dom.timeline?.classList.add('scrubbing'); this._scrubMove(e);
  }
  _scrubMove(e) {
    if(!this.isScrub)return; const rect=this.dom.tlTrack?.getBoundingClientRect(); if(!rect)return;
    const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
    this._lastScrubPct=pct;
    this.dom.tlFill.style.width=(pct*100)+'%'; this.dom.tlHead.style.left=(pct*100)+'%';
    this.dom.curTime.textContent=_t(pct*this.duration);
  }
  _handleMouseMove(e){ this._scrubMove(e); }
  _handleMouseUp() {
    if(!this.isScrub)return; this.isScrub=false;
    document.removeEventListener('mousemove', this._mmh);
    document.removeEventListener('mouseup', this._muh);
    this.dom.timeline?.classList.remove('scrubbing');
    const t=this._lastScrubPct*this.duration;
    this._audioEls.forEach(a=>{ if(a)a.currentTime=t; });
  }

  // ── Volume ──
  _toggleMute() { if(!this._masterAudio)return; this._masterAudio.muted=!this._masterAudio.muted; this.dom.btnMute.querySelector('.material-symbols-rounded').textContent=this._masterAudio.muted?'volume_off':'volume_up'; }
  _volChange() { const val=parseFloat(this.dom.vol?.value||1); this._audioEls.forEach(a=>{ if(a)a.volume=val; }); }

  // ── Fullscreen ──
  _toggleFs() { if(document.fullscreenElement)document.exitFullscreen().catch(()=>{}); else this.dom.root?.requestFullscreen().catch(()=>{}); }
  _onFsChange() { const isFs=!!document.fullscreenElement; this.dom.btnFs.querySelector('.material-symbols-rounded').textContent=isFs?'fullscreen_exit':'fullscreen'; }
// ── Info ──
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
    const as=streams.find(s=>s.codec_type==='audio')||{};
    const fmt=raw.format||{};
    const data=streams.length||raw.format?{...raw,audio_codec:as.codec_name,sample_rate:as.sample_rate,channels:as.channels,
      duration:fmt.duration||as.duration,bit_rate:as.bit_rate||fmt.bit_rate,size:fmt.size}:raw;
    const fields=[
      ['Codec',data.audio_codec||data.codec_name||'-'],
      ['Taxa amostral',data.sample_rate?`${(parseInt(data.sample_rate)/1000).toFixed(1)} kHz`:'-'],
      ['Canais',data.channels||data.audio_channels||'-'],
      ['Bitrate',data.bit_rate?`${(parseInt(data.bit_rate)/1000).toFixed(0)} kbps`:'-'],
      ['Duração',_t(parseFloat(data.duration)||this.duration)],
      ['Tamanho',data.size?_sz(parseInt(data.size)):'-'],
    ];
    fields.forEach(([label,value])=>{
      const item=document.createElement('div'); item.className='ap-info-item';
      item.innerHTML=`<span class="ap-info-label">${_e(label)}</span><span class="ap-info-value">${_e(value)}</span>`;
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
    if(!this._masterAudio||this._masterAudio.paused)return;
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
      case 'ArrowLeft': e.preventDefault(); if(this._masterAudio)this._masterAudio.currentTime=Math.max(0,this._masterAudio.currentTime-(e.shiftKey?10:5)); break;
      case 'ArrowRight': e.preventDefault(); if(this._masterAudio)this._masterAudio.currentTime=Math.min(this.duration,this._masterAudio.currentTime+(e.shiftKey?10:5)); break;
      case 'm': case 'M': this._toggleMute(); break;
      case 'f': case 'F': this._toggleFs(); break;
      case 'i': case 'I': this._toggleInfo(); break;
      case 'Escape': this.close(); break;
    }
  }
}