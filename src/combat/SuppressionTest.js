// =====================================================================
//  SuppressionTest — F7 제압 테스트 (순수 로직: three.js·DOM 없음 → Node 헤드리스에서도 동작)
//  플레이어 주변으로 '일부러 빗나가는' 연발을 무작위 방향 50~150m 의 가상 사수가 쏜다 (CONFIG.testRange.suppression).
//  가상 사수 = { name: 'F7 사수', position } — 사람 목록에 없어 맞지 않고, 탄은 noHit 에 플레이어를 넣어 절대 맞지 않는다.
//
//  연발마다: 방향·거리를 뽑아 '트인 사격선' 자리를 고른다 — 충돌이 켜지는 곳(플레이어 앞 collideWithin m)부터 플레이어를
//           clearPast m 지날 때까지 BulletWorld.cast 가 막히지 않는 방향 (빽빽한 정글에서 탄이 플레이어 앞 줄기에 다 박히지 않게).
//           tries 번 안에 없으면 가장 플레이어 가까이까지 트인 방향. 발수 U(burst), 간격 60/rpm 초, 연발 사이 U(interval) 초.
//  발마다: 사격선에 수직인 면에서 무작위 방향(missAngleDeg — 발밑 땅속 쪽 제외)으로, 머리·몸통 캡슐 '표면'에서 U(miss) m
//          떨어져 지나가는 점을 이분법으로 찾아 겨눈다 (= 근접 통과 거리 분포가 miss 범위 그대로) + 고유 산포 (dispersionMOA).
//          땅속이면 지면 바로 위로 (발치에 박히는 탄). 직선 경로가 플레이어의 모든 캡슐에서 minClear 보다 가까우면 다시 뽑고
//          (tries 번), 사격선이 막히면 다시 뽑는다 (roundTries 번 — 못 찾으면 가장 플레이어 가까이까지 트인 것).
//          플레이어가 움직이면 비행시간만큼 앞을 겨눈다 (현재·예측 자리 둘 다 안전 확인).
//          낙차는 Ballistics.solveElevation, collideWorldFrom = 경로 길이 - collideWithin (먼 숲은 건너뜀),
//          timeOffset = 이번 프레임 안에서 쏜 시점 → 프레임 끝 (60/rpm 간격이 프레임과 어긋나도 정확).
//  게임 루프 순서: combat.update(dt) → (이것).update(dt) — 쏜 탄은 Ballistics 규약대로 이번 프레임 끝 위치에 있다.
//  이벤트: 'state' {active, reason: 'start'|'manual'|'done'}, 'burst' {index, origin, distance, azimuth, rounds, clear, score},
//          'remoteShot' {origin, distance, horizontal, time, shooter, projectile, burst, round, miss}
//            — 소리는 거리/343초 뒤 발사음 (초음속 '딱'이 먼저 들려 어디서 쏘는지 헷갈리게)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { DEG, clamp } from '../core/math.js';
import { RNG } from '../core/rng.js';
import { NO_WATER } from '../world/WorldConstants.js';
import { Ballistics } from './Ballistics.js';
import { closestSegSeg, dirFromYawPitch } from './geom.js';

const MOA = DEG / 60;
const SIGMA_PER_R90 = 1 / Math.sqrt(2 * Math.LN10);   // 2차원 정규분포 90% 원 반경 → 축별 표준편차 (AimModel 과 같은 환산)
const LINE_HALF = 12;          // 빗나감·안전 간격을 재는 직선 구간: 겨눈 점 앞뒤 (m) — 몸(2m 안팎) 근처만 보면 된다
const GROUND_CLEAR = 0.1;      // 겨눈 점이 땅속이면 지면 위 이 높이로 (m)
const BISECT_STEPS = 24;       // 빗나감 거리 이분법 반복 (≈ 1e-7 m)
const VEL_SMOOTH = 0.15;       // 플레이어 속도 추정 평활 시간상수 (s)
const MAX_PLAYER_SPEED = 9;    // 이보다 빠른 위치 변화는 순간이동으로 보고 속도 추정을 초기화 (m/s)
const MAX_LEAD = 3;            // 앞을 겨누는 최대 거리 (m)
const MAP_MARGIN = 5;          // 가상 사수는 맵 가장자리에서 이만큼 안쪽 (m)
const SOLID_PROBE = 0.5;       // 충돌 시작점이 땅속이면 이 간격으로 앞으로 옮겨 봄 (Ballistics 의 미루기와 같은 효과)

export class SuppressionTest extends EventEmitter {
  /**
   * @param {import('./CombatSystem.js').CombatSystem} combat
   * @param {import('../world/WorldQuery.js').WorldQuery|null} query  사수 지면 높이 (null 이면 combat.world 평지)
   * @param {import('./People.js').Person} playerPerson  빗나가게 쏠 대상 (noHit)
   * @param {object} weaponData  가상 사수 무기 (연사 속도·초속·산포·낙차)
   * @param {{rng?: RNG}} opts
   */
  constructor(combat, query, playerPerson, weaponData = CONFIG.weapons[CONFIG.weapons.default], opts = {}) {
    super();
    this.combat = combat;
    this.query = query ?? null;
    this.player = playerPerson ?? null;
    this.weapon = weaponData;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.active = false;
    this.time = 0;                 // 시작 후 경과 (s)
    /** 가상 사수 (Person 이 아님 — 맞을 수 없다). position 은 연발마다 바뀐다 */
    this.shooter = { name: 'F7 사수', position: { x: 0, y: 0, z: 0 }, virtual: true };
    this.burst = null;             // 진행 중(또는 마지막) 연발 {index, origin, distance, azimuth, rounds, fired, clear, score, startTime}
    this.shots = 0;                // 이번 테스트에서 쏜 발 수
    this.bursts = 0;
    this.skipped = 0;              // 안전한 빗나갈 점을 못 찾아 건너뛴 발
    this.blockedBursts = 0;        // 트인 방향을 못 찾은 연발
    this._burstAt = Infinity;      // 다음 연발 시작 시각
    this._shotAt = Infinity;       // 다음 발 시각
    this._left = 0;                // 이번 연발 남은 발
    this._noHit = new Set();
    if (this.player) this._noHit.add(this.player);
    this._vel = { x: 0, z: 0 };    // 플레이어 수평 속도 추정 (앞을 겨눔)
    this._last = null;
    this._castOut = {};            // BulletWorld.cast 결과 (탄도 계산과 공유하지 않게 따로)
    // 작업용 (발마다 새 객체를 만들지 않음 — 서로 겹쳐 쓰지 않게 용도별로)
    this._aimC = v0();             // 사수 자리 고를 때 앞을 겨눈 가슴
    this._leadV = v0();            // 이번 발의 앞 겨눔 (수평 이동)
    this._P = v0();                // 이번 발 겨눌 점 후보
    this._s0 = v0(); this._s1 = v0();   // _lineDist 직선 구간 끝
    this._q0 = v0(); this._q1 = v0();   // _lineDist 옮긴 캡슐 끝
    this._c0 = v0(); this._c1 = v0();   // _lineScore 선분 끝
    this._cs = { distSq: 0, s: 0, t: 0 };
  }

  /** 시작 ↔ 중지. @returns {boolean} 진행 중인가 */
  toggle() {
    if (this.active) this.stop('manual');
    else this.start();
    return this.active;
  }

  start() {
    const S = CONFIG.testRange.suppression;
    this.active = true;
    this.time = 0;
    this.burst = null;
    this.shots = 0;
    this.bursts = 0;
    this.skipped = 0;
    this.blockedBursts = 0;
    this._left = 0;
    this._shotAt = Infinity;
    this._burstAt = Math.max(0, S.startDelay);
    this.emit('state', { active: true, reason: 'start' });
  }

  /** 중지 (이미 날아가는 탄은 그대로 — 탄도가 끝낸다) */
  stop(reason = 'manual') {
    if (!this.active) return;
    this.active = false;
    this._burstAt = Infinity;
    this._shotAt = Infinity;
    this._left = 0;
    this.emit('state', { active: false, reason });
  }

  update(dt) {
    if (!(dt > 0)) return;
    this._trackPlayer(dt);
    if (!this.active) return;
    const S = CONFIG.testRange.suppression;
    const tEnd = this.time + dt;
    for (let guard = 0; guard < 512 && this.active; guard++) {
      const next = Math.min(this._burstAt, this._shotAt);
      if (next > tEnd) break;
      this.time = next;
      if (this._shotAt <= this._burstAt) this._fireRound(next, tEnd - next);
      else this._startBurst(next);
    }
    if (!this.active) return;
    this.time = tEnd;
    // 시간이 다 되면 진행 중인 연발만 마치고 끝 (새 연발은 _fireRound 가 잡지 않는다)
    if (this.time >= S.duration && this._shotAt === Infinity) this.stop('done');
  }

  // =================================================================
  // 연발
  // =================================================================
  _startBurst(t) {
    const S = CONFIG.testRange.suppression;
    const pick = this._pickShooter();
    if (!pick) {   // 플레이어 판정 몸이 없음 (자세 없음) — 잠시 뒤 다시
      this._burstAt = t + 0.5 < S.duration ? t + 0.5 : Infinity;
      if (this._burstAt === Infinity) this.stop('done');
      return;
    }
    const sp = this.shooter.position;
    sp.x = pick.origin.x; sp.y = pick.origin.y; sp.z = pick.origin.z;
    const rounds = this.rng.int(Math.round(S.burst[0]), Math.round(S.burst[1]));
    this.bursts++;
    if (!pick.clear) this.blockedBursts++;
    this.burst = {
      index: this.bursts, origin: { ...pick.origin }, distance: pick.distance, azimuth: pick.azimuth,
      rounds, fired: 0, clear: pick.clear, score: pick.score, startTime: t,
    };
    this._left = rounds;
    this._shotAt = t;
    this._burstAt = Infinity;
    this.emit('burst', { ...this.burst });
  }

  /** 발 하나 (t: 쏜 시각, timeOffset: 그때부터 이번 update 끝까지) */
  _fireRound(t, timeOffset) {
    const S = CONFIG.testRange.suppression;
    const W = this.weapon;
    const b = this.burst;
    const shot = b ? this._aimRound(b.origin) : null;
    if (shot) {
      const n = this.shots++;
      const p = this.combat.fire(this.shooter, {
        origin: { ...b.origin }, dir: shot.dir, speed: W.muzzleVelocity, weapon: W,
        tracer: !!W.tracer && n % Math.max(1, W.tracerEvery | 0) === 0,
        collideWorldFrom: shot.collideFrom, noHit: this._noHit, timeOffset,
      });
      b.fired++;
      const ear = this._ear();
      const dx = b.origin.x - ear.x, dy = b.origin.y - ear.y, dz = b.origin.z - ear.z;
      this.emit('remoteShot', {
        origin: { ...b.origin }, distance: Math.hypot(dx, dy, dz), horizontal: Math.hypot(dx, dz), time: t,
        shooter: this.shooter, projectile: p, burst: b.index, round: b.fired, miss: shot.miss,
      });
    } else this.skipped++;
    this._left--;
    if (this._left > 0) {
      this._shotAt = t + 60 / Math.max(1, W.rpm);
    } else {
      this._shotAt = Infinity;
      const next = t + this.rng.range(S.interval[0], S.interval[1]);
      this._burstAt = next < S.duration ? next : Infinity;
    }
  }

  /** 연발 사수 자리: 무작위 방향·거리 중 사격선이 트인 곳 (tries 번), 없으면 가장 플레이어 가까이까지 트인 곳 */
  _pickShooter() {
    const pl = this.player;
    if (!pl || !pl.pose || !pl.hitboxes.length) return null;
    const S = CONFIG.testRange.suppression;
    const c = pl.position;
    const aim = this._leadChest(this._aimC);
    const lim = this._half() - MAP_MARGIN;
    let best = null;
    const tries = Math.max(1, S.tries | 0);
    for (let k = 0; k < tries * 3 && (!best || k < tries); k++) {
      const az = this.rng.range(0, Math.PI * 2), d = this.rng.range(S.distance[0], S.distance[1]);
      const x = c.x + Math.cos(az) * d, z = c.z + Math.sin(az) * d;
      if (!(Math.abs(x) <= lim && Math.abs(z) <= lim)) continue;   // 맵 밖 방향은 다시 (안쪽 방향은 늘 있다)
      const origin = { x, y: this._groundY(x, z) + S.shooterHeight, z };
      const score = this._lineScore(origin, aim);
      if (!best || score > best.score) best = { origin, distance: d, azimuth: az, score };
      if (score >= 1) break;
    }
    if (!best) {
      // 맵 구석: 맵 가운데 쪽으로 최소 거리
      const az = Math.atan2(-c.z, -c.x), d = S.distance[0];
      const x = c.x + Math.cos(az) * d, z = c.z + Math.sin(az) * d;
      const origin = { x, y: this._groundY(x, z) + S.shooterHeight, z };
      best = { origin, distance: d, azimuth: az, score: this._lineScore(origin, aim) };
    }
    best.clear = best.score >= 1;
    return best;
  }

  /**
   * 이번 발의 겨눌 점과 방향. 머리·몸통 표면에서 U(miss) 떨어져 지나가게 → 안전 간격·사격선 확인 → 낙차 보정.
   * @returns {{dir, aim, miss, clearance, collideFrom, score}|null}
   */
  _aimRound(origin) {
    const pl = this.player;
    if (!pl || !pl.pose || !pl.hitboxes.length) return null;
    const S = CONFIG.testRange.suppression;
    const W = this.weapon;
    const caps = pl.hitboxes;
    const lead = this._lead(origin, this._leadV);
    const cx = pl.chest.x + lead.x, cy = pl.chest.y, cz = pl.chest.z + lead.z;
    // 사격선 기저: u = 사수 → 가슴, side = 수평 오른쪽, up = side × u
    let ux = cx - origin.x, uy = cy - origin.y, uz = cz - origin.z;
    const L = Math.hypot(ux, uy, uz) || 1;
    ux /= L; uy /= L; uz /= L;
    let sx = -uz, sz = ux;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl; sz /= sl;
    const upx = -sz * uy, upy = sz * ux - sx * uz, upz = sx * uy;   // cross(side, u)
    const sd = (W.dispersionMOA || 0) * 0.5 * MOA * SIGMA_PER_R90 * L;   // 고유 산포 (m, 축별 표준편차)
    // 안전 간격 다시 뽑기는 싸서 tries 번까지, 사격선 확인(BulletWorld.cast)은 비싸서 roundTries 번까지
    const tries = Math.max(1, S.tries | 0), lineTries = Math.max(1, S.roundTries | 0);
    let best = null, casts = 0;
    const P = this._P;
    for (let k = 0; k < tries && casts < lineTries; k++) {
      const m = this.rng.range(S.miss[0], S.miss[1]);
      const th = this.rng.range(S.missAngleDeg[0], S.missAngleDeg[1]) * DEG;
      const wx = sx * Math.cos(th) + upx * Math.sin(th), wy = upy * Math.sin(th), wz = sz * Math.cos(th) + upz * Math.sin(th);
      // 이분법: 가슴에서 w 방향으로 s 만큼 옮긴 평행선이 머리·몸통 표면에서 m 떨어지는 s
      let lo = 0, hi = m + 1.2;
      for (let g = 0; g < 4 && this._lineDist(cx + wx * hi, cy + wy * hi, cz + wz * hi, ux, uy, uz, caps, lead, true) < m; g++) hi *= 2;
      for (let g = 0; g < BISECT_STEPS; g++) {
        const mid = (lo + hi) * 0.5;
        if (this._lineDist(cx + wx * mid, cy + wy * mid, cz + wz * mid, ux, uy, uz, caps, lead, true) < m) lo = mid; else hi = mid;
      }
      P.x = cx + wx * hi + (sx * this.rng.gauss() + upx * this.rng.gauss()) * sd;
      P.y = cy + wy * hi + upy * this.rng.gauss() * sd;
      P.z = cz + wz * hi + (sz * this.rng.gauss() + upz * this.rng.gauss()) * sd;
      // 땅속을 겨누지 않게 — 발치 지면 바로 위 (플레이어 근처에 박히는 탄)
      const gy = this._groundY(P.x, P.z) + GROUND_CLEAR;
      if (P.y < gy) P.y = gy;
      // 실제 직선 방향으로 안전 간격: 예측 자리와 지금 자리 모두의 모든 캡슐 (멈춰 서도 몸을 뚫고 지나가지 않게)
      let vx = P.x - origin.x, vy = P.y - origin.y, vz = P.z - origin.z;
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      const clearance = Math.min(
        this._lineDist(P.x, P.y, P.z, vx, vy, vz, caps, lead, false),
        this._lineDist(P.x, P.y, P.z, vx, vy, vz, caps, null, false),
      );
      if (clearance < S.minClear) continue;
      const aim = { x: P.x, y: P.y, z: P.z };
      const score = this._lineScore(origin, aim);
      casts++;
      if (!best || score > best.score) {
        best = { aim, miss: this._lineDist(P.x, P.y, P.z, vx, vy, vz, caps, lead, true), clearance, score, pathLen: vl };
      }
      if (score >= 1) break;
    }
    if (!best) return null;
    const a = best.aim;
    const dx = a.x - origin.x, dz = a.z - origin.z;
    const pitch = Ballistics.solveElevation(W, Math.hypot(dx, dz), a.y - origin.y);
    best.dir = dirFromYawPitch(Math.atan2(-dx, -dz), pitch);
    best.collideFrom = Math.max(0, best.pathLen - S.collideWithin);
    return best;
  }

  /**
   * 사격선 점수: 충돌이 켜지는 점(경로 길이 - collideWithin)부터 겨눈 점을 clearPast m 지날 때까지 BulletWorld.cast.
   * 1 = 막힘 없음 (또는 겨눈 점 0.5m 앞보다 뒤에서 막힘 — 플레이어 곁은 지나감), 0~1 = 막힌 곳이 플레이어에 가까운 정도.
   */
  _lineScore(origin, aim) {
    const w = this.combat?.world;
    if (!w || typeof w.cast !== 'function') return 1;
    const S = CONFIG.testRange.suppression;
    let ux = aim.x - origin.x, uy = aim.y - origin.y, uz = aim.z - origin.z;
    const L = Math.hypot(ux, uy, uz);
    if (L < 1e-6) return 1;
    ux /= L; uy /= L; uz /= L;
    const end = L + S.clearPast;
    let from = Math.max(0, L - S.collideWithin);
    const a = this._c0;
    a.x = origin.x + ux * from; a.y = origin.y + uy * from; a.z = origin.z + uz * from;
    // 충돌 시작점이 언덕 속이면 탄도도 땅 위로 나올 때까지 충돌을 미룬다 → 같은 규칙으로 앞으로 옮김
    if (typeof w.isInsideSolid === 'function') {
      while (from < L && w.isInsideSolid(a)) {
        from += SOLID_PROBE;
        a.x = origin.x + ux * from; a.y = origin.y + uy * from; a.z = origin.z + uz * from;
      }
    }
    const span = Math.max(1e-6, end - from);
    const b = this._c1;
    b.x = origin.x + ux * end; b.y = origin.y + uy * end; b.z = origin.z + uz * end;
    const c = w.cast(a, b, this._castOut);
    if (!c.hit) return 1;
    const hitDist = from + c.t * span;
    if (hitDist >= L - 0.5) return 1;
    return clamp((hitDist - from) / Math.max(1e-6, L - from), 0, 0.999);
  }

  /** 점 (px,py,pz)를 지나는 방향 u 직선(앞뒤 LINE_HALF m)과 캡슐 표면 사이 최단 거리 (shift 만큼 옮긴 몸, nearOnly: 머리·몸통만) */
  _lineDist(px, py, pz, ux, uy, uz, caps, shift, nearOnly) {
    const a = this._s0, b = this._s1, q0 = this._q0, q1 = this._q1;
    a.x = px - ux * LINE_HALF; a.y = py - uy * LINE_HALF; a.z = pz - uz * LINE_HALF;
    b.x = px + ux * LINE_HALF; b.y = py + uy * LINE_HALF; b.z = pz + uz * LINE_HALF;
    const sx = shift ? shift.x : 0, sz = shift ? shift.z : 0;
    let best = Infinity;
    for (let i = 0; i < caps.length; i++) {
      const cap = caps[i];
      if (nearOnly && !cap.near) continue;
      q0.x = cap.a.x + sx; q0.y = cap.a.y; q0.z = cap.a.z + sz;
      q1.x = cap.b.x + sx; q1.y = cap.b.y; q1.z = cap.b.z + sz;
      const d = Math.sqrt(closestSegSeg(a, b, q0, q1, this._cs).distSq) - cap.r;
      if (d < best) best = d;
    }
    return best < 0 ? 0 : best;
  }

  // =================================================================
  // 플레이어
  // =================================================================
  /** 수평 속도 추정 (지수 평활, 순간이동은 무시) — 비행시간만큼 앞을 겨누는 데 씀 */
  _trackPlayer(dt) {
    const pl = this.player;
    if (!pl || !pl.pose) { this._last = null; return; }
    const p = pl.position;
    if (!this._last) { this._last = { x: p.x, z: p.z }; this._vel.x = 0; this._vel.z = 0; return; }
    const vx = (p.x - this._last.x) / dt, vz = (p.z - this._last.z) / dt;
    this._last.x = p.x; this._last.z = p.z;
    if (Math.hypot(vx, vz) > MAX_PLAYER_SPEED) { this._vel.x = 0; this._vel.z = 0; return; }
    const k = 1 - Math.exp(-dt / VEL_SMOOTH);
    this._vel.x += (vx - this._vel.x) * k;
    this._vel.z += (vz - this._vel.z) * k;
  }

  /** 비행시간 × 속도 (수평, 최대 MAX_LEAD m) */
  _lead(origin, out) {
    out.x = 0; out.y = 0; out.z = 0;
    const pl = this.player;
    const v = this._vel;
    if (!pl || !(Math.abs(v.x) + Math.abs(v.z) > 1e-3)) return out;
    const c = pl.chest;
    const tof = Ballistics.simulate(this.weapon, Math.hypot(c.x - origin.x, c.z - origin.z), 0).tof;
    out.x = v.x * tof; out.z = v.z * tof;
    const l = Math.hypot(out.x, out.z);
    if (l > MAX_LEAD) { out.x *= MAX_LEAD / l; out.z *= MAX_LEAD / l; }
    return out;
  }

  /** 앞을 겨눈 가슴 (사수 자리 고를 때 — 사수 위치를 모르므로 150m 기준 비행시간) */
  _leadChest(out) {
    const c = this.player.chest;
    const tof = Ballistics.simulate(this.weapon, CONFIG.testRange.suppression.distance[1], 0).tof;
    let lx = this._vel.x * tof, lz = this._vel.z * tof;
    const l = Math.hypot(lx, lz);
    if (l > MAX_LEAD) { lx *= MAX_LEAD / l; lz *= MAX_LEAD / l; }
    out.x = c.x + lx; out.y = c.y; out.z = c.z + lz;
    return out;
  }

  /** 소리를 듣는 곳 (눈, 없으면 발 위 1.6m) */
  _ear() {
    const pl = this.player;
    const e = pl && pl.pose ? pl.eye : null;
    if (e) return e;
    const p = pl ? pl.position : { x: 0, y: 0, z: 0 };
    return { x: p.x, y: p.y + 1.6, z: p.z };
  }

  // =================================================================
  // 지면
  // =================================================================
  /** 사수가 서는 높이: 지지면(지형·논둑·통나무·바위)과 수면 중 높은 쪽 */
  _groundY(x, z) {
    const q = this.query;
    if (!q) {
      const g = this.combat?.world?.groundY;
      return Number.isFinite(g) ? g : 0;
    }
    const h = q.getSupportHeight(x, z);
    const wl = q.getWaterLevel(x, z);
    return wl !== NO_WATER && wl > h ? wl : h;
  }

  _half() {
    const h = this.query?.half ?? this.combat?.world?.half;
    return Number.isFinite(h) ? h : Infinity;
  }
}

function v0() { return { x: 0, y: 0, z: 0 }; }
