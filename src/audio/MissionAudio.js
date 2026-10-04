// =====================================================================
//  MissionAudio — 5단계 임무 소리 (모두 절차 합성, 파일 없음)
//   · 무전: 송신 키 '딸깍' → 대역 제한 잡음 (지지직, 짧게 끊기는 크래클) → 끝 '딸깍'. 목소리는 합성하지 않고 자막만.
//   · 천둥: 번개 거리만큼 늦게 — 가까우면 날카롭게 찢어지는 소리 + 긴 우르릉, 멀면 낮은 우르릉만 (저역 통과).
//   · 헬기: 회수 때 먼 곳에서 다가오는 회전익 '두두두' (날개 지나감 ~5.5Hz 로 진폭 변조된 저역 잡음 + 엔진 웅웅) — 점점 커짐.
//  모두 AudioEngine 버스로: 무전 = radio (먹먹함·잔향 없음), 천둥 = weather, 헬기 = ambience (+잔향).
// =====================================================================
export class MissionAudio {
  constructor(engine) {
    this.e = engine;
    this.heli = null;
  }

  get ready() { return !!this.e.ready; }

  /** 무전 한 번: dur 초 동안 지지직 (자막이 떠 있는 동안), kind 'intel' 이면 조금 더 거칠게 */
  radio(dur = 2.2, kind = 'progress') {
    if (!this.ready) return;
    const e = this.e, ctx = e.ctx, out = e.buses.radio, t = e.now + 0.02;
    const rough = kind === 'intel' ? 1.25 : 1;
    this._click(t, out, 1);
    // 잡음 바탕 (300~3000Hz 대역 — 무전기 스피커), 첫 0.25초는 크게 (스켈치가 열리는 소리)
    const src = e.noise('white', true);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2900;
    const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1500; pk.Q.value = 1.2; pk.gain.value = 6;
    const g = ctx.createGain();
    const end = t + 0.06 + dur;
    g.gain.setValueAtTime(0.0001, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.11 * rough, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.035 * rough, t + 0.32);
    g.gain.setValueAtTime(0.035 * rough, end - 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    // 크래클: 빠르게 흔들리는 진폭 (사각파 LFO 두 개를 섞어 불규칙하게)
    const am = ctx.createGain(); am.gain.value = 0.7;
    const l1 = ctx.createOscillator(); l1.type = 'square'; l1.frequency.value = 13 + Math.random() * 9;
    const l2 = ctx.createOscillator(); l2.type = 'square'; l2.frequency.value = 31 + Math.random() * 17;
    const lg1 = ctx.createGain(); lg1.gain.value = 0.18 * rough;
    const lg2 = ctx.createGain(); lg2.gain.value = 0.12 * rough;
    l1.connect(lg1).connect(am.gain); l2.connect(lg2).connect(am.gain);
    src.connect(hp).connect(lp).connect(pk).connect(am).connect(g).connect(out);
    src.start(t, src._offset); src.stop(end + 0.05);
    l1.start(t); l1.stop(end + 0.05); l2.start(t); l2.stop(end + 0.05);
    // 말소리 대신 웅얼거림 같은 대역 잡음 덩어리 몇 개 (멀리서 들리는 무전 음성 느낌 — 알아들을 수 없음)
    let tt = t + 0.35;
    while (tt < end - 0.3) {
      const d = 0.12 + Math.random() * 0.3;
      e.burst({ t: tt, dur: d, attack: 0.02, gain: 0.03 * rough, filter: 'bandpass', freq: 700 + Math.random() * 900, q: 3.5, out, noise: 'pink' });
      tt += d + 0.05 + Math.random() * 0.18;
    }
    this._click(end, out, 0.8);
  }

  _click(t, out, k) {
    const e = this.e;
    e.burst({ t, dur: 0.012, attack: 0.001, gain: 0.25 * k, filter: 'highpass', freq: 2500, q: 0.7, out });
    e.tone({ t, freq: 1900, freqEnd: 900, dur: 0.02, gain: 0.08 * k, attack: 0.001, wave: 'square', out });
  }

  /** 천둥: distance m, intensity 0~1 (번개는 이미 보였고, 소리는 거리/음속 뒤에 이걸 부름) */
  thunder(distance, intensity = 1) {
    if (!this.ready) return;
    const e = this.e, out = e.buses.weather, t = e.now + 0.01;
    const near = Math.max(0, Math.min(1, 1 - (distance - 300) / 1800));
    const g = (0.22 + 0.4 * near) * intensity;
    // 가까운 벼락: 찢어지는 첫 소리
    if (near > 0.55) {
      e.burst({ t, dur: 0.35, attack: 0.004, gain: g * 0.9 * near, filter: 'highpass', freq: 900, q: 0.5, out, send: 0.4 });
      e.burst({ t: t + 0.05, dur: 0.6, attack: 0.01, gain: g * 0.7, filter: 'bandpass', freq: 420, q: 0.8, out, noise: 'pink', send: 0.5 });
    }
    // 긴 우르릉 (구름 사이를 굴러가는 저음) — 여러 덩어리가 겹치며 멀어질수록 낮고 길게
    const n = 3 + Math.floor(Math.random() * 4);
    let tt = t + (near > 0.55 ? 0.15 : 0);
    const lp = 180 + 520 * near;
    for (let i = 0; i < n; i++) {
      const d = 0.8 + Math.random() * 1.6 + (1 - near) * 1.2;
      e.burst({ t: tt, dur: d, attack: 0.15 + Math.random() * 0.3, gain: g * (0.9 - i * 0.1), filter: 'lowpass', freq: lp, q: 0.6, out, noise: 'brown', send: 0.6 });
      tt += d * (0.35 + Math.random() * 0.35);
    }
  }

  /**
   * 회수 헬기: 시작하면 approach 초 동안 멀리서 다가옴 (점점 크고 밝게), 방향 bearing (rad, 월드 yaw 규약) 쪽에서.
   * stop() 으로 끝.
   */
  heliStart(approach = 40) {
    if (!this.ready || this.heli) return;
    const e = this.e, ctx = e.ctx, t = e.now + 0.05;
    const out = e.buses.ambience;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(0.5, t + approach);
    master.connect(out);
    // 회전익 '두두두': 저역 잡음을 날개 지나감 주기로 진폭 변조 (펄스처럼 날카롭게 — 사각파 + 저역 통과)
    const body = e.noise('brown', true);
    const bodyF = ctx.createBiquadFilter(); bodyF.type = 'lowpass';
    bodyF.frequency.setValueAtTime(140, t);
    bodyF.frequency.exponentialRampToValueAtTime(520, t + approach);
    const am = ctx.createGain(); am.gain.value = 0.15;
    const blade = ctx.createOscillator(); blade.type = 'sawtooth'; blade.frequency.value = 5.6;
    const bg = ctx.createGain(); bg.gain.value = 0.85;
    blade.connect(bg).connect(am.gain);
    const lvl = ctx.createGain(); lvl.gain.value = 0.9;
    body.connect(bodyF).connect(am).connect(lvl).connect(master);
    // 날개 끝 '척척' (고역 잡음, 같은 박자) — 가까워질수록 들림
    const slap = e.noise('white', true);
    const slapF = ctx.createBiquadFilter(); slapF.type = 'bandpass'; slapF.frequency.value = 1400; slapF.Q.value = 0.9;
    const sam = ctx.createGain(); sam.gain.value = 0;
    const sg = ctx.createGain(); sg.gain.value = 0.06;
    blade.connect(sg).connect(sam.gain);
    const slapLvl = ctx.createGain();
    slapLvl.gain.setValueAtTime(0.0001, t);
    slapLvl.gain.exponentialRampToValueAtTime(0.6, t + approach);
    slap.connect(slapF).connect(sam).connect(slapLvl).connect(master);
    // 엔진·변속기 웅웅 (낮은 톤 두 개)
    const eng = ctx.createOscillator(); eng.type = 'triangle'; eng.frequency.value = 92;
    const eng2 = ctx.createOscillator(); eng2.type = 'sine'; eng2.frequency.value = 184.5;
    const eg = ctx.createGain(); eg.gain.value = 0.018;
    eng.connect(eg); eng2.connect(eg);
    const ef = ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 600;
    eg.connect(ef).connect(master);
    // 잔향 (골짜기에 울림)
    const send = ctx.createGain(); send.gain.value = 0.35;
    master.connect(send).connect(e.reverbSend);
    for (const n of [body, slap]) n.start(t, n._offset);
    for (const o of [blade, eng, eng2]) o.start(t);
    this.heli = { master, nodes: [body, slap, blade, eng, eng2] };
  }

  heliStop(fade = 2) {
    const h = this.heli;
    if (!h || !this.ready) return;
    const t = this.e.now;
    h.master.gain.cancelScheduledValues(t);
    h.master.gain.setTargetAtTime(0.0001, t, fade / 3);
    for (const n of h.nodes) { try { n.stop(t + fade + 0.2); } catch { /* 이미 멈춤 */ } }
    this.heli = null;
  }
}
