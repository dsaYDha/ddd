// F3 디버그 오버레이 — 실제 상태 값을 그대로 보여준다
import { CONFIG } from '../config.js';
import { surfaceLabel, surfaceKey } from '../world/Surfaces.js';

const GAIT_LABEL = { idle: '정지', walk: '걷기', sprint: '달리기', quiet: '조용히 걷기', crouch: '앉아 이동', prone: '포복' };
const STANCE_LABEL = { stand: '서기', crouch: '앉기', prone: '엎드리기' };

export class DebugOverlay {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', '<pre id="debug"></pre>');
    this.el = root.querySelector('#debug');
    this.visible = false;
    this.timer = 0;
    this.frames = 0;
    this.frameTime = 0;
    this.fps = 0;
    this.ms = 0;
    this.el.style.display = 'none';
  }

  toggle(v = !this.visible) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  /** 매 프레임 호출 (FPS 집계), 0.125초마다 텍스트 갱신 */
  update(dt, info) {
    // FPS는 실제 시간으로 측정 (시뮬레이션 dt는 0.1초로 잘림)
    const now = performance.now();
    if (this._last !== undefined) this.frameTime += (now - this._last) / 1000;
    this._last = now;
    this.frames++;
    this.timer += dt;
    if (this.frameTime >= 0.5) {
      this.fps = this.frames / this.frameTime;
      this.ms = (this.frameTime / this.frames) * 1000;
      this.frames = 0;
      this.frameTime = 0;
    }
    if (!this.visible || this.timer < 0.125) return;
    this.timer = 0;
    this.el.textContent = this._text(info);
  }

  _text(i) {
    const m = i.motor;
    const p = m.position;
    const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2);
    const yawDeg = ((-i.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const caps = m.caps;
    const restr = m.restrictions.size ? [...m.restrictions.keys()].join(', ') + ` (서기 ${caps.canStand ? 'O' : 'X'}, 앉기 ${caps.canCrouch ? 'O' : 'X'}, 속도 ×${caps.maxSpeedMultiplier})` : '없음';
    const net = m.regenRate - m.drainRate;
    const ray = i.rays;
    const lines = [
      `FPS ${f1(this.fps)} (${f1(this.ms)} ms)   드로우콜 ${i.render.calls}  삼각형 ${(i.render.triangles / 1000).toFixed(0)}k   식생 ${i.veg.drawn}/${i.veg.instances}`,
      `좌표  x ${f2(p.x)}  y ${f2(p.y)}  z ${f2(p.z)}   방위 ${yawDeg.toFixed(0)}°   눈높이 ${f2(m.eyeY)}`,
      `지면  ${surfaceLabel(m.surface)} [${surfaceKey(m.surface)}]${m.ground.onDike ? ' · 논둑 위' : ''}${m.ground.obstacle ? ' · 장애물 위(' + m.ground.obstacle.type + ')' : ''}`,
      `빠진 깊이 ${(m.sink * 100).toFixed(0)} cm${m.extracting ? '  ← 발 빼는 중' : ''}   물 깊이 ${(m.ground.waterDepth * 100).toFixed(0)} cm   경사 ${f1(m.slope.deg)}° (진행방향 ${f1(m.uphillDeg)}°)`,
      `속도  ${f2(m.speed)} m/s (목표 ${f2(m.targetSpeed)})   걸음 ${GAIT_LABEL[m.gait]}   자세 ${STANCE_LABEL[m.stance]}${m.transitioning ? ' (전환 중)' : ''}`,
      `스태미나 ${f1(m.stamina)} (${net >= 0 ? '+' : ''}${f2(net)}/s)${m.exhausted ? '  탈진 — 30까지 달리기 불가' : ''}`,
      `심박수 ${m.heartRate.toFixed(0)} bpm   호흡 ${f2(m.breath)}`,
      `소음 반경 ${f1(m.lastNoiseRadius)} m (${m.lastNoiseKind || '-'})   비 감쇠 ×${f2(i.noiseMask)}`,
      `노출도 ${f2(i.exposure.value)}  (자세 ${f2(i.exposure.stance)} · 은폐 ${f2(i.exposure.concealment)} · 빛 ${f2(i.exposure.light)})`,
      `미끄러짐 ${m.sliding ? f2(Math.hypot(m.slideVel.x, m.slideVel.z)) + ' m/s ↓' : '없음'}   젖음도 ${f2(i.wetness)}   비 ${f2(i.rain)}`,
      `이동 제한 ${restr}`,
      `시야 레이  ${ray.vision}`,
      `탄도 레이  ${ray.bullet}`,
      `${CONFIG.timeOfDay.presets[i.tod].label} / ${CONFIG.weather.presets[i.weather].label}   품질 ${CONFIG.graphics[i.quality].label}`,
      '',
      '[1~8] 테스트 지점 이동:',
      ...i.testPoints.map((t) => `  ${t.key} ${t.name}`),
      '[F6] 거동 불능 시뮬레이션   [Esc] 설정',
    ];
    return lines.join('\n');
  }
}
