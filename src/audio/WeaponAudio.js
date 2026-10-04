// 무기 소리 (Web Audio 절차 합성) — 자기 총성, 먼 총성, 초음속 '딱', 재질별 착탄음, 기계음, 숨 참기
//  · 자기 총성: 한 표본 만에 솟는 총구 충격파 + 중역 몸통 + 저역 '쿵' + 노리쇠 소리 + 땅·나무 줄기 반사(슬랩백)
//               + 정글 잔향(Convolver: 촘촘한 산란 꼬리와 언덕 메아리 0.3~1.5초)
//  · 먼 총성: 거리/음속 만큼 늦게, 거리에 따라 작고 어둡게(숲이 고역을 먹음), 잔향 비율은 커짐
//  · 초음속 '딱': 탄이 스치는 즉시 — N파(충격파 쌍). 가까울수록 크고 짧고(=고역) 날카로움, 1m 안이면 채찍 같은 '칙'
//  · 착탄: 거리/음속 만큼 늦게 — 흙·낙엽·나무·물·진흙·바위(+도탄 휘파람)·대나무·덩굴
// 표본 단위로 모양을 잡아야 하는 파형(충격파·N파)은 고정 시드로 미리 합성해 두고(AudioBuffer),
// 나머지는 1단계 소리와 같은 burst/tone 재료로 그때그때 만든다.
import { CONFIG } from '../config.js';
import { mulberry32 } from '../core/rng.js';
import { fillNoise } from './AudioEngine.js';

// ---------------------------------------------------------------
// 합성·믹스 상수 (소리 디자인 값 — 게임 수치가 아님. 음속은 CONFIG.ballistics.speedOfSound)
// ---------------------------------------------------------------
const BANK = { seed: 0x7a3c19, ownVariants: 5, blastVariants: 3 };
// 자기 총성: gain(합성 파형 최고점 1 기준), 잔향 보내기, 발마다 재생 속도·크기 흔들림, 탄피 떨어지는 소리 확률
const OWN = { gain: 2.0, send: 0.5, rateJitter: 0.03, gainJitter: 0.08, casingChance: 0.65 };
// 먼 총성: 크기 = (refM / d)^rolloff, 저역 통과 = lpHz·(lpRefM/d)^lpExp (2단 — 숲 흡수는 고역에서 가파름),
//          잔향 보내기 = send·(d/50)^sendGrowth (최대 maxSendMul 배), boom = 멀리 가는 낮은 '쿵'
const REMOTE = { gain: 1.0, refM: 10, rolloff: 0.9, lpHz: 10000, lpRefM: 30, lpExp: 0.8, minLp: 450, send: 0.6, sendGrowth: 0.5, maxSendMul: 2.6, boom: 0.2, closeM: 25 };
// 무기 소리 성격 기본값 (CONFIG.weapons.*.sound 가 없을 때 — 1~3단계 먼 총성 그대로)
const DEFAULT_PROFILE = { rate: 1, boom: 1, lpMul: 1, crack: 1 };
// 초음속 '딱': 크기 = (refM / d)^exponent (충격파 압력 ∝ 거리^-3/4), N파 길이 baseT·d^(1/4) (Whitham — 7.62mm, 마하 2 부근)
const CRACK = { gain: 1.0, refM: 0.5, exponent: 0.75, minGain: 0.03, baseT: 0.00014, classes: [0.3, 0.7, 1.5, 3, 6, 12], zipBelow: 1, send: 0.05 };
// 착탄: 크기 = 1 / (1 + d·fall), 저역 통과 = lpHz·(lpRefM/d)^lpExp, 잔향은 멀수록 많이, 탄속 refSpeed 기준으로 세기
//       물속 바닥에 박힌 탄(underwater)은 물이 막아 둔하고 작게
const IMPACT = { gain: 0.75, fall: 0.12, lpHz: 16000, lpRefM: 8, lpExp: 0.75, minLp: 1200, send: 0.1, farSend: 0.3, farM: 60, refSpeed: 550, underwaterLp: 500, underwaterGain: 0.25 };
// 기계음: 소총은 오른쪽 어깨 → 살짝 오른쪽, 잔향은 아주 조금 (가까운 소리)
const MECH = { gain: 0.2, pan: 0.12, send: 0.03 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

export class WeaponAudio {
  /** @param {import('./AudioEngine.js').AudioEngine} engine */
  constructor(engine) {
    this.e = engine;
    this.bank = null;          // 미리 합성한 파형 (총구 충격파·N파) — 엔진 init 때 한 번 만든다
    this.muffle = 0;
    this._dt = 1 / 60;         // 최근 프레임 시간 — 프레임 안 발사 시각(timeOffset)을 살려 재생할 때의 지연
    this._last = { own: -1, blast: -1 };
    this._rate = 0;            // 최근 소리 빈도 (많이 겹치면 잔재료를 줄임)
    this._rateT = 0;
    this._jamPending = false;  // 방금 'malfunction' 소리를 냈음 — 같은 사건의 '딸깍'을 거름 (다음 update 또는 마이크로태스크에서 풀림)
    // 파형 은행은 엔진 init(사용자 클릭) 때 같이 만든다 — 게임 도중 첫 총성에서 멈칫하지 않게
    engine.whenReady?.(() => this._ensureBank());
  }

  _ensureBank() {
    if (!this.bank && this.e.ready) this.bank = buildBank(this.e.ctx);
    return this.bank;
  }

  get out() { return this.e.buses.weapons; }

  /**
   * 듣는 사람 기준 거리·좌우·뒤쪽 (yaw 규약: 0 = -Z, +면 왼쪽으로 돎 → 오른쪽 = (cos yaw, 0, -sin yaw))
   * pan 은 sin(방위각)×0.9 — 3D 거리로 나눠서 머리 위·아래 소리는 가운데로 모인다.
   */
  static spatial(listenerPos, listenerYaw, sourcePos, out = {}) {
    const dx = sourcePos.x - listenerPos.x, dy = sourcePos.y - listenerPos.y, dz = sourcePos.z - listenerPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const c = Math.cos(listenerYaw), s = Math.sin(listenerYaw);
    const side = dx * c - dz * s;          // 오른쪽 성분
    const front = -dx * s - dz * c;        // 앞쪽 성분
    out.distance = distance;
    out.pan = distance > 1e-6 ? clamp(0.9 * side / distance, -0.9, 0.9) : 0;
    out.behind = front < 0;
    return out;
  }

  /** 엔진이 준비됐는지 + 파형 은행 준비 */
  _ok() {
    return this.e.ready && !!this._ensureBank();
  }

  /** 최근 0.25초 안에 소리가 많이 겹치면 1 → 0.35 (부스러기·탄피 같은 잔재료 수를 줄여 노드 수를 제한) */
  _detail() {
    const now = this.e.now;
    this._rate = this._rate * Math.exp(-Math.max(0, now - this._rateT) / 0.25) + 1;
    this._rateT = now;
    return this._rate > 14 ? 0.35 : this._rate > 8 ? 0.65 : 1;
  }

  /** 같은 변형이 연달아 나오지 않게 고름 */
  _pick(n, key) {
    let k = Math.floor(Math.random() * n);
    if (k === this._last[key]) k = (k + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this._last[key] = k;
    return k;
  }

  // =================================================================
  // 총성
  // =================================================================
  /**
   * @param {{distance?:number, pan?:number, own?:boolean, behind?:boolean, gain?:number, timeOffset?:number}} o
   *  own: 플레이어의 소총 (거리 무시). 아니면 distance/음속 뒤에 들림.
   *  timeOffset(선택): 실제 발사가 이 프레임 끝보다 몇 초 앞이었는지 (Weapon 'shot'·Shooter 'fired' 의 timeOffset).
   *   주면 한 프레임(update 의 dt)만큼 늦추고 그 안에서 정확한 시각에 재생 — 프레임과 무관하게 연발 간격(60/rpm)이 고르다.
   */
  shot({ distance = 0, pan = 0, own = true, behind = false, gain = 1, timeOffset, pos = null, profile = null, veg = 0 } = {}) {
    if (!this._ok()) return;
    if (own) this._ownShot(pan, gain, timeOffset, profile);
    else this._remoteShot(Math.max(0, distance || 0), pan, behind, gain, pos, profile, veg);
  }

  /** 내 총성. profile 이 있으면 (5단계: 주운 적 소총) 그 무기 음높이로 — 5.56 은 더 높고 짧게 */
  _ownShot(pan, gain, timeOffset, profile = null) {
    const e = this.e, B = this.bank;
    const t = e.now + (Number.isFinite(timeOffset) ? Math.max(0, this._dt - timeOffset) : 0.002);
    const detail = this._detail();
    const k = this._pick(B.own.length, 'own');
    const rate = (profile?.rate ?? 1) * (1 + rand(-1, 1) * OWN.rateJitter);
    const g = OWN.gain * gain * (1 + rand(-1, 1) * OWN.gainJitter);
    // 스테레오 버퍼 (좌우 반사가 다름) — 팬 0 이면 좌우 그대로 통과. 잔향은 gain 뒤에서 보내므로 크기를 따라감
    e.play({ t, buffer: B.own[k], rate, gain: g, pan, out: this.out, send: OWN.send });
    if (detail > 0.5 && Math.random() < OWN.casingChance) this._casing(t + rand(0.33, 0.6), pan);
  }

  /**
   * 남의 총성. profile: 무기 소리 성격 { rate (재생 속도 = 음높이·짧기), boom (낮은 '쿵'), lpMul (밝기) } — 4단계 적 소총(5.56)은
   * 높고 짧게 '탁', 경기관총은 낮고 무겁게. veg: 사이 식생 0~1 (빽빽할수록 더 작고 어둡게 — CONFIG.audio.enemy).
   * 가까우면 (closeM 안) 날카로운 고역 '짝' 을 더해 바로 옆 총성의 공격적인 첫 순간을 살린다.
   */
  _remoteShot(d, pan, behind, gain, pos = null, profile = null, veg = 0) {
    const e = this.e, B = this.bank, R = REMOTE, P = profile ?? DEFAULT_PROFILE, EN = CONFIG.audio.enemy ?? {};
    const t = e.now + 0.002 + d / CONFIG.ballistics.speedOfSound;
    const vg = clamp(veg || 0, 0, 1);
    const att = Math.pow(R.refM / Math.max(R.refM, d), R.rolloff) * (1 - (EN.vegDamp ?? 0) * vg);
    const lp = clamp(R.lpHz * (P.lpMul ?? 1) * Math.pow(R.lpRefM / Math.max(1, d), R.lpExp) * (behind ? 0.75 : 1) * (1 - (EN.vegLowpass ?? 0) * vg), R.minLp, 18000);
    const send = R.send * clamp(Math.pow(d / 50, R.sendGrowth), 1, R.maxSendMul);
    const v = e.voice({ gain: R.gain * gain * att * (behind ? 0.85 : 1), lowpass: lp, stages: 2, pan, pos, out: this.out, send });
    e.play({ t, buffer: B.blast[this._pick(B.blast.length, 'blast')], rate: (P.rate ?? 1) * (1 + rand(-1, 1) * 0.04), out: v });
    // 저역은 숲에서 덜 흡수돼 멀리 간다 — 먼 총성의 몸통 '쿵' (무기마다 크기·음높이)
    const bf = 1 / Math.sqrt(P.rate ?? 1);
    e.tone({ t, freq: rand(66, 78) * bf, freqEnd: 40 * bf, dur: 0.42 / (P.rate ?? 1), gain: R.boom * (P.boom ?? 1) * clamp(d / 150, 0.3, 1), attack: 0.006, release: 0.4, out: v });
    if (d < R.closeM) {
      // 가까운 총성: 귀를 때리는 고역 '짝' (멀어질수록 사라짐)
      const k = 1 - d / R.closeM;
      e.burst({ t, dur: 0.025 / (P.rate ?? 1), attack: 0.0008, gain: 0.5 * k * gain, filter: 'highpass', freq: 2600 * (P.rate ?? 1), q: 0.7, out: v });
    }
  }

  /** 탄피가 정글 바닥(낙엽·흙)에 떨어지는 작은 소리 — 오른쪽으로 튀어 나감 */
  _casing(t, pan) {
    const e = this.e, out = this.out;
    const p = rand(0.9, 1.15), cp = clamp(pan + 0.35, -1, 1);
    e.tone({ t, freq: 5200 * p, freqEnd: 4900 * p, dur: 0.03, gain: 0.018, attack: 0.001, release: 0.03, pan: cp, out });
    e.burst({ t, dur: 0.02, attack: 0.001, gain: 0.03, filter: 'bandpass', freq: 2800, q: 1.2, pan: cp, out });
    if (Math.random() < 0.5) e.tone({ t: t + rand(0.07, 0.13), freq: 6100 * p, freqEnd: 5900 * p, dur: 0.02, gain: 0.01, attack: 0.001, release: 0.02, pan: cp, out });
  }

  // =================================================================
  // 초음속 '딱'
  // =================================================================
  /**
   * 탄이 스치는 순간 바로 (총성보다 먼저 — 어디서 쏘는지 헷갈리게). crack 버스 = 먹먹함을 건너뜀.
   * @param {{missDistance?:number, pan?:number, gain?:number}} o
   */
  crack({ missDistance = 3, pan = 0, gain = 1, pos = null } = {}) {
    if (!this._ok()) return;
    const e = this.e, C = CRACK;
    const d = Math.max(0.05, Number.isFinite(missDistance) ? missDistance : 3);
    const t = e.now + 0.002;
    // 가장 가까운 거리 등급의 N파 (거리 로그 기준)
    let cls = 0, best = Infinity;
    for (let i = 0; i < C.classes.length; i++) {
      const err = Math.abs(Math.log(d / C.classes[i]));
      if (err < best) { best = err; cls = i; }
    }
    const buffer = this.bank.crack[cls * 2 + (Math.random() < 0.5 ? 0 : 1)];
    const g = C.gain * gain * clamp(Math.pow(C.refM / d, C.exponent), C.minGain, 1);
    e.play({ t, buffer, gain: g, pan, pos, out: e.buses.crack, send: C.send });
    if (d < C.zipBelow) this._zip(t, d, pan, gain);
  }

  /** 1m 안을 스치면: 탄 뒤 난류가 내는 채찍 같은 '칙' (내려가는 쉭 + 휘파람) + 아주 가까우면 압력 '퍽' */
  _zip(t, d, pan, gain) {
    const e = this.e, out = e.buses.crack;
    const k = 1 - d / CRACK.zipBelow;
    const p = rand(0.9, 1.1);
    e.burst({ t, dur: 0.1, attack: 0.0015, gain: (0.16 + 0.3 * k) * gain, filter: 'bandpass', freq: 7200 * p, freqEnd: 1700 * p, sweep: 0.09, q: 2.2, pan, out });
    e.tone({ t, freq: 5400 * p, freqEnd: 1300 * p, dur: 0.085, gain: 0.05 * k * gain, attack: 0.002, release: 0.08, pan, out });
    if (d < 0.6) e.tone({ t, freq: 105, freqEnd: 45, dur: 0.05, gain: 0.1 * (1 - d / 0.6) * gain, attack: 0.002, release: 0.05, pan, out });
  }

  // =================================================================
  // 착탄
  // =================================================================
  /**
   * @param {{material?:string, distance?:number, pan?:number, ricochet?:boolean, speed?:number, behind?:boolean, underwater?:boolean, gain?:number}} o
   *  material: 'dirt'|'leaves'|'wood'|'water'|'mud'|'rock'|'bamboo'|'fiber' (+ 'body': 사람·표적에 맞은 둔탁한 소리)
   *  ricochet: Ballistics 'impact' 의 도탄 여부 (바위·물) — 바위는 아니어도 가끔 파편 휘파람
   *  speed: 착탄 속도 (m/s, 느린 탄은 작게), underwater: 물속 바닥에 박힘 (둔하고 작게)
   */
  impact({ material = 'dirt', distance = 0, pan = 0, ricochet = false, speed, behind = false, underwater = false, gain = 1, pos = null } = {}) {
    if (!this._ok()) return;
    const e = this.e, I = IMPACT;
    const d = Math.max(0, Number.isFinite(distance) ? distance : 0);
    const t = e.now + 0.003 + d / CONFIG.ballistics.speedOfSound;
    const sp = Number.isFinite(speed) ? clamp(speed / I.refSpeed, 0.35, 1.25) : 1;
    let lp = Math.max(I.minLp, I.lpHz * Math.pow(I.lpRefM / Math.max(I.lpRefM, d), I.lpExp) * (behind ? 0.75 : 1));
    let g = I.gain * gain * sp / (1 + d * I.fall);
    if (underwater) { lp = Math.min(lp, I.underwaterLp); g *= I.underwaterGain; }
    const v = e.voice({ gain: g, lowpass: lp, pan, pos, out: this.out, send: I.send + I.farSend * Math.min(1, d / I.farM) });
    const fn = IMPACTS[material] || IMPACTS.dirt;
    fn.call(this, v, t, rand(0.9, 1.1), this._detail(), !!ricochet);
  }

  /** 흩어지는 부스러기 (흙 알갱이·잎 조각·나무 조각) — n 개 짧은 대역 잡음 */
  _debris(v, t, n, spread, lo, hi, g, q = 2.5) {
    for (let i = 0; i < n; i++) {
      this.e.burst({ t: t + Math.random() * spread, dur: rand(0.004, 0.014), attack: 0.0008, gain: g * rand(0.4, 1), filter: 'bandpass', freq: rand(lo, hi), q, out: v });
    }
  }

  /** 도탄 휘파람: 비틀리며 날아가는 탄·파편 — 내려가는 음정 + 떨림 */
  _whine(v, t, p, g = 1) {
    const f0 = rand(2900, 4400) * p, f1 = f0 * rand(0.26, 0.42), dur = rand(0.32, 0.65);
    this.e.tone({ t, freq: f0, freqEnd: f1, dur, gain: 0.24 * g, attack: 0.004, release: dur * 0.9, vibrato: { rate: rand(26, 46), depth: f0 * 0.035 }, out: v });
    this.e.burst({ t, dur: dur * 0.8, attack: 0.004, gain: 0.07 * g, filter: 'bandpass', freq: f0, freqEnd: f1, sweep: dur, q: 9, out: v });
  }

  // =================================================================
  // 기계음
  // =================================================================
  /**
   * @param {'magOut'|'magIn'|'boltPull'|'boltRelease'|'dryClick'|'selector'|'magCheck'|'clearPull'|'malfunction'} kind
   * @param {{pan?:number, duration?:number, rounds?:number, gain?:number}} o  duration: magCheck·clearPull 동작 시간 (없으면 무기 데이터)
   */
  mech(kind, { pan = MECH.pan, duration, rounds, gain = 1, pos = null, distance = 0 } = {}) {
    if (!this._ok()) return;
    if (pos) {
      // 4단계: 남(적)의 탄창 교환·노리쇠 소리 — 위치(HRTF)·거리 감쇠·숲 흡수, 거리/음속 늦게
      const d = Math.max(0.5, distance);
      const lp = clamp(9000 * Math.pow(6 / Math.max(6, d), 0.8), 900, 18000);
      const v = this.e.voice({ gain: MECH.gain * 1.4 * gain / (1 + d * 0.22), lowpass: lp, pos, out: this.out, send: MECH.send + 0.15 * Math.min(1, d / 30) });
      const fn = MECHS[kind];
      if (fn) fn.call(this, v, this.e.now + 0.003 + d / CONFIG.ballistics.speedOfSound, { duration, rounds });
      return;
    }
    const fn = MECHS[kind];
    if (!fn) return;
    // 고장 순간 Weapon 은 같은 호출 안에서 'malfunction' 다음 'dryFire' {reason:'malfunction'} 을 보낸다 → 그 '딸깍'은
    // 고장 소리에 이미 들어 있어 생략. 고장 상태에서 방아쇠를 다시 당기는 '딸깍'은 그대로 (통합 쪽은 dryFire 를 전부 보내면 된다).
    // 시각(오디오 시계)이 아니라 '같은 사건'으로 판단: 다음 update(dt) 나 마이크로태스크에서 풀림 → 프레임 속도·시뮬과 무관
    if (kind === 'malfunction') {
      this._jamPending = true;
      Promise.resolve().then(() => { this._jamPending = false; });
    } else if (kind === 'dryClick' && this._jamPending) return;
    const v = this.e.voice({ gain: MECH.gain * gain, pan, out: this.out, send: MECH.send });
    fn.call(this, v, this.e.now + 0.003, { duration, rounds });
  }

  /** 강철 부품이 부딪히는 소리: 비조화 고유 진동 4개 + 짧은 딸깍 */
  _metal(v, t, g, f0, decay = 0.03) {
    const R = METAL_MODES;
    for (let k = 0; k < R.length; k++) {
      const dur = decay * (1 - 0.15 * k);
      this.e.tone({ t, freq: f0 * R[k][0] * rand(0.985, 1.015), dur, gain: g * R[k][1], attack: 0.0006, release: dur, out: v });
    }
    this.e.burst({ t, dur: 0.005, attack: 0.0004, gain: g * 0.8, filter: 'highpass', freq: 2500, q: 0.7, out: v });
  }

  /** 둔탁한 '턱' (몸통·손바닥·총몸 울림) */
  _thunk(v, t, g, f = 220, dur = 0.04) {
    this.e.tone({ t, freq: f, freqEnd: f * 0.6, dur, gain: g, attack: 0.001, release: dur, out: v });
  }

  /** 금속끼리 긁히는 소리 (탄창이 홈을 따라 미끄러짐, 노리쇠 이동) */
  _scrape(v, t, g, dur, f0, f1, q = 2.5) {
    this.e.burst({ t, dur, attack: dur * 0.3, gain: g, filter: 'bandpass', freq: f0, freqEnd: f1, sweep: dur, q, out: v });
  }

  /** 탄창 속 탄이 흔들리는 짤랑 */
  _rattle(v, t, g, n, spread) {
    for (let i = 0; i < n; i++) {
      const tt = t + Math.random() * spread;
      this.e.burst({ t: tt, dur: rand(0.004, 0.009), attack: 0.0005, gain: g * rand(0.5, 1), filter: 'bandpass', freq: rand(3200, 6200), q: 4, out: v });
      this.e.tone({ t: tt, freq: rand(2600, 4200), dur: 0.018, gain: g * 0.25, attack: 0.0006, release: 0.018, out: v });
    }
  }

  // =================================================================
  // 숨 참기
  // =================================================================
  /** 'hold': 짧고 날카로운 들숨 뒤 정적 / 'release': 참았던 숨을 몰아쉬는 헐떡임 (몸 버스) */
  breath(kind) {
    if (!this._ok()) return;
    const e = this.e, out = e.buses.body;
    const t = e.now + 0.005;
    if (kind === 'hold') {
      // 코·입으로 빠르게 들이쉼 → 성대가 닫히며 멈춤
      e.burst({ t, dur: 0.24, attack: 0.16, gain: 0.3, filter: 'bandpass', freq: 1500, freqEnd: 2500, sweep: 0.3, q: 1.1, out });
      e.burst({ t, dur: 0.2, attack: 0.15, gain: 0.05, filter: 'highpass', freq: 3500, q: 0.6, out });
      e.tone({ t: t + 0.33, freq: 190, freqEnd: 150, dur: 0.025, gain: 0.04, attack: 0.002, release: 0.02, out, filter: { type: 'bandpass', freq: 700, q: 1.5 } });
    } else if (kind === 'release') {
      // '하아—' 크게 내쉼 (목소리가 살짝 섞임) → 급한 들숨 → 한 번 더 내쉼
      e.burst({ t, dur: 0.72, attack: 0.025, gain: 0.42, filter: 'bandpass', freq: 1250, freqEnd: 620, sweep: 0.72, q: 0.9, noise: 'pink', out });
      e.burst({ t, dur: 0.5, attack: 0.03, gain: 0.12, filter: 'lowpass', freq: 520, q: 1, noise: 'brown', out });
      e.tone({ t, freq: 135, freqEnd: 100, dur: 0.45, gain: 0.022, wave: 'sawtooth', attack: 0.03, out, filter: { type: 'bandpass', freq: 750, q: 2 } });
      e.burst({ t: t + 0.78, dur: 0.3, attack: 0.12, gain: 0.26, filter: 'bandpass', freq: 1900, freqEnd: 2600, sweep: 0.3, q: 1.1, out });
      e.burst({ t: t + 0.78, dur: 0.26, attack: 0.1, gain: 0.06, filter: 'highpass', freq: 3600, q: 0.6, out });
      e.burst({ t: t + 1.15, dur: 0.5, attack: 0.04, gain: 0.24, filter: 'bandpass', freq: 1100, freqEnd: 700, sweep: 0.5, q: 0.9, noise: 'pink', out });
    }
  }

  /** 제압 먹먹함 0~1 — 세상 소리(발소리·환경·날씨·몸·무기) 저역 통과. '딱'(crack 버스)은 그대로 */
  setMuffle(amount) {
    this.muffle = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
    if (this.e.ready) this.e.setMuffle(this.muffle);
  }

  /** 매 프레임: 프레임 시간 기억 (timeOffset 재생용) + 혹시 은행이 아직 없으면 만듦 (엔진 init 전에 만든 경우의 안전망) */
  update(dt) {
    this._jamPending = false;
    if (Number.isFinite(dt) && dt > 0) this._dt = clamp(dt, 1 / 240, 0.05);
    if (!this.bank) this._ensureBank();
  }
}

// 강철 부품의 비조화 진동 비율·상대 크기 (자유단 막대 고유 진동에 가까운 비율)
const METAL_MODES = [[1, 1], [1.53, 0.6], [2.19, 0.42], [2.93, 0.28]];

// ---------------------------------------------------------------
// 재질별 착탄음 (this = WeaponAudio, v = 거리·팬·잔향이 걸린 voice 입력, p = 음정 흔들림, k = 잔재료 비율)
// ---------------------------------------------------------------
const IMPACTS = {
  dirt(v, t, p, k) {
    const e = this.e;
    e.burst({ t, dur: 0.012, attack: 0.0004, gain: 0.7, filter: 'bandpass', freq: 3000 * p, q: 0.6, out: v });           // 탁: 탄이 흙을 때림
    e.tone({ t, freq: 190 * p, freqEnd: 70, dur: 0.07, gain: 0.4, attack: 0.001, release: 0.07, out: v });                 // 퍽: 흙이 밀려남
    e.burst({ t: t + 0.002, dur: 0.11, attack: 0.004, gain: 0.32, filter: 'lowpass', freq: 1700 * p, q: 0.8, noise: 'pink', out: v });  // 흙 튐
    e.burst({ t: t + 0.004, dur: 0.08, attack: 0.006, gain: 0.22, filter: 'bandpass', freq: 2300 * p, q: 0.6, out: v });  // 흙 알갱이가 흩뿌려지는 '쏴'
    this._debris(v, t + 0.05, Math.round(6 * k), 0.4, 1800, 5200, 0.09);                                                    // 흙 알갱이가 떨어짐
  },
  leaves(v, t, p, k) {
    const e = this.e;
    e.burst({ t, dur: 0.005, attack: 0.0004, gain: 0.4, filter: 'bandpass', freq: 3200 * p, q: 0.8, out: v });
    e.tone({ t, freq: 150 * p, freqEnd: 60, dur: 0.05, gain: 0.35, attack: 0.001, release: 0.05, out: v });
    e.burst({ t, dur: 0.08, attack: 0.002, gain: 0.4, filter: 'bandpass', freq: 3600 * p, q: 0.8, out: v });                // 잎이 찢김
    e.burst({ t, dur: 0.03, attack: 0.001, gain: 0.15, filter: 'highpass', freq: 6000, q: 0.7, out: v });
    this._debris(v, t + 0.01, Math.round(9 * k), 0.35, 2000, 8000, 0.08, 2);                                               // 잎 조각
    e.burst({ t: t + 0.08, dur: 0.35, attack: 0.12, gain: 0.06, filter: 'bandpass', freq: 2600, q: 0.9, out: v });         // 조각이 내려앉음
  },
  wood(v, t, p, k) {
    const e = this.e;
    e.burst({ t, dur: 0.012, attack: 0.0004, gain: 0.85, filter: 'bandpass', freq: 1900 * p, q: 1.8, out: v });            // 딱: 줄기를 때림
    e.tone({ t, freq: 430 * p, freqEnd: 390 * p, dur: 0.09, gain: 0.5, attack: 0.0008, release: 0.09, out: v });          // 통 울림
    e.tone({ t, freq: 1120 * p, freqEnd: 1060 * p, dur: 0.045, gain: 0.2, attack: 0.0008, release: 0.045, out: v });
    e.burst({ t: t + 0.001, dur: 0.025, attack: 0.0005, gain: 0.45, filter: 'highpass', freq: 3200, q: 0.7, out: v });      // 쪼개짐
    this._debris(v, t + 0.01, Math.round(5 * k), 0.18, 2500, 7000, 0.07, 3);                                               // 나무 조각
  },
  water(v, t, p, k, ricochet) {
    const e = this.e;
    e.burst({ t, dur: 0.014, attack: 0.0004, gain: 0.55, filter: 'highpass', freq: 2400, q: 0.7, out: v });                // 칙: 수면을 뚫음
    e.tone({ t, freq: 950 * p, freqEnd: 280, dur: 0.06, gain: 0.35, attack: 0.001, release: 0.06, out: v });                // 퐁: 공기 구멍
    e.burst({ t: t + 0.004, dur: 0.22, attack: 0.008, gain: 0.32, filter: 'bandpass', freq: 3000 * p, freqEnd: 1400, sweep: 0.22, q: 0.8, out: v });  // 물기둥
    e.burst({ t: t + 0.004, dur: 0.12, attack: 0.006, gain: 0.22, filter: 'lowpass', freq: 900, q: 1, noise: 'pink', out: v });
    const drops = Math.round((4 + Math.random() * 3) * k);
    for (let i = 0; i < drops; i++) {
      e.tone({ t: t + rand(0.12, 0.5), freq: rand(1600, 4000), freqEnd: rand(900, 1500), dur: rand(0.02, 0.04), gain: 0.05, attack: 0.001, out: v });
    }
    if (ricochet) this._whine(v, t + 0.006, p * 0.85, 0.7);                                                               // 물수제비처럼 튕김
  },
  mud(v, t, p, k) {
    const e = this.e;
    e.burst({ t, dur: 0.1, attack: 0.002, gain: 0.55, filter: 'bandpass', freq: 900 * p, freqEnd: 280, sweep: 0.1, q: 3, noise: 'pink', out: v });  // 철퍽
    e.tone({ t, freq: 130 * p, freqEnd: 50, dur: 0.08, gain: 0.5, attack: 0.001, release: 0.08, out: v });
    e.burst({ t, dur: 0.035, attack: 0.0006, gain: 0.4, filter: 'highpass', freq: 1600, q: 0.7, out: v });                 // 젖은 표면을 때림
    this._debris(v, t + 0.05, Math.round(4 * k), 0.25, 500, 1400, 0.08, 3);                                                // 진흙 방울
  },
  rock(v, t, p, k, ricochet) {
    const e = this.e;
    e.burst({ t, dur: 0.012, attack: 0.0003, gain: 0.9, filter: 'highpass', freq: 2600, q: 0.7, out: v });                 // 쨍: 돌이 깨짐
    e.tone({ t, freq: 2600 * p, dur: 0.05, gain: 0.18, attack: 0.0005, release: 0.05, out: v });
    e.tone({ t, freq: 3900 * p, dur: 0.035, gain: 0.12, attack: 0.0005, release: 0.035, out: v });
    e.tone({ t, freq: 5700 * p, dur: 0.025, gain: 0.08, attack: 0.0005, release: 0.025, out: v });
    e.tone({ t, freq: 300 * p, freqEnd: 150, dur: 0.03, gain: 0.2, attack: 0.001, release: 0.03, out: v });
    this._debris(v, t + 0.02, Math.round(6 * k), 0.3, 2500, 7000, 0.08, 3);                                                // 돌가루·파편
    // 도탄이면 반드시, 아니어도 깨진 파편이 휘파람을 낼 때가 있다
    if (ricochet || Math.random() < 0.35) this._whine(v, t + 0.01, p, ricochet ? 1 : 0.6);
  },
  bamboo(v, t, p, k) {
    const e = this.e;
    e.burst({ t, dur: 0.04, attack: 0.0005, gain: 0.75, filter: 'bandpass', freq: 950 * p, q: 6, out: v });                // 똑: 속 빈 마디
    e.tone({ t, freq: 700 * p, freqEnd: 650 * p, dur: 0.12, gain: 0.35, attack: 0.0008, release: 0.12, out: v });          // 통 울림
    e.tone({ t, freq: 1900 * p, freqEnd: 1820 * p, dur: 0.05, gain: 0.15, attack: 0.0008, release: 0.05, out: v });
    e.burst({ t: t + 0.0015, dur: 0.02, attack: 0.0004, gain: 0.35, filter: 'highpass', freq: 3600, q: 0.7, out: v });     // 쪼개짐
    e.burst({ t: t + 0.02, dur: 0.28, attack: 0.03, gain: 0.08, filter: 'bandpass', freq: 2300, q: 1.2, out: v });         // 대나무 숲이 덜그럭
    this._debris(v, t + 0.01, Math.round(3 * k), 0.15, 2500, 6000, 0.06, 3);
  },
  fiber(v, t, p, k) {
    const e = this.e;
    e.tone({ t, freq: 220 * p, freqEnd: 90, dur: 0.05, gain: 0.35, attack: 0.001, release: 0.05, out: v });                 // 퍽: 덩굴·고사리 줄기
    e.burst({ t, dur: 0.07, attack: 0.003, gain: 0.4, filter: 'bandpass', freq: 1500 * p, freqEnd: 3300 * p, sweep: 0.07, q: 1.2, out: v });  // 섬유가 찢김
    this._debris(v, t + 0.005, Math.round(5 * k), 0.12, 2000, 5000, 0.07, 2);
    e.burst({ t: t + 0.03, dur: 0.3, attack: 0.05, gain: 0.07, filter: 'bandpass', freq: 3000, q: 0.9, out: v });          // 잎이 흔들림
  },
  body(v, t, p) {
    const e = this.e;
    e.tone({ t, freq: 140 * p, freqEnd: 60, dur: 0.07, gain: 0.5, attack: 0.001, release: 0.07, out: v });                 // 둔탁한 '퍽'
    e.burst({ t, dur: 0.05, attack: 0.002, gain: 0.4, filter: 'lowpass', freq: 1200, q: 0.8, noise: 'pink', out: v });
    e.burst({ t, dur: 0.02, attack: 0.001, gain: 0.15, filter: 'bandpass', freq: 2500, q: 1, out: v });                    // 옷감
  },
};

// ---------------------------------------------------------------
// 기계음 (this = WeaponAudio, v = voice 입력)
// ---------------------------------------------------------------
const reloadData = () => CONFIG.weapons[CONFIG.weapons.default]?.reload ?? {};

const MECHS = {
  // 5단계: 낱발 한 발을 탄창에 눌러 넣음 — 탄이 입술을 지나며 '딸깍', 스프링이 눌리는 짧은 긁힘
  roundIn(v, t) {
    const p = rand(0.94, 1.06);
    this._scrape(v, t, 0.07, 0.045, 2400 * p, 3400 * p, 3);
    this._metal(v, t + 0.04, 0.22, 3600 * p, 0.012);
    this._thunk(v, t + 0.045, 0.05, 520 * p, 0.02);
  },
  magOut(v, t, o) {
    this._metal(v, t, 0.35, 3200, 0.018);                       // 탄창 멈치 누름
    this._scrape(v, t + 0.03, 0.22, 0.13, 1600, 900, 2);        // 홈에서 빠져나옴
    this._thunk(v, t + 0.05, 0.25, 260, 0.05);
    this._metal(v, t + 0.05, 0.2, 1500, 0.03);
    if (o.rounds === undefined || o.rounds > 0) this._rattle(v, t + 0.15, 0.12, 3, 0.08);
  },
  magIn(v, t) {
    this._scrape(v, t, 0.2, 0.09, 1000, 1700, 2);               // 앞쪽을 걸고 밀어 넣음
    this._metal(v, t + 0.08, 0.25, 1800, 0.02);
    this._metal(v, t + 0.15, 0.6, 1250, 0.045);                 // 철컥: 멈치에 걸림
    this._thunk(v, t + 0.15, 0.5, 190, 0.05);
    this._rattle(v, t + 0.17, 0.08, 2, 0.05);
  },
  boltPull(v, t) {
    this._metal(v, t, 0.12, 2600, 0.01);                        // 장전 손잡이를 잡음
    this._scrape(v, t + 0.01, 0.3, 0.1, 1300, 2900, 3);         // 노리쇠가 뒤로
    this.e.tone({ t: t + 0.01, freq: 700, freqEnd: 1100, dur: 0.1, gain: 0.03, wave: 'sawtooth', attack: 0.02, out: v, filter: { type: 'bandpass', freq: 1800, q: 4 } });  // 복좌 용수철
    this._metal(v, t + 0.11, 0.45, 2000, 0.035);                // 끝에 닿음
    this._thunk(v, t + 0.11, 0.25, 320, 0.03);
  },
  boltRelease(v, t) {
    this._metal(v, t, 0.15, 2800, 0.01);                        // 손을 놓음
    this._scrape(v, t + 0.005, 0.32, 0.035, 2600, 1500, 2.5);   // 용수철 힘으로 앞으로
    this._metal(v, t + 0.04, 0.85, 1150, 0.05);                 // 철컥: 탄을 밀어 넣고 잠김
    this._thunk(v, t + 0.04, 0.7, 150, 0.06);
    this.e.burst({ t: t + 0.04, dur: 0.04, attack: 0.001, gain: 0.3, filter: 'lowpass', freq: 600, q: 0.8, noise: 'pink', out: v });
    this._metal(v, t + 0.045, 0.12, 3400, 0.08);
  },
  dryClick(v, t) {
    this._metal(v, t, 0.45, 2700, 0.015);                       // 딸깍: 공이치기가 빈 약실을 침
    this._thunk(v, t, 0.15, 900, 0.012);
    this._metal(v, t + 0.05, 0.12, 3900, 0.008);                // 방아쇠가 돌아옴
  },
  selector(v, t) {
    this._metal(v, t, 0.55, 2300, 0.03);                        // 조정간 '철컥' (이 계열 소총은 유난히 크다)
    this._thunk(v, t, 0.18, 420, 0.02);
    this._metal(v, t + 0.022, 0.3, 3300, 0.015);                // 멈춤쇠
  },
  magCheck(v, t, o) {
    const D = o.duration ?? reloadData().magCheck ?? 1.5;
    this._metal(v, t + 0.06, 0.25, 3200, 0.015);                // 멈치
    this._scrape(v, t + 0.1, 0.12, 0.1, 1500, 1000, 2);         // 반쯤 뽑음
    this._thunk(v, t + 0.2, 0.15, 260, 0.04);
    this._rattle(v, t + D * 0.32, 0.1, 3, 0.05);                // 손으로 무게를 가늠 — 탄이 흔들림
    this._rattle(v, t + D * 0.46, 0.08, 2, 0.04);
    this._rattle(v, t + D * 0.57, 0.06, 2, 0.04);
    this._scrape(v, t + D * 0.74, 0.12, 0.09, 1000, 1600, 2);   // 다시 끼움
    this._metal(v, t + D * 0.8, 0.45, 1300, 0.04);
    this._thunk(v, t + D * 0.8, 0.35, 190, 0.05);
  },
  clearPull(v, t, o) {
    // 고장 해결 시작: 탄창 바닥을 손바닥으로 치고 장전 손잡이를 잡음 (노리쇠 소리는 boltPull/boltRelease 이벤트가 냄)
    const R = reloadData();
    const D = o.duration ?? R.clear ?? 1.5;
    this._thunk(v, t + 0.04, 0.4, 170, 0.05);
    this.e.burst({ t: t + 0.04, dur: 0.04, attack: 0.001, gain: 0.25, filter: 'lowpass', freq: 900, q: 0.8, out: v });
    this._metal(v, t + 0.04, 0.25, 1400, 0.03);
    // 노리쇠를 당길 때 튀어나간 불발탄이 바닥에 떨어짐 (탄피보다 무거운 '툭')
    const drop = t + D * (R.clearTimeline?.boltPull ?? 0.42) + 0.32;
    this._thunk(v, drop, 0.12, 600, 0.02);
    this.e.tone({ t: drop, freq: 4200, freqEnd: 4000, dur: 0.04, gain: 0.04, attack: 0.001, release: 0.04, out: v });
    this.e.tone({ t: drop + 0.09, freq: 6100, dur: 0.03, gain: 0.02, attack: 0.001, release: 0.03, out: v });
  },
  malfunction(v, t) {
    this._metal(v, t, 0.4, 1700, 0.02);                         // 둔한 '철컥' — 쏘아지지 않음
    this._thunk(v, t, 0.35, 330, 0.03);
    this._scrape(v, t + 0.005, 0.06, 0.04, 2200, 1600, 1.5);    // 노리쇠가 덜 닫힌 거친 느낌
  },
};

// ---------------------------------------------------------------
// 파형 은행 (고정 시드 — 같은 소리 재료, 1단계 Math.random 순서도 건드리지 않음)
// ---------------------------------------------------------------
function buildBank(ctx) {
  const sr = ctx.sampleRate;
  const rnd = mulberry32(BANK.seed);
  const bank = { own: [], blast: [], crack: [] };
  for (let i = 0; i < BANK.ownVariants; i++) {
    const dry = synthBlast(sr, rnd);
    bank.own.push(toBuffer(ctx, synthOwn(sr, rnd, dry)));
    if (i < BANK.blastVariants) bank.blast.push(toBuffer(ctx, [normalizePeak(dry, 1)]));
  }
  for (const d of CRACK.classes) {
    for (let i = 0; i < 2; i++) bank.crack.push(toBuffer(ctx, [synthCrack(sr, rnd, d)]));
  }
  return bank;
}

function toBuffer(ctx, chans) {
  const buf = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  for (let c = 0; c < chans.length; c++) buf.getChannelData(c).set(chans[c]);
  return buf;
}

function normalizePeak(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** RBJ 바이쿼드 계수 (q 는 일반 Q) — 미리 합성용 */
function biquad(type, f, q, sr) {
  const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }   // bandpass (최고점 0dB)
  const a0 = 1 + al;
  return [b0 / a0, b1 / a0, b2 / a0, -2 * cs / a0, (1 - al) / a0];
}

function filterInPlace(x, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c[0] * x0 + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

function onePoleLP(x, fc, sr) {
  const a = 1 - Math.exp(-2 * Math.PI * fc / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}

/**
 * 잡음 층: 필터 → 단위 RMS 로 맞춤 → 포락선(직선 상승 + 지수 감쇠, tau2 가 있으면 두 기울기) × gain 을 out 의 start(s) 부터 더함.
 * o: { start, dur, tau, tau2, mix2 (두 번째 감쇠의 비율), attack, gain, lp, hp, bp: [f, q] }
 */
function noiseLayer(out, sr, rnd, o) {
  const i0 = Math.floor((o.start ?? 0) * sr);
  const n = Math.min(out.length - i0, Math.floor(o.dur * sr));
  if (n <= 0) return;
  const x = fillNoise(new Float32Array(n), (rnd() * 4294967296) | 0);
  if (o.hp) filterInPlace(x, biquad('highpass', o.hp, 0.707, sr));
  if (o.lp) { filterInPlace(x, biquad('lowpass', o.lp, 0.707, sr)); filterInPlace(x, biquad('lowpass', o.lp, 0.707, sr)); }
  if (o.bp) filterInPlace(x, biquad('bandpass', o.bp[0], o.bp[1], sr));
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  const norm = o.gain / Math.sqrt(s / n + 1e-20);
  const ka = 1 / Math.max(1, (o.attack ?? 0.0002) * sr);
  const k1 = Math.exp(-1 / (o.tau * sr)), k2 = o.tau2 ? Math.exp(-1 / (o.tau2 * sr)) : 0;
  const m2 = o.tau2 ? (o.mix2 ?? 0.3) : 0;
  let e1 = 1 - m2, e2 = m2;
  const fade = Math.max(1, Math.floor(0.005 * sr)), fadeFrom = n - fade;   // 끝 5ms 는 0 으로 — 잘린 자리에서 딸깍 소리가 나지 않게
  for (let i = 0; i < n; i++) {
    const f = i < fadeFrom ? 1 : (n - i) / fade;
    out[i0 + i] += x[i] * norm * Math.min(1, i * ka) * (e1 + e2) * f;
    e1 *= k1; e2 *= k2;
  }
}

/** 총구 충격파 (Friedlander 파형): p(t) = A(1 - t/T)·e^(-b·t/T) — 한 표본 만에 솟고 짧은 음압 구간이 따라옴 */
function friedlander(out, start, A, T, b, sr) {
  const i0 = Math.floor(start * sr), n = Math.min(out.length - i0, Math.floor(T * 14 * sr));
  const k = Math.exp(-b / (T * sr));
  let e = 1;
  for (let i = 0; i < n; i++) {
    out[i0 + i] += A * (1 - i / (sr * T)) * e;
    e *= k;
  }
}

/**
 * 마른 총성 (총구 옆 1m 남짓): 충격파 + 가스 분출 고역 + 중역 몸통('탕') + 저역 '쿵'.
 * 에너지 비율(첫 0.1초) 목표: 저역(<250Hz) 약 1/4, 중역 몸통이 가장 크고, 2kHz 이상도 충분히 — 작은 스피커에서도 날카롭게
 */
function synthBlast(sr, rnd) {
  const out = new Float32Array(Math.floor(0.32 * sr));
  const T = 0.0007 * (0.85 + 0.3 * rnd());
  friedlander(out, 0, 1, T, 1.3, sr);
  friedlander(out, 0.00025 + 0.0003 * rnd(), 0.4, T * 0.6, 1.3, sr);      // 가스가 뒤따라 터지는 2·3차 충격
  friedlander(out, 0.001 + 0.0007 * rnd(), 0.22, T * 0.5, 1.3, sr);
  noiseLayer(out, sr, rnd, { dur: 0.015, tau: 0.0022, hp: 1500, gain: 0.5 });                                       // 가스 분출 '치직'
  noiseLayer(out, sr, rnd, { dur: 0.12, tau: 0.004, tau2: 0.02, mix2: 0.35, bp: [1150 * (0.9 + 0.2 * rnd()), 0.75], gain: 0.7, attack: 0.0003 });  // '탕' 몸통
  noiseLayer(out, sr, rnd, { dur: 0.05, tau: 0.006, bp: [2900 * (0.9 + 0.2 * rnd()), 1.0], gain: 0.45, attack: 0.0002 });
  noiseLayer(out, sr, rnd, { dur: 0.08, tau: 0.012, bp: [520 * (0.9 + 0.2 * rnd()), 0.9], gain: 0.35, attack: 0.0004 });   // 낮은 몸통 (총열·가스)
  // '쿵': 내려가는 사인 (가스 팽창·가슴 울림) + 저역 잡음
  const f0 = 115 + 20 * rnd(), f1 = 50 + 8 * rnd();
  const kg = Math.exp(-1 / (0.025 * sr)), kd = Math.exp(-1 / (0.045 * sr)), ka = Math.exp(-1 / (0.0015 * sr));
  let ph = rnd() * 0.5, glide = 1, dec = 1, att = 1;
  for (let i = 0, nb = Math.min(out.length, Math.floor(0.25 * sr)); i < nb; i++) {     // 0.25초면 -60dB 아래
    ph += 2 * Math.PI * (f1 + (f0 - f1) * glide) / sr;
    out[i] += 0.17 * Math.sin(ph) * (1 - att) * dec;
    glide *= kg; dec *= kd; att *= ka;
  }
  noiseLayer(out, sr, rnd, { dur: 0.25, tau: 0.06, lp: 240, gain: 0.085, attack: 0.002 });
  return out;
}

/** 자기 총성 (스테레오): 마른 총성 + 땅 반사 + 좌우가 다른 나무 줄기 반사(슬랩백) + 노리쇠 왕복 소리 */
function synthOwn(sr, rnd, dry) {
  const n = Math.floor(0.36 * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const mix = (dst, src, delay, g) => {
    const i0 = Math.round(delay * sr);
    for (let i = 0; i + i0 < n && i < src.length; i++) dst[i + i0] += src[i] * g;
  };
  mix(L, dry, 0, 1); mix(R, dry, 0, 1);
  // 반사는 마른 총성의 앞부분만 쓴다 (그 뒤는 반사 크기에서 -40dB 아래 — 합성 시간 절약)
  const head = (len) => dry.subarray(0, Math.min(dry.length, Math.floor(len * sr))).slice();
  // 땅 반사 (총구 높이 ~1.4m, 경로 차 ~2.4m → 약 7ms), 흙·낙엽이 고역을 조금 먹음
  const ground = onePoleLP(head(0.2), 3500, sr);
  mix(L, ground, 0.0068, 0.32); mix(R, ground, 0.0071, 0.32);
  // 나무 줄기 반사: 어두운 정도가 다른 사본 3개 중 골라 22~110ms 에 흩뿌림 (좌우 따로 — 둘러싸인 느낌)
  const tones = [onePoleLP(head(0.15), 1800, sr), onePoleLP(head(0.15), 2800, sr), onePoleLP(head(0.15), 4200, sr)];
  for (const ch of [L, R]) {
    for (let k = 0; k < 6; k++) {
      const delay = 0.022 + 0.09 * Math.pow(rnd(), 0.8);
      const g = 0.17 * Math.exp(-(delay - 0.022) / 0.05) * (0.5 + 0.5 * rnd());
      mix(ch, tones[Math.floor(rnd() * 3)], delay, g);
    }
  }
  // 노리쇠: 잠금 풀림(9ms) → 뒤로 끝까지(55ms) → 앞으로 닫힘(95ms) — 총성에 묻히지만 꼬리에서 '철컥'이 들림
  //  감쇠 사인은 점화식 y[n] = 2r·cos(w)·y[n-1] - r²·y[n-2] (표본마다 sin/exp 없이)
  const metal = (t0, g, f0, decay) => {
    const i0 = Math.round(t0 * sr), len = Math.min(n - i0, Math.floor(decay * 5 * sr));
    for (let m = 0; m < METAL_MODES.length; m++) {
      const w = 2 * Math.PI * f0 * METAL_MODES[m][0] / sr;
      const r = Math.exp(-1 / (decay * (1 - 0.15 * m) * sr));
      const A = g * 0.6 * METAL_MODES[m][1], ph = rnd() * Math.PI * 2;
      const c2 = 2 * r * Math.cos(w), r2 = r * r;
      let y2 = A * Math.sin(ph), y1 = A * r * Math.sin(w + ph);
      L[i0] += y2; R[i0] += y2 * 0.92;
      L[i0 + 1] += y1; R[i0 + 1] += y1 * 0.92;
      for (let i = 2; i < len; i++) {
        const y = c2 * y1 - r2 * y2;
        y2 = y1; y1 = y;
        L[i0 + i] += y; R[i0 + i] += y * 0.92;
      }
    }
    // 부딪히는 순간의 딸깍 (1.5ms 잡음)
    const clickLen = Math.min(n - i0, Math.floor(0.0015 * sr));
    const click = fillNoise(new Float32Array(clickLen), (rnd() * 4294967296) | 0);
    const kc = Math.exp(-1 / (0.0003 * sr));
    let ec = g;
    for (let i = 0; i < clickLen; i++) { L[i0 + i] += click[i] * ec; R[i0 + i] += click[i] * ec * 0.92; ec *= kc; }
  };
  metal(0.009, 0.02, 2600 + 300 * rnd(), 0.006);
  metal(0.055 + 0.006 * rnd(), 0.05, 1900 + 250 * rnd(), 0.012);
  metal(0.095 + 0.008 * rnd(), 0.07, 1350 + 200 * rnd(), 0.018);
  const peak = Math.max(maxAbs(L), maxAbs(R));
  for (let i = 0; i < n; i++) { L[i] /= peak; R[i] /= peak; }
  return [L, R];
}

function maxAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/** N파 (초음속 충격파 쌍): 앞 충격에서 +A 로 솟고 직선으로 -A 까지 내려간 뒤 뒤 충격에서 0 — 8배 과표본으로 계단 완화 */
function nwave(out, start, A, T, sr) {
  const OS = 8;
  const i0 = Math.floor(start * sr), n = Math.ceil(T * sr) + 2;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < OS; k++) {
      const t = (i + (k + 0.5) / OS) / sr - (start - i0 / sr);
      if (t >= 0 && t <= T) s += 1 - 2 * t / T;
    }
    out[i0 + i] += A * s / OS;
  }
}

/** 초음속 '딱' (빗나간 거리 d 등급): N파 + 땅 반사 + 나무 줄기 반사(자글거리는 꼬리) + 난류 '쉭' */
function synthCrack(sr, rnd, d) {
  const out = new Float32Array(Math.floor(0.09 * sr));
  const T = CRACK.baseT * Math.pow(d, 0.25);
  const t0 = 0.0005;
  nwave(out, t0, 1, T, sr);
  // 땅 반사: 1.5~4ms 뒤, 낙엽 바닥이 고역을 먹음
  const g = new Float32Array(out.length);
  nwave(g, t0 + 0.0015 + 0.0025 * rnd(), 0.55, T * 1.15, sr);
  onePoleLP(g, 6000, sr);
  // 줄기 반사: 5~60ms 에 흩어진 작은 '딱'들
  const r = new Float32Array(out.length);
  for (let k = 0; k < 14; k++) {
    const dt = 0.005 + 0.055 * Math.pow(rnd(), 1.3);
    nwave(r, t0 + dt, 0.45 * Math.exp(-dt / 0.02) * (0.4 + 0.6 * rnd()) * (rnd() < 0.8 ? 1 : -1), T * (1 + 0.3 * rnd()), sr);
  }
  onePoleLP(r, 9000, sr);
  for (let i = 0; i < out.length; i++) out[i] += g[i] + r[i];
  noiseLayer(out, sr, rnd, { start: t0, dur: 0.035, tau: 0.006, hp: 3500, gain: 0.12 });
  return normalizePeak(out, 1);
}
