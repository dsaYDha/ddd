// 소음 이벤트 버스 — 발소리·점프 착지·진흙 발 빼는 소리 등이 (위치, 반경)을 발생시킨다.
// 4단계에서 적 AI가 subscribe 해서 반경 안에 있으면 반응한다.
import { CONFIG } from '../config.js';
import { EventEmitter } from './EventEmitter.js';

export class NoiseEvents extends EventEmitter {
  constructor() {
    super();
    this.time = 0;
    this.rainIntensity = 0;   // 날씨 시스템이 갱신 (0~1)
    this.thunderMask = 0;     // 5단계: 천둥이 울리는 순간 (0~1, 날씨가 갱신) — 그 순간의 총성을 덮는다
    this.nightMask = 0;       // 6단계: 밤 개구리·벌레 소리 세기 (0~1, 임무 시계가 갱신) — 작은 소리를 가린다
    this.history = [];
    this.last = null;
  }

  /** 빗소리가 클수록 반경 감소 */
  maskFactor() {
    return 1 - CONFIG.noise.rainReduction * this.rainIntensity;
  }

  /**
   * @param {{x:number,y:number,z:number}} position
   * @param {number} baseRadius  비 감쇠 전 반경 (m)
   * @param {string} kind        'footstep' | 'land' | 'suction' | 'stance' | 'slide' ...
   * @param {object} source      발생시킨 주체 (HumanMotor 등)
   */
  emitNoise(position, baseRadius, kind, source = null, extra = null) {
    let radius = baseRadius * this.maskFactor();
    // 천둥이 겹친 총성은 멀리서 구분되지 않는다
    if (this.thunderMask > 0 && kind === 'gunshot') radius *= 1 - CONFIG.noise.thunderMask * this.thunderMask;
    // 밤 환경음이 작은 소리(발소리·풀 스치는 소리·자세 바꾸기)를 가림
    if (this.nightMask > 0 && baseRadius <= CONFIG.noise.smallRadius) radius *= 1 - CONFIG.noise.nightMask * this.nightMask;
    const evt = {
      x: position.x, y: position.y, z: position.z,
      radius,
      baseRadius, kind, source, time: this.time, ...extra,
    };
    this.history.push(evt);
    this.last = evt;
    this.emit('noise', evt);
    return evt;
  }

  /** 지정 위치에서 들리는 최근 소음 (4단계 AI용) */
  audibleAt(x, z, sinceSeconds = 1) {
    const out = [];
    for (const e of this.history) {
      if (this.time - e.time > sinceSeconds) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d <= e.radius) out.push({ event: e, distance: d });
    }
    return out;
  }

  update(dt) {
    this.time += dt;
    const keep = CONFIG.noise.historySeconds;
    while (this.history.length && this.time - this.history[0].time > keep) this.history.shift();
  }
}
