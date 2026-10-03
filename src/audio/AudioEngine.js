// Web Audio 엔진: 컨텍스트, 버스, 노이즈 버퍼, 합성 도우미, 정글 잔향, 먹먹함 필터
// 모든 소리는 절차적으로 합성한다 (사운드 파일 없음).
//
// 신호 경로
//   발소리·환경·날씨·몸(숨)·무기 버스 ─┐
//   잔향 보내기 → Convolver(정글 IR) ──┴→ world → muffle(저역 통과, 제압) → master(음량) → 압축기 → 안전 리미터 → 출력
//   초음속 '딱'(crack) 버스 ─────────────────────────────────────────────→ master   (먹먹함을 건너뜀)
// '딱' 소리는 제압의 원인이라 먹먹해진 세상 속에서도 날카롭게 들려야 한다.
import { CONFIG } from '../config.js';

// 먹먹함 필터의 Q (저역/고역 통과에서 Web Audio 의 Q 는 dB 단위 공진값 — -3.01dB = 버터워스, 차단 주파수 근처가 솟지 않음)
const MUFFLE_Q = -3.01;
// 무기 버스와 먹먹함을 거치는 '세상' 버스 목록 (crack 은 따로)
const WORLD_BUSES = ['footsteps', 'ambience', 'weather', 'body', 'weapons'];

// 정글 잔향 임펄스 응답 (시드 고정 절차 생성 — 매번 같은 숲)
//  · 0~90ms: 가까운 나무 줄기·땅에서 오는 촘촘한 초기 반사 (탁탁 튀는 질감)
//  · 확산 꼬리: 두 기울기 감쇠 — 빽빽한 줄기 사이 산란(빠름) + 골짜기 전체가 울리는 긴 꼬리(느림).
//    잎이 고역을 먼저 먹어 시간이 갈수록 어두워짐
//  · 0.3~1.5초: 능선·언덕에서 돌아오는 뚜렷한 메아리 몇 개 — 좌우가 다르고, 늦을수록 어둡고 퍼짐
const IR = {
  seed: 0x6a756e67,
  seconds: 3.0,
  rtFast: 1.1,               // 산란 꼬리 잔향 시간 (s, -60dB)
  rtSlow: 4.0,               // 골짜기 꼬리 잔향 시간 (s) — 총성이 1.5~2초 동안 골짜기를 굴러가며 들림
  slowLevel: 0.4,            // 긴 꼬리의 시작 크기 (빠른 꼬리 대비)
  hfStartHz: 9000,           // 꼬리 시작의 고역 차단 (Hz) → hfEndHz 로 hfTau(s) 시간상수로 내려감
  hfEndHz: 600,
  hfTau: 0.7,
  buildUp: 0.018,            // 확산음이 차오르는 시간 (s) — 숲은 반사면이 많아 금방 촘촘해짐
  early: { count: 48, start: 0.004, end: 0.09, tau: 0.035, gain: 1.6 },
  // 메아리: t(s), 좌·우 상대 크기, 저역 통과(Hz), 퍼짐 τ(s), rel = 그 시각 꼬리 RMS 대비 크기
  echoes: [
    { t: 0.36, l: 1.0, r: 0.6, lp: 2400, tau: 0.06, rel: 2.6 },
    { t: 0.66, l: 0.55, r: 1.0, lp: 1900, tau: 0.08, rel: 2.4 },
    { t: 1.05, l: 1.0, r: 0.65, lp: 1400, tau: 0.1, rel: 2.2 },
    { t: 1.42, l: 0.6, r: 1.0, lp: 1000, tau: 0.13, rel: 2.0 },
  ],
  itd: 0.0005,               // 메아리 좌우 도달 시간 차 (s) — 가까운 쪽 귀에 먼저
  block: 32,                 // 필터 계수·포락선을 이 표본 수마다 갱신 (잡음이라 계단이 들리지 않음 — 생성 시간 절약)
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buses = {};
    this.buffers = {};
    this.muffleAmount = 0;
    this._onReady = [];
  }

  /**
   * init 이 끝나면 한 번 부를 함수 (이미 준비됐으면 바로). 무거운 합성 재료(무기 파형 등)를
   * 사용자 클릭(init) 시점에 미리 만들어 게임 도중 멈칫하지 않게 한다.
   */
  whenReady(fn) {
    if (this.ready) fn(this);
    else this._onReady.push(fn);
  }

  /** 사용자 제스처(클릭) 안에서 호출해야 함. ctx를 넘기면 그 컨텍스트 사용 (테스트용 OfflineAudioContext 등) */
  init(customCtx = null) {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC && !customCtx) return;
    const ctx = this.ctx = customCtx || new AC({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.master;
    const comp = this.compressor = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    // 압축기 뒤 안전 리미터: |x| < 0.9 에서는 정확히 그대로, 그 위만 부드럽게 눌러 1.0 을 넘지 않게
    // (총성이 여러 개 겹친 순간에도 출력이 하드 클리핑되지 않게. 1단계 소리는 이 구간에 닿지 않는다)
    // 파형 변환 곡선의 입력 범위는 ±1 이라 앞에서 ×0.5, 뒤에서 ×2 — 곡선이 ±2 까지의 신호를 다룬다
    const limIn = ctx.createGain(), limOut = ctx.createGain();
    limIn.gain.value = 0.5;
    limOut.gain.value = 2;
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = softClipCurve();
    this.limiter.oversample = 'none';
    this.master.connect(comp).connect(limIn).connect(this.limiter).connect(limOut).connect(ctx.destination);

    // '세상' 합류점 → 먹먹함 필터 → master. 0 이면 나이퀴스트(= 정확히 통과)라 1단계 소리가 바뀌지 않는다
    this.world = ctx.createGain();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = ctx.sampleRate / 2;
    this.muffle.Q.value = MUFFLE_Q;
    this.world.connect(this.muffle).connect(this.master);
    for (const name of WORLD_BUSES) {
      const g = ctx.createGain();
      g.gain.value = CONFIG.audio[name === 'body' ? 'breathing' : name] ?? 1;
      g.connect(this.world);
      this.buses[name] = g;
    }
    // 초음속 '딱' — 먹먹함을 건너뛰어 master 로 바로
    const crack = ctx.createGain();
    crack.gain.value = CONFIG.audio.crack ?? CONFIG.audio.weapons ?? 1;
    crack.connect(this.master);
    this.buses.crack = crack;

    // 정글 잔향: 소리마다 send 양만큼 reverbSend 로 보내면 공용 Convolver 하나가 꼬리를 만든다
    this.reverbSend = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;               // 크기는 IR 자체에서 맞춤 (normalize 는 버퍼를 넣기 전에 정해야 함)
    this.reverb.buffer = this._jungleImpulse();
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = (CONFIG.audio.reverb ?? 1) * this.reverbScale;
    this.reverbSend.connect(this.reverb).connect(this.reverbReturn).connect(this.world);

    this.buffers.white = this._noiseBuffer('white', 2);
    this.buffers.pink = this._noiseBuffer('pink', 4);
    this.buffers.brown = this._noiseBuffer('brown', 4);
    this.ready = true;
    // 추가 재료 준비가 실패해도 1단계 소리(발소리·환경·숨)는 그대로 동작해야 한다
    for (const fn of this._onReady.splice(0)) {
      try { fn(this); } catch (err) { console.error('[audio] whenReady 실패', err); }
    }
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /**
   * 주변 소리 먹먹함 0~1 (제압). 세상 버스 전체를 저역 통과 + 살짝 작게 — crack 버스는 영향 없음.
   * 차단 주파수는 maxHz → minHz 지수 보간 (귀로 듣는 높이는 로그라서), 0 이면 필터를 완전히 연다.
   */
  setMuffle(amount) {
    if (!this.muffle) return;
    const a = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
    // 매 프레임 호출돼도 자동화 이벤트가 쌓이지 않게 눈에 띄는 변화만 반영
    if (Math.abs(a - this.muffleAmount) < 0.002 && !(a === 0 && this.muffleAmount !== 0)) return;
    this.muffleAmount = a;
    const M = CONFIG.audio.muffle ?? {};
    const ny = this.ctx.sampleRate / 2;
    const maxHz = Math.min(ny, M.maxHz ?? 20000), minHz = M.minHz ?? 350;
    const f = a <= 0.001 ? ny : Math.min(ny, maxHz * Math.pow(minHz / maxHz, a));
    const t = this.ctx.currentTime, tc = M.smoothing ?? 0.08;
    this.muffle.frequency.setTargetAtTime(f, t, tc);
    this.world.gain.setTargetAtTime(1 - (M.duck ?? 0) * a, t, tc);
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

  /**
   * 정글 잔향 임펄스 응답 (스테레오). Math.random 대신 고정 시드 — 같은 숲이 매번 같은 소리를 내고,
   * 1단계 소리의 난수 순서도 건드리지 않는다. 크기 정규화 배율은 this.reverbScale (되돌림 gain 에 곱함).
   */
  _jungleImpulse() {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const n = Math.floor(IR.seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    let seed = IR.seed;
    const rnd = () => ((seed = xorshift(seed)) >>> 0) / 4294967296;   // 펄스 배치용 (표본 잡음은 반복 안에서 바로)
    const kFast = 6.91 / IR.rtFast, kSlow = 6.91 / IR.rtSlow;
    const { block, hfEndHz, hfTau, buildUp, slowLevel } = IR, hfSpan = IR.hfStartHz - hfEndHz;
    const dcR = Math.exp(-2 * Math.PI * 30 / sr);
    let energySum = 0;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // 1) 확산 꼬리: 백색 잡음(xorshift, 반복 안에서 바로) → 시간에 따라 내려가는 2극 저역 통과 → 차오름 × 두 기울기 감쇠
      //    (계수·포락선은 block 표본마다 — 안쪽 반복은 정수 연산·곱셈·덧셈만이라 JIT 전에도 빠르다)
      //    30Hz 직류 제거(아주 낮은 웅웅거림이 쌓이지 않게)와 에너지 합도 같은 반복에서
      let x = (IR.seed + 977 * (c + 1)) | 0;
      let l1 = 0, l2 = 0, hx = 0, hy = 0, energy = 0;
      for (let i0 = 0; i0 < n; i0 += block) {
        const t = (i0 + block / 2) / sr;
        const a = 1 - Math.exp(-2 * Math.PI * (hfEndHz + hfSpan * Math.exp(-t / hfTau)) / sr);
        const env = (1 - Math.exp(-t / buildUp)) * (Math.exp(-kFast * t) + slowLevel * Math.exp(-kSlow * t));
        const i1 = Math.min(n, i0 + block);
        for (let i = i0; i < i1; i++) {
          x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
          l1 += a * ((x >>> 0) / 2147483648 - 1 - l1);
          l2 += a * (l1 - l2);
          const v = l2 * env;
          hy = v - hx + dcR * hy;
          hx = v;
          d[i] = hy;
          energy += hy * hy;
        }
      }
      // 2) 초기 반사: 무작위 시각의 짧은 펄스 (3표본 폭 — 너무 쨍하지 않게)
      const E = IR.early;
      for (let k = 0; k < E.count; k++) {
        const t = E.start + (E.end - E.start) * Math.pow(rnd(), 1.4);   // 앞쪽이 더 촘촘
        const i = Math.floor(t * sr);
        const g = E.gain * Math.exp(-t / E.tau) * (0.35 + 0.65 * rnd()) * (rnd() < 0.5 ? -1 : 1);
        if (i + 2 < n) { d[i] += g * 0.5; d[i + 1] += g; d[i + 2] += g * 0.5; energy += 1.5 * g * g; }
      }
      // 3) 언덕 메아리: 그 시각 꼬리보다 rel 배 큰(첫 τ 동안 RMS 기준), 저역 통과된 짧은 잡음 덩어리
      for (let e = 0; e < IR.echoes.length; e++) {
        const h = IR.echoes[e];
        const side = c === 0 ? h.l : h.r;
        const lateEar = c === 0 ? h.l < h.r : h.l > h.r;     // 먼 쪽 귀는 조금 늦게
        const i0 = Math.floor((h.t + (lateEar ? IR.itd : 0)) * sr);
        const len = Math.min(n - i0, Math.floor(h.tau * 4 * sr));
        const a = 1 - Math.exp(-2 * Math.PI * h.lp / sr), r = 1 - a;
        // 균등 잡음(분산 1/3)을 1극 저역 통과 두 번 → 분산 × a⁴(1+r²)/(1-r²)³, 첫 τ 동안 지수 포락선의 제곱 평균 ≈ (1-e⁻²)/2
        const rmsHead = Math.sqrt((1 / 3) * a ** 4 * (1 + r * r) / (1 - r * r) ** 3 * (1 - Math.exp(-2)) / 2);
        const g = localRms(d, Math.floor(h.t * sr), Math.floor(0.03 * sr)) * h.rel * side / rmsHead;
        const kd = Math.exp(-1 / (h.tau * sr)), ka = 1 / (0.003 * sr);
        let y = (IR.seed + 31 * (e + 1) + 7 * c) | 0;
        let e1 = 0, e2 = 0, dec = g;
        for (let i = 0; i < len; i++) {
          y ^= y << 13; y ^= y >>> 17; y ^= y << 5;
          e1 += a * ((y >>> 0) / 2147483648 - 1 - e1);
          e2 += a * (e1 - e2);
          const v = e2 * (i < 1 / ka ? i * ka : 1) * dec;
          d[i0 + i] += v;
          energy += v * v;
          dec *= kd;
        }
      }
      energySum += energy;
    }
    // 정규화(채널 평균 에너지 1)는 버퍼를 다시 훑지 않고 되돌림 gain 에 곱한다 (init 시간 절약 — 좌우 에너지 차는 통계적으로 ±0.2dB)
    this.reverbScale = 1 / Math.sqrt(energySum / 2);
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

  /** 팬 + 잔향 보내기 공용 꼬리: node → [send → reverbSend] → [panner] → out */
  _finish(node, o) {
    const ctx = this.ctx;
    if (o.send > 0 && this.reverbSend) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      node.connect(s).connect(this.reverbSend);   // 팬 앞에서 보냄 — 잔향은 사방에서 온다
    }
    // pan 이 주어지면 0 이어도 패너를 둔다 (원래 동작: 모노 입력이 등전력 팬으로 -3dB — 1단계 소리 크기 유지)
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      node = node.connect(p);
    }
    node.connect(o.out || this.master);
  }

  /**
   * 필터 노이즈 버스트 (발소리 등 짧은 소리의 기본 재료)
   * o: { t, dur, attack, gain, type, filter, freq, freqEnd, q, out, pan, noise, send }
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
    if (o.send > 0 || o.pan !== undefined) this._finish(src.connect(f).connect(g), o);
    else src.connect(f).connect(g).connect(o.out || this.master);
    src.start(t, src._offset);
    src.stop(t + attack + o.dur + 0.05);
    return src;
  }

  /** 음정이 변하는 사인/삼각파 톤 (새소리·쿵 소리) — o.send: 잔향으로 보내는 양 */
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
    if (o.send > 0 || o.pan !== undefined) this._finish(node, o);
    else node.connect(o.out || this.master);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
    return osc;
  }

  /**
   * 미리 합성한 파형 재생 (총성·초음속 N파처럼 표본 단위로 모양을 잡아야 하는 소리)
   * o: { t, buffer, gain, rate, out, pan, send }
   */
  play(o) {
    const ctx = this.ctx;
    const t = o.t ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = o.buffer;
    if (o.rate && o.rate !== 1) src.playbackRate.value = o.rate;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    this._finish(src.connect(g), o);
    src.start(t);
    return src;
  }

  /**
   * 소리 하나(여러 재료의 합)를 위한 공용 경로 — 재료들이 out 으로 이 입력을 쓰면 필터·팬·잔향을 한 번만 만든다.
   * 입력(gain) → [저역 통과 ×stages: 거리·뒤쪽] → [팬] → out,  저역 통과 뒤에서 잔향으로 send
   * o: { gain, lowpass (Hz), stages (1|2), pan, out, send } → 입력 GainNode
   */
  voice(o) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = o.gain ?? 1;
    let node = input;
    // 15kHz 이상이면 들리는 차이가 없으니 필터를 만들지 않는다 (가까운 착탄 — 노드 절약)
    if (o.lowpass && o.lowpass < Math.min(15000, ctx.sampleRate / 2 * 0.9)) {
      for (let k = 0; k < (o.stages ?? 1); k++) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = o.lowpass;
        f.Q.value = MUFFLE_Q;
        node = node.connect(f);
      }
    }
    this._finish(node, o);
    return input;
  }
}

/** xorshift32 한 걸음 (시드 고정 잡음 — Math.random 순서를 건드리지 않음) */
export function xorshift(x) {
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return x | 0;
}

/** 배열을 [-1, 1) 균등 잡음으로 채움 (시드 고정, 표본마다 함수 호출 없이 — 합성 재료를 빨리 만들려고) */
export function fillNoise(arr, seed) {
  let x = (seed | 0) || 0x2545f491;
  for (let i = 0; i < arr.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    arr[i] = (x >>> 0) / 2147483648 - 1;
  }
  return arr;
}

/** 그 지점 주변 ±w 표본의 RMS (IR 메아리 크기 맞춤용) */
function localRms(d, i, w) {
  let s = 0, c = 0;
  for (let k = Math.max(0, i - w); k < Math.min(d.length, i + w); k++) { s += d[k] * d[k]; c++; }
  return Math.sqrt(s / Math.max(1, c));
}

/**
 * 안전 리미터 곡선 (앞 ×0.5 · 뒤 ×2 와 짝): 실제 신호 x ∈ [-2, 2] 를 곡선 입력 [-1, 1] 로 받아
 * |x| ≤ 0.9 는 정확히 직선(선형 보간이라 그대로 통과), 그 위는 tanh 로 1.0 에 부드럽게 수렴.
 */
function softClipCurve() {
  const N = 4097, knee = 0.9, room = 1 - knee;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 4 - 2;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y * 0.5;
  }
  return curve;
}
