// 호흡 주기 — 숨소리(오디오)와 카메라 호흡 흔들림이 같은 위상을 쓴다.
export class BreathCycle {
  constructor() {
    this.phase = 0;      // 0~1 (0~0.42 들숨, 0.42~1 날숨)
    this.rate = 0.25;    // Hz
    this.intensity = 0;  // 0~1
    this.cycles = 0;
  }
  update(dt, breath) {
    this.intensity = breath;
    // 휴식 ~15회/분 → 지쳤을 때 ~50회/분
    const target = 0.25 + 0.6 * Math.pow(breath, 1.2);
    this.rate += (target - this.rate) * (1 - Math.exp(-1.5 * dt));
    const before = this.phase;
    this.phase += this.rate * dt;
    if (this.phase >= 1) { this.phase -= 1; this.cycles++; }
    this.justInhaled = before < 1 && this.phase < before; // 새 주기 시작
    this.justExhaled = before < 0.42 && this.phase >= 0.42;
  }
  /** 가슴 오르내림 (-1~1) */
  get chest() {
    const p = this.phase;
    return p < 0.42 ? Math.sin((p / 0.42) * Math.PI / 2) * 2 - 1 : Math.cos(((p - 0.42) / 0.58) * Math.PI / 2) * 2 - 1;
  }
}
