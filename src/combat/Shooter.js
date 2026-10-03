// =====================================================================
//  Shooter — 사람 한 명의 사격 묶음: Weapon(탄창·약실·모드·재장전) + AimModel(흔들림·관성·반동) + CombatSystem(실제 탄)
//  플레이어 전용이 아니다 — 4단계 적 병사도 자세(pose)와 입력(input)만 채워 같은 Shooter 로 쏜다. 순수 로직.
//
//  매 프레임 update(dt, pose, input, query):
//   1) 조준 입력 정리: 조준 = input.aim && 무기 동작 중 아님 && 달리는 중 아님
//   2) 거치 감지 (조준 중, query 가 있을 때) — 시선 방향 기준 (흔들림이 거치 판정을 되먹이지 않게)
//   3) aim.update → 흔들림·관성·반동 진행, 시선에 더할 반동(viewKick)과 숨 참기 스태미나 대가
//   4) 이번 프레임 조준선(sight)·총구(muzzle) 계산 → 5) weapon.update — 나가는 발마다 _onShot 에서 실제 탄 발사
//  탄 방향: 조준선(시선 + aim.offYaw/offPitch) 을 aim.onShot 의 빗나감 (dyaw, dpitch + 영점각) 만큼 비튼 것.
//  탄 출발점: 가늠자 조준 = 눈 − 조준선 '위' × sightHeight (총열 중심), 지향사격 = 눈 + 오른쪽·아래·앞 (CONFIG.aim.hipOffset)
//            — 지향사격도 총구 방향은 같은 조준선 (화면 중앙이 아니라 '총이 향한 곳'으로 나간다). 둘은 ads 로 섞는다.
//  이벤트: 무기 이벤트를 같은 이름·payload 로 다시 보낸다 ('shot','dryFire','malfunction','reloadStart','magOut','magIn',
//          'boltPull','boltRelease','reloadEnd','magCheckStart','magCheckResult','clearStart','clearEnd','modeChange',
//          'stateChange','noMags','noise' …), AimModel 의 'holdBreath', 그리고 발마다
//          'fired' {origin, dir, ads, burstIndex, projectile, timeOffset, tracer, mode}.
//  화면 모델(WeaponView)은 카메라가 움직인 뒤 refreshSight(카메라 위치, yaw, pitch) 를 불러 sight·muzzle 을 다시 맞춘다.
//  rest = 이번 프레임 거치 감지 {rested, kind, object, gap, drop} (지연을 거친 실제 거치 상태는 aim.rested·restBlend).
//  게임 루프 순서: CombatSystem.update(dt) 를 먼저, 그다음 Shooter.update — 발사한 탄은 'shot'.timeOffset 만큼 미리 진행되어
//  이번 프레임 끝 위치에 있으므로 (Ballistics 규약) 같은 프레임에 combat.update 를 또 부르면 한 프레임 앞서 간다.
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { AimModel } from './AimModel.js';
import { Ballistics } from './Ballistics.js';
import { detectRest } from './Rest.js';
import { Weapon } from './Weapon.js';
import { copy, deviate, dirFromYawPitch, v3 } from './geom.js';

const NO_INPUT = Object.freeze({});

export class Shooter extends EventEmitter {
  /**
   * @param {import('./CombatSystem.js').CombatSystem} combat
   * @param {import('./People.js').Person} person   쏘는 사람 (자기 탄에 맞지 않음, 명중 통계의 주인)
   * @param {object} weaponData                     CONFIG.weapons.<키>
   * @param {{rng?: RNG}} opts                      헤드리스 시뮬은 시드 RNG 를 넘긴다
   */
  constructor(combat, person, weaponData = CONFIG.weapons[CONFIG.weapons.default], opts = {}) {
    super();
    this.combat = combat;
    this.person = person;
    this.weaponData = weaponData;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    // 무기와 조준이 각자의 난수열 — 한쪽이 난수를 더 뽑아도(고장 판정 등) 다른 쪽 흐름이 바뀌지 않게
    this.weapon = new Weapon(weaponData, { rng: fork(this.rng, 1) });
    this.aim = new AimModel(weaponData, { rng: fork(this.rng, 2) });
    this.zeroAngle = 0;   // 총열이 조준선보다 들린 각 (rad) — 영점 거리에서 탄이 조준선을 다시 지나게
    this._zeroIn = { range: NaN, height: NaN, speed: NaN, drag: NaN, g: NaN };
    this._refreshZero();

    this.sight = { origin: v3(), dir: v3(0, 0, -1) };    // 조준선 (눈, 시선 + 어긋남)
    this.muzzle = { origin: v3(), dir: v3(0, 0, -1) };   // 탄 출발점 + 총열 방향 (가늠자/지향사격 자세를 ads 로 섞음)
    this.rest = { rested: false, kind: null, object: null, gap: NaN, drop: 0 };   // 이번 프레임 거치 감지 (순간값)
    this.pose = null;                                    // 마지막 update 의 pose
    this._aimIn = {
      aimHeld: false, holdBreathHeld: false, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, speed: 0,
      sprinting: false, heartRate: undefined, stamina: undefined, breathRate: undefined, suppression: 0,
      suppressionEffects: null, rested: false, restDrop: 0, lookDeltaYaw: 0, lookDeltaPitch: 0,
    };
    this._weaponIn = { trigger: false, triggerPressed: false, reload: false, mode: false, magCheck: false, canFire: true };
    this._look = v3();
    this._fx = {};

    // 무기 이벤트를 같은 이름·payload 로 다시 보낸다. EventEmitter 에 와일드카드가 없어 무기의 emit 을 감싼다
    // → 무기에 새 이벤트가 생겨도 여기를 고칠 필요가 없다. 무기 자신의 구독자(아래 'shot' 발사)가 먼저 불린다.
    const weapon = this.weapon;
    const weaponEmit = weapon.emit;
    weapon.emit = (type, payload) => {
      weaponEmit.call(weapon, type, payload);
      this.emit(type, payload);
    };
    weapon.on('shot', (e) => this._onShot(e));
    this.aim.on('holdBreath', (e) => this.emit('holdBreath', e));
  }

  /**
   * @param {number} dt
   * @param {{ eye:{x,y,z}, yaw, pitch, stance, stanceFrom?, stanceProgress?, speed?, sprinting?, heartRate?, stamina?,
   *           breathRate?, suppression?, suppressionEffects?, lookDeltaYaw?, lookDeltaPitch? }} pose
   *        yaw/pitch = 지금 시선 (이전 프레임까지 더한 반동 포함). suppression 을 주지 않으면 person.suppression 을 읽는다.
   * @param {{ trigger?, triggerPressed?, aim?, holdBreath?, reload?, mode?, magCheck? }} input
   * @param {import('../world/WorldQuery.js').WorldQuery|null} query  거치 감지용 (없으면 거치 없음)
   * @returns {{viewKickYaw:number, viewKickPitch:number, staminaCost:number}}  시선에 더할 반동(rad)·뺄 스태미나 (재사용 객체)
   */
  update(dt, pose, input = NO_INPUT, query = null) {
    const P = pose;
    const I = input || NO_INPUT;
    this.pose = P;
    const sprinting = !!P.sprinting;
    const aimHeld = !!I.aim && !this.weapon.busy && !sprinting;
    const speed = P.speed > 0 ? P.speed : 0;

    // 거치 감지 (조준 중에만)
    const rest = this.rest;
    if (query && aimHeld) {
      detectRest(query, P.eye, dirFromYawPitch(P.yaw, P.pitch, this._look), P.stance, speed, rest);
    } else {
      rest.rested = false; rest.kind = null; rest.object = null; rest.gap = NaN; rest.drop = 0;
    }

    // 조준 모델
    const s = this._aimIn;
    s.aimHeld = aimHeld;
    s.holdBreathHeld = !!I.holdBreath;
    s.stance = P.stance ?? 'stand';
    s.stanceFrom = P.stanceFrom ?? s.stance;
    s.stanceProgress = P.stanceProgress ?? 1;
    s.speed = speed;
    s.sprinting = sprinting;
    s.heartRate = P.heartRate;
    s.stamina = P.stamina;
    s.breathRate = P.breathRate;
    const sup = this.person?.suppression;
    s.suppression = P.suppression ?? sup?.value ?? 0;
    s.suppressionEffects = P.suppressionEffects ?? (P.suppression === undefined && sup ? sup.effects(this._fx) : null);
    s.rested = rest.rested;
    s.restDrop = rest.drop;
    s.lookDeltaYaw = P.lookDeltaYaw ?? 0;
    s.lookDeltaPitch = P.lookDeltaPitch ?? 0;
    const kick = this.aim.update(dt, s);

    // 이번 프레임의 조준선 — 아래 무기 갱신에서 나가는 발이 이 선을 쓴다
    this._refreshZero();
    this.refreshSight(P.eye, P.yaw, P.pitch);

    // 무기 (발사는 'shot' 이벤트 → _onShot)
    const w = this._weaponIn;
    w.trigger = !!I.trigger;
    w.triggerPressed = !!I.triggerPressed;
    w.reload = !!I.reload;
    w.mode = !!I.mode;
    w.magCheck = !!I.magCheck;
    w.canFire = this.aim.canFire && !sprinting;
    this.weapon.update(dt, w);
    return kick;
  }

  /**
   * 조준선·총구를 다시 계산 (카메라가 흔들림·기울이기로 움직인 뒤 화면 모델이 부른다).
   * sight.dir = 시선 + 어긋남 (영점각 전 — 가늠쇠 끝이 가리키는 곳), muzzle.dir = 총열 (영점각만큼 위).
   */
  refreshSight(eye, yaw, pitch) {
    const a = this.aim;
    const s = this.sight, m = this.muzzle;
    copy(s.origin, eye);
    const d = dirFromYawPitch(yaw + a.offYaw, pitch + a.offPitch, s.dir);
    // 조준선의 국소 기저 (geom.deviate 와 같은 규칙): right = normalize(−d.z, 0, d.x), up = right × d
    let rx = -d.z, rz = d.x;
    const rl = Math.hypot(rx, rz);
    if (rl < 1e-9) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
    const ux = -rz * d.y, uy = rz * d.x - rx * d.z, uz = rx * d.y;
    const sh = this.weaponData.sightHeight || 0;
    const H = CONFIG.aim.hipOffset;
    const k = a.ads;
    // 가늠자 조준: 총열 중심 = 눈 바로 아래 sightHeight / 지향사격: 허리춤 (눈 기준 오른쪽·아래·앞)
    const ax = eye.x - ux * sh, ay = eye.y - uy * sh, az = eye.z - uz * sh;
    const hx = eye.x + rx * H.right - ux * H.down + d.x * H.forward;
    const hy = eye.y - uy * H.down + d.y * H.forward;
    const hz = eye.z + rz * H.right - uz * H.down + d.z * H.forward;
    m.origin.x = hx + (ax - hx) * k;
    m.origin.y = hy + (ay - hy) * k;
    m.origin.z = hz + (az - hz) * k;
    deviate(d, 0, this.zeroAngle, m.dir);
  }

  // -----------------------------------------------------------------
  /** 한 발: 조준선을 이번 발의 빗나감과 영점각만큼 비틀어 실제 탄을 쏜다 */
  _onShot(e) {
    if (!this.pose) return;
    const a = this.aim;
    const W = this.weaponData;
    const timeOffset = e.timeOffset > 0 ? e.timeOffset : 0;
    const dev = a.onShot(e.burstIndex, timeOffset);
    // sight.dir = dirFromYawPitch(yaw + offYaw, pitch + offPitch) — 이번 프레임 update 에서 계산됨
    const dir = deviate(this.sight.dir, dev.dyaw, dev.dpitch + this.zeroAngle, v3());
    const origin = copy(v3(), this.muzzle.origin);
    const tracer = !!e.tracer;
    const projectile = this.combat
      ? this.combat.fire(this.person, { origin, dir, speed: W.muzzleVelocity, weapon: W, tracer, timeOffset })
      : null;
    this.emit('fired', { origin, dir, ads: a.ads, burstIndex: e.burstIndex, projectile, timeOffset, tracer, mode: e.mode });
  }

  /** 영점각 — 무기 데이터(영점 거리·조준선 높이·초속·공기 저항)를 콘솔에서 바꾸면 다시 계산 (매 프레임 비교만) */
  _refreshZero() {
    const W = this.weaponData, g = CONFIG.ballistics.gravity, z = this._zeroIn;
    if (z.range === W.zeroRange && z.height === W.sightHeight && z.speed === W.muzzleVelocity && z.drag === W.dragK && z.g === g) return;
    z.range = W.zeroRange; z.height = W.sightHeight; z.speed = W.muzzleVelocity; z.drag = W.dragK; z.g = g;
    this.zeroAngle = W.zeroRange > 0 ? Ballistics.computeZeroAngle(W) : 0;
  }
}

/** 하위 난수열 (RNG.fork 가 없는 rng 면 그대로 공유) */
function fork(rng, salt) {
  return rng && typeof rng.fork === 'function' ? rng.fork(salt) : rng;
}
