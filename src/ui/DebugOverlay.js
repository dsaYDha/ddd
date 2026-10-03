// F3 디버그 오버레이 — 실제 상태 값을 그대로 보여준다
//  2단계 줄: 사격 (발사·명중·명중률·모드·탄·예비 탄창·오염도·고장) / 조준 (ADS·흔들림 진폭·숨 참기·거치·반동 누적·관성) / 제압
import { CONFIG } from '../config.js';
import { surfaceLabel, surfaceKey } from '../world/Surfaces.js';

const GAIT_LABEL = { idle: '정지', walk: '걷기', sprint: '달리기', quiet: '조용히 걷기', crouch: '앉아 이동', prone: '포복' };
const STANCE_LABEL = { stand: '서기', crouch: '앉기', prone: '엎드리기' };
const HOLD_LABEL = { idle: '가능', holding: '참는 중', recovering: '몰아쉬는 중', cooldown: '대기' };
const LEVEL_LABEL = { none: '없음', light: '경미', heavy: '강함', pinned: '완전 제압' };
const STATE_LABEL = { reloading: '재장전 중', magCheck: '탄창 확인 중', clearing: '고장 해결 중' };
const R2D = 180 / Math.PI;

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
      `FPS ${f1(this.fps)} (${f1(this.ms)} ms)   드로우콜 ${i.render.calls}  삼각형 ${(i.render.triangles / 1000).toFixed(0)}k`,
      `화면 내 인스턴스 ${i.veg.drawn + i.veg.groundCover} (배치 식생 ${i.veg.drawn}/${i.veg.instances} · 지피층 ${i.veg.groundCover})`,
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
      ...(i.combat ? this._combatLines(i.combat) : []),
      '',
      '[1~9] 테스트 지점 이동:',
      ...i.testPoints.map((t) => `  ${t.key} ${t.name}`),
      '[F6] 거동 불능 시뮬레이션   [F7] 제압 테스트   [F8] 표적 배치   [Esc] 설정',
    ];
    return lines.join('\n');
  }

  /** c: { shooter, stats {shots, hits}, suppression, stress } */
  _combatLines(c) {
    const w = c.shooter.weapon, a = c.shooter.aim, rest = c.shooter.rest;
    const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2);
    const { shots, hits } = c.stats;
    const spares = w.mags.filter((m, k) => k !== w.magIndex).map((m) => m.rounds).join(' ');
    const mode = CONFIG.weapons.modeLabels?.[w.mode] ?? w.mode;
    const restTxt = a.rested
      ? `O (${CONFIG.testRange.objectLabels?.[rest.object] ?? rest.object ?? rest.kind ?? '-'})`
      : (rest.rested ? '감지 중' : 'X');
    const inertia = Math.hypot(a.inertiaYaw, a.inertiaPitch) * R2D;
    const sup = c.suppression;
    return [
      `사격  발사 ${shots}  명중 ${hits}  명중률 ${shots ? (hits / shots * 100).toFixed(1) : '0.0'}%   모드 ${mode}   탄 ${w.chambered ? 1 : 0}+${w.magRounds}`
        + ` (예비 탄창 [${spares}])   오염도 ${f1(w.fouling)}   고장 ${w.malfunctioned ? 'O' : 'X'}${STATE_LABEL[w.state] ? '   ' + STATE_LABEL[w.state] : ''}`,
      `조준  ADS ${f2(a.ads)}  흔들림 진폭 ${f2(a.swayAmpDeg)}°  숨 참기 ${HOLD_LABEL[a.holdState] ?? a.holdState}  거치 ${restTxt}`
        + `  반동 누적 ${f1(a.recoilClimbDeg)}° (연속 ${a.burst}발 ×${f2(a.recoilMul)})  관성 ${f2(inertia)}°`,
      `제압  ${f1(sup.value)} (${LEVEL_LABEL[sup.level] ?? sup.level})   심박 긴장 ${f2(c.stress)}   흔들림 배율 ×${f2(a.mul?.suppression ?? 1)}`,
    ];
  }
}
