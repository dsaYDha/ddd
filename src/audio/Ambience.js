// 정글 환경음 (벌레·새·먼 울음소리·바람) + 날씨 연동 빗소리
export class Ambience {
  constructor(engine) {
    this.e = engine;
    this.started = false;
    this.tod = { dawn: 1, day: 0.3, dusk: 0 };
    this.rain = 0;
    this.wind = 0.3;
    this.underCanopy = 1;
    this.nearWater = 0;
    this.timers = { bird: 1, call: 8, frog: 3, drip: 0.5, gibbon: 12 };
  }

  start() {
    if (this.started || !this.e.ready) return;
    this.started = true;
    const ctx = this.e.ctx;
    const out = this.e.buses.ambience;
    const wout = this.e.buses.weather;

    // 매미류: 대역 노이즈를 빠른 LFO로 진폭 변조
    const mkInsect = (freq, q, lfoRate, depth, gain) => {
      const src = this.e.noise('white', true);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
      const am = ctx.createGain(); am.gain.value = 1 - depth;
      const lfo = ctx.createOscillator(); lfo.frequency.value = lfoRate;
      const lg = ctx.createGain(); lg.gain.value = depth;
      lfo.connect(lg).connect(am.gain);
      // 느린 물결 (합창이 커졌다 작아졌다)
      const swell = ctx.createOscillator(); swell.frequency.value = 0.04 + Math.random() * 0.05;
      const sw = ctx.createGain(); sw.gain.value = 0.7;
      const sg = ctx.createGain(); sg.gain.value = 0.3;
      swell.connect(sg).connect(sw.gain);
      const level = ctx.createGain(); level.gain.value = gain;
      src.connect(bp).connect(am).connect(sw).connect(level).connect(out);
      src.start(0, src._offset); lfo.start(); swell.start();
      return level;
    };
    this.cicada = mkInsect(4300, 7, 42, 0.85, 0.0);
    this.cicada2 = mkInsect(5600, 9, 61, 0.7, 0.0);
    this.cricket = mkInsect(3900, 18, 7, 0.95, 0.0);

    // 숲 바탕음 (먼 웅웅거림 + 바람에 흔들리는 잎)
    const bed = this.e.noise('pink', true);
    const bedF = ctx.createBiquadFilter(); bedF.type = 'lowpass'; bedF.frequency.value = 700;
    this.bedGain = ctx.createGain(); this.bedGain.gain.value = 0.05;
    bed.connect(bedF).connect(this.bedGain).connect(out);
    bed.start(0, bed._offset);
    const leaves = this.e.noise('white', true);
    const lf = ctx.createBiquadFilter(); lf.type = 'bandpass'; lf.frequency.value = 2600; lf.Q.value = 0.5;
    this.leafGain = ctx.createGain(); this.leafGain.gain.value = 0.0;
    const gust = ctx.createOscillator(); gust.frequency.value = 0.09;
    const gg = ctx.createGain(); gg.gain.value = 0.015;
    gust.connect(gg).connect(this.leafGain.gain);
    leaves.connect(lf).connect(this.leafGain).connect(out);
    leaves.start(0, leaves._offset); gust.start();

    // 비: 쏴아 (고역) + 폭우 웅웅 (저역)
    const hiss = this.e.noise('white', true);
    const hf = ctx.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 1200;
    const hf2 = ctx.createBiquadFilter(); hf2.type = 'lowpass'; hf2.frequency.value = 9000;
    this.rainHiss = ctx.createGain(); this.rainHiss.gain.value = 0;
    hiss.connect(hf).connect(hf2).connect(this.rainHiss).connect(wout);
    hiss.start(0, hiss._offset);
    const rumble = this.e.noise('brown', true);
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 500;
    this.rainRumble = ctx.createGain(); this.rainRumble.gain.value = 0;
    rumble.connect(rf).connect(this.rainRumble).connect(wout);
    rumble.start(0, rumble._offset);
    const patter = this.e.noise('pink', true);
    const pf = ctx.createBiquadFilter(); pf.type = 'bandpass'; pf.frequency.value = 1800; pf.Q.value = 0.6;
    this.rainPatter = ctx.createGain(); this.rainPatter.gain.value = 0;
    patter.connect(pf).connect(this.rainPatter).connect(wout);
    patter.start(0, patter._offset);
  }

  /**
   * @param {number} dt
   * @param {{dawn:number,day:number,dusk:number}} tod  시간대 가중치
   */
  update(dt, tod, rain, wind, underCanopy, nearWater) {
    if (!this.started) return;
    this.tod = tod; this.rain = rain; this.wind = wind; this.underCanopy = underCanopy; this.nearWater = nearWater;
    const ctx = this.e.ctx, t = ctx.currentTime;
    const mask = 1 - 0.65 * rain;  // 비가 오면 벌레·새 소리가 묻힘
    const set = (param, v, tc = 0.8) => param.setTargetAtTime(v, t, tc);
    set(this.cicada.gain, (0.03 * tod.day + 0.02 * tod.dusk + 0.004 * tod.dawn) * mask);
    set(this.cicada2.gain, (0.012 * tod.day + 0.018 * tod.dusk) * mask);
    set(this.cricket.gain, (0.025 * tod.dusk + 0.012 * tod.dawn) * mask);
    set(this.bedGain.gain, 0.04 + 0.03 * wind);
    set(this.leafGain.gain, 0.012 + 0.03 * wind);
    set(this.rainHiss.gain, 0.09 * rain * (0.7 + 0.3 * underCanopy));
    set(this.rainRumble.gain, 0.35 * Math.max(0, rain - 0.45));
    set(this.rainPatter.gain, 0.1 * rain * underCanopy);

    // 예약된 소리들
    const T = this.timers;
    T.bird -= dt; T.call -= dt; T.frog -= dt; T.drip -= dt; T.gibbon -= dt;
    if (T.bird <= 0) {
      const rate = 0.6 * tod.dawn + 0.25 * tod.day + 0.35 * tod.dusk;
      T.bird = (1 / Math.max(0.05, rate)) * (0.5 + Math.random() * 1.5);
      if (Math.random() < mask) this._bird();
    }
    if (T.call <= 0) {
      T.call = 14 + Math.random() * 30;
      if (Math.random() < mask) this._distantCall();
    }
    if (T.gibbon <= 0) {
      T.gibbon = (tod.dawn > 0.5 ? 25 : 70) + Math.random() * 40;
      if (Math.random() < mask * (0.4 + tod.dawn)) this._gibbon();
    }
    if (T.frog <= 0) {
      T.frog = 0.4 + Math.random() * 2.5;
      const p = (0.25 + 0.75 * nearWater) * (0.3 * tod.dawn + 0.15 * tod.day + 1.0 * tod.dusk) * (1 + rain);
      if (Math.random() < p) this._frog();
    }
    if (T.drip <= 0) {
      // 비가 그친 뒤에도 잎에서 물방울이 떨어짐
      const r = Math.max(rain, 0.1);
      T.drip = 0.08 + Math.random() * (0.6 / (0.2 + r * 3));
      if (underCanopy > 0.4 && Math.random() < 0.3 + r) this._drip(r);
    }
  }

  _rand(a, b) { return a + Math.random() * (b - a); }

  _bird() {
    const e = this.e, out = e.buses.ambience;
    const t = e.now + 0.02;
    const pan = this._rand(-0.9, 0.9);
    const far = this._rand(0.3, 1);
    const g = 0.05 * far;
    const filter = { type: 'lowpass', freq: 2500 + 6000 * far };
    const kind = Math.floor(Math.random() * 5);
    if (kind === 0) {
      // 휘파람 반복
      const f0 = this._rand(1800, 3200);
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        e.tone({ t: t + i * 0.32, freq: f0, points: [[0.08, f0 * 1.25], [0.2, f0 * 0.95]], dur: 0.22, gain: g, attack: 0.02, release: 0.1, out, pan, filter });
      }
    } else if (kind === 1) {
      // 떨림 (트릴)
      const f0 = this._rand(3000, 4500);
      e.tone({ t, freq: f0, dur: this._rand(0.4, 0.9), gain: g * 0.7, attack: 0.03, vibrato: { rate: this._rand(18, 30), depth: this._rand(200, 500) }, out, pan, filter });
    } else if (kind === 2) {
      // 비둘기류 낮은 울음
      const f0 = this._rand(380, 520);
      for (let i = 0; i < 3; i++) {
        e.tone({ t: t + i * 0.55, freq: f0, points: [[0.12, f0 * 1.08], [0.32, f0 * 0.88]], dur: 0.38, gain: g * 1.2, attack: 0.05, out, pan, filter: { type: 'lowpass', freq: 1500 } });
      }
    } else if (kind === 3) {
      // 짧은 지저귐 연속
      const n = 4 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) {
        const f = this._rand(2500, 5000);
        e.tone({ t: t + i * this._rand(0.07, 0.12), freq: f, freqEnd: f * this._rand(0.7, 1.3), dur: 0.06, gain: g * 0.6, attack: 0.005, out, pan, filter });
      }
    } else {
      // 코뿔새류 거친 울음 (노이즈 + 톤)
      for (let i = 0; i < 2; i++) {
        e.burst({ t: t + i * 0.4, dur: 0.18, attack: 0.02, gain: g * 0.9, filter: 'bandpass', freq: 900, q: 4, out, pan });
        e.tone({ t: t + i * 0.4, freq: 700, freqEnd: 520, dur: 0.18, gain: g * 0.5, wave: 'sawtooth', out, pan, filter: { type: 'lowpass', freq: 1400 } });
      }
    }
  }

  _gibbon() {
    // 긴팔원숭이: 점점 빨라지며 올라가는 울음 (먼 곳)
    const e = this.e, out = e.buses.ambience;
    const t = e.now + 0.05;
    const pan = this._rand(-0.8, 0.8);
    const n = 6 + Math.floor(Math.random() * 6);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const f0 = 520 + 500 * k, f1 = 900 + 700 * k;
      const d = 0.55 - 0.35 * k;
      e.tone({ t: tt, freq: f0, points: [[d * 0.6, f1], [d, f0 * 0.9]], dur: d, gain: 0.025, attack: 0.04, out, pan, filter: { type: 'lowpass', freq: 1800 } });
      tt += d + 0.05;
    }
  }

  _distantCall() {
    // 먼 짐승 울음 / 새의 긴 울음
    const e = this.e, out = e.buses.ambience;
    const t = e.now + 0.05;
    const pan = this._rand(-1, 1);
    const f = this._rand(300, 650);
    e.tone({ t, freq: f, points: [[0.3, f * 1.5], [0.9, f * 0.7]], dur: 1.0, gain: 0.02, attack: 0.1, wave: 'triangle', out, pan, filter: { type: 'lowpass', freq: 1200 } });
    e.tone({ t: t + 1.2, freq: f * 0.9, points: [[0.3, f * 1.3], [0.8, f * 0.65]], dur: 0.9, gain: 0.015, attack: 0.1, wave: 'triangle', out, pan, filter: { type: 'lowpass', freq: 1000 } });
  }

  _frog() {
    const e = this.e, out = e.buses.ambience;
    const t = e.now + 0.02;
    const pan = this._rand(-0.9, 0.9);
    const f = this._rand(140, 320);
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      e.tone({ t: t + i * 0.18, freq: f, freqEnd: f * 0.85, dur: 0.12, gain: 0.03 * (0.4 + this.nearWater), attack: 0.01, wave: 'square', out, pan, filter: { type: 'bandpass', freq: f * 3, q: 3 } });
    }
  }

  _drip(r) {
    const e = this.e, out = e.buses.weather;
    const t = e.now;
    const f = this._rand(1500, 4500);
    e.tone({ t, freq: f, freqEnd: f * 0.6, dur: 0.04, gain: 0.02 + 0.03 * r, attack: 0.002, out, pan: this._rand(-1, 1) });
  }
}
