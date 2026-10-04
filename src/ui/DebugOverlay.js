// F3 디버그 오버레이 — 실제 상태 값을 그대로 보여준다
//  2단계 줄: 사격 (발사·명중·명중률·모드·탄·예비 탄창·오염도·고장) / 조준 (ADS·흔들림 진폭·숨 참기·거치·반동 누적·관성) / 제압
//  3단계 줄: 부상 (혈액량·출혈 속도·의식 단계·붕대/지혈대 남은 수·충격·처치·총) + 상처 목록 (부위·종류·동맥·붕대/지혈대·출혈)
import { CONFIG } from '../config.js';
import { surfaceLabel, surfaceKey } from '../world/Surfaces.js';

const GAIT_LABEL = { idle: '정지', walk: '걷기', sprint: '달리기', quiet: '조용히 걷기', crouch: '앉아 이동', prone: '포복' };
const STANCE_LABEL = { stand: '서기', crouch: '앉기', prone: '엎드리기' };
const HOLD_LABEL = { idle: '가능', holding: '참는 중', recovering: '몰아쉬는 중', cooldown: '대기' };
const LEVEL_LABEL = { none: '없음', light: '경미', heavy: '강함', pinned: '완전 제압' };
const STATE_LABEL = { reloading: '재장전 중', magCheck: '탄창 확인 중', clearing: '고장 해결 중' };
const R2D = 180 / Math.PI;
const STAGE_LABEL = { normal: '또렷함', weak: '약해짐 (80% 미만: 심박·흔들림↑)', faint: '흐려짐 (60% 미만: 회색·흐림·먼 소리)', dead: '의식 없음' };

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
    const ms = caps.maxSpeed, sp = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
    const capTxt = Number.isFinite(ms.stand) || Number.isFinite(ms.crouch) || Number.isFinite(ms.prone)
      ? `, 최대 ${sp(ms.stand)}/${sp(ms.crouch)}/${sp(ms.prone)} m/s` : '';
    const restr = m.restrictions.size ? [...m.restrictions.keys()].join(', ') + ` (서기 ${caps.canStand ? 'O' : 'X'}, 앉기 ${caps.canCrouch ? 'O' : 'X'}, 달리기 ${caps.canSprint ? 'O' : 'X'}, 속도 ×${caps.maxSpeedMultiplier}${capTxt}${Number.isFinite(caps.maxStamina) ? `, 스태미나 ≤${caps.maxStamina}` : ''})` : '없음';
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
      ...(i.injury ? this._injuryLines(i.injury) : []),
      ...(i.ai ? this._aiLines(i.ai) : []),
      ...(i.mission ? this._missionLines(i.mission) : []),
      ...(i.field ? this._fieldLines(i.field) : []),
      '',
      '[1~9] 테스트 지점 이동:',
      ...i.testPoints.map((t) => `  ${t.key} ${t.name}`),
      '[F2] AI 디버그   [F4] 적 생성   [F6] 대퇴 부상 (테스트)   [F7] 제압 테스트   [F8] 표적 배치   [F9] 피격 테스트·무적   [H] 붕대 [G] 지혈대 [F] 줍기·문서   [M] 지도 [N] 나침반 [V] 탄창 채우기   [Y] 탐침 [U] 수통 [L] 손전등 [F10] 6단계 시험   [Esc] 설정',
    ];
    return lines.join('\n');
  }

  /** 5단계: 임무 진행 (디버그 모드 F3 에서만 — 화면에는 위치·목표 표시가 없다) */
  _missionLines(R) {
    const m = R.mission, d = R.director, w = R.weather.params, c = R.clock;
    const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const obj = m.objectives.map((o) => `${o.done ? '✓' : o.progress > 0 ? `${Math.round(o.progress * 100)}%` : '·'}${o.mapLabel ?? o.id}`).join(' ');
    return [
      `임무  ${R.def.label} #${R.def.seed}  경과 ${mm(m.t)} / ${mm(R.def.limit)}  시각 ${c.label}  단계 ${m.phase}${m.phase === 'extract' ? ` (회수 ${Math.round(m.hold)}s)` : ''}  목표 ${obj}`,
      `날씨  ${w.label} (${w.kind}→${w.next} ${(w.k * 100).toFixed(0)}%)  비 ${w.rain.toFixed(2)}  천둥 가림 ${R.weather.thunderMask.toFixed(2)}`
        + `   디렉터: 대기 ${d.pending.length} · 생성 ${d.spawned.length} · 증원 ${d.reinforcements}${d.reinforceAt !== null ? `(${Math.round(d.reinforceAt - d.t)}s)` : ''} · 매복 ${d.ambush.state} · 첫 접촉 ${d.firstContact >= 0 ? mm(d.firstContact) : '-'}`,
      `발자국 ${R.g.footprints.list.length} (화면 ${R.printMesh.shown})   사상자 확인 ${R._stats.confirmed} · 추정 ${R._stats.estimated}   이동 ${Math.round(R._stats.distance)} m`,
    ];
  }

  /** 6단계: 함정·밤·몸 */
  _fieldLines(f) {
    const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
    const T = f.traps, near = f.nearTrap;
    const fx = f.endurance.effects();
    return [
      `함정  ${T.list.length}개 (남음 ${T.armed.length} · 알아챔 ${T.stats.known} · 발동 ${T.stats.triggered})  가장 가까운 ${near ? `${near.trap.kind} ${near.distance.toFixed(1)}m${near.trap.known ? ' (알아챔)' : ''}` : '-'}  탐침 ${f.probe ? Math.round(f.probe * 100) + '%' : '-'}  해제 ${f.disarm ? Math.round(f.disarm * 100) + '%' : '-'}`,
      `밤  낮 빛 ${f2(f.light.day)} · 달 ${f.light.moon} · 빛 수준 ${f2(f.light.ambient)} (+인공 ${f2(f.light.extra)})  암순응 ${f2(f.adapt.level)} (노출 ×${f2(f.adapt.exposureMul)})  조명탄 ${f.flares}  손전등 ${f.lamp ? '켬' : '끔'}  적 night ${f2(f.night)}`,
      `몸  피로 ${f.endurance.fatigue.toFixed(1)} · 갈증 ${f.endurance.thirst.toFixed(1)} (분당 +${f2(f.endurance.rates.fatigue)} / −${f2(f.endurance.rates.thirst)})  물 ${f.endurance.water.toFixed(2)} L  스태미나 상한 ×${f2(fx.staminaMaxMul)} 회복 ×${f2(fx.regenMul)} 흔들림 ×${f2(fx.swayMul)}  총구 막힘 ${f2(f.obstruct)}`,
    ];
  }

  /** 4단계: ai = { manager: EnemyManager, wildlife 활동도, 무적 } */
  _aiLines(ai) {
    const em = ai.manager;
    const alive = em.soldiers.filter((s) => s.alive).length;
    const sq = em.squads.filter((q) => q.alive.length).map((q) => `${q.type === 'ambush' ? '매복' : '순찰'}:${q.state}(${q.alive.length}명·사기 ${Math.round(q.morale)})`);
    const st = em.stats;
    return [
      `적  활동 ${alive}/${CONFIG.ai.maxActive}  시체 ${em.soldiers.length - alive}  분대 ${sq.join(' ') || '-'}`
        + `   시야 레이 ${(ai.raysPerFrame ?? 0).toFixed(1)}/프레임  경로 ${st.paths}  들은 소리 ${st.heard}  총구 화염 ${st.flashes}  AI ${(ai.ms ?? 0).toFixed(2)} ms`,
      `동물 활동도 (주변 30m) ${ai.wildlife.toFixed(2)}${ai.invulnerable ? '   [무적]' : ''}`,
    ];
  }

  /** 3단계: inj = Injuries (플레이어) */
  _injuryLines(inj) {
    const f1 = (v) => v.toFixed(1);
    const fx = inj.effects();
    const extra = [];
    if (inj.stunned) extra.push(`충격 ${inj.stun.toFixed(1)}s`);
    if (inj.aid) extra.push(`처치: ${inj.aid.kind === 'bandage' ? '붕대' : '지혈대'} ${Math.round(inj.aid.t / inj.aid.duration * 100)}%`);
    if (inj.weaponDropped) extra.push('총 떨어뜨림');
    if (inj.dead) extra.push(`사망: ${inj.causeLabel} (${f1(inj.deathTime)}s)`);
    const lines = [
      `부상  혈액 ${f1(inj.blood)}%   출혈 ${f1(inj.bleedRate)}%/분   의식 ${STAGE_LABEL[inj.stage] ?? inj.stage}   붕대 ${inj.bandages}  지혈대 ${inj.tourniquets}`
        + `   흔들림 ×${fx.swayMul.toFixed(2)} 반동 ×${fx.recoilMul.toFixed(2)} 재장전 ×${fx.reloadMul.toFixed(2)}${fx.fireDelay ? ` 발사 지연 ${fx.fireDelay}s` : ''}${fx.noAuto ? ' 연발 불가' : ''}`
        + (extra.length ? `   [${extra.join(' · ')}]` : ''),
    ];
    const T = CONFIG.injury.typeLabels;
    if (!inj.wounds.length) lines.push('  상처 없음');
    for (const w of inj.wounds) {
      const tags = [T[w.type] ?? w.type];
      if (w.arterial) tags.push('동맥');
      if (w.lowSpeed) tags.push('저속 탄');
      if (w.bandaged) tags.push('붕대');
      if (w.tourniquet) tags.push('지혈대');
      lines.push(`  · ${w.label} — ${tags.join(', ')} — ${f1(inj.woundBleed(w))}%/분`);
    }
    return lines;
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
