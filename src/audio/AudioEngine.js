// Web Audio 엔진: 컨텍스트, 버스(발소리·환경·날씨·몸), 노이즈 버퍼, 합성 도우미
// 모든 소리는 절차적으로 합성한다 (사운드 파일 없음).
import { CONFIG } from '../config.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buses = {};
    this.buffers = {};
  }

  /** 사용자 제스처(클릭) 안에서 호출해야 함. ctx를 넘기면 그 컨텍스트 사용 (테스트용 OfflineAudioContext 등) */
  init(customCtx = null) {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC && !customCtx) return;
    const ctx = this.ctx = customCtx || new AC({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.master;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    for (const name of ['footsteps', 'ambience', 'weather', 'body']) {
      const g = ctx.createGain();
      g.gain.value = CONFIG.audio[name === 'body' ? 'breathing' : name];
      g.connect(this.master);
      this.buses[name] = g;
    }
    this.buffers.white = this._noiseBuffer('white', 2);
    this.buffers.pink = this._noiseBuffer('pink', 4);
    this.buffers.brown = this._noiseBuffer('brown', 4);
    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  _noiseBuffer(type, seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'white') d[i] = w;
      else if (type === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    return buf;
  }

  /** 노이즈 소스 (임의 위치에서 시작) */
  noise(type = 'white', loop = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[type];
    src.loop = loop;
    src._offset = Math.random() * (src.buffer.duration - 0.6);
    return src;
  }

  /**
   * 필터 노이즈 버스트 (발소리 등 짧은 소리의 기본 재료)
   * o: { t, dur, attack, gain, type, filter, freq, freqEnd, q, out, pan, noise }
   */
  burst(o) {
    const ctx = this.ctx;
    const t = o.t ?? ctx.currentTime;
    const src = this.noise(o.noise || 'white');
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t + (o.sweep ?? o.dur));
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    const attack = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + o.dur);
    let node = src.connect(f).connect(g);
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      node = node.connect(p);
    }
    node.connect(o.out || this.master);
    src.start(t, src._offset);
    src.stop(t + attack + o.dur + 0.05);
    return src;
  }

  /** 음정이 변하는 사인/삼각파 톤 (새소리·쿵 소리) */
  tone(o) {
    const ctx = this.ctx;
    const t = o.t ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.points) {
      for (const [dt, f] of o.points) osc.frequency.linearRampToValueAtTime(f, t + dt);
    } else if (o.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
    }
    let src = osc;
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = o.vibrato.rate;
      const lg = ctx.createGain();
      lg.gain.value = o.vibrato.depth;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t); lfo.stop(t + o.dur + 0.05);
    }
    const g = ctx.createGain();
    const attack = o.attack ?? 0.01;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + attack);
    g.gain.setValueAtTime(Math.max(0.0002, o.gain), t + Math.max(attack, o.dur - (o.release ?? o.dur * 0.6)));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let node = src.connect(g);
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter.type || 'lowpass';
      f.frequency.value = o.filter.freq;
      f.Q.value = o.filter.q ?? 0.7;
      node = node.connect(f);
    }
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      node = node.connect(p);
    }
    node.connect(o.out || this.master);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
    return osc;
  }
}
