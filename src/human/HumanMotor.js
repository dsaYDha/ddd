// =====================================================================
//  HumanMotor — '사람' 공용 이동 컴포넌트
//  플레이어 전용이 아니다. 4단계 적 병사도 같은 컴포넌트를 써서
//  같은 진흙·경사·스태미나·자세 규칙을 받는다.
//
//  입력:  motor.input (move, sprint, quiet, jump, lean), motor.yaw, motor.requestStance()
//  출력:  position(발 위치), eyeHeight, stamina, heartRate, breath, surface, sink, ...
//  이벤트: 'footstep' | 'land' | 'suction' | 'stance' | 'slide' | 'exhausted' | 'recovered'
//  외부 제한: setRestriction(name, {canStand, canCrouch, canProne, canSprint, canJump, maxSpeedMultiplier})
//            (3단계: 총상으로 거동 불능이 될 때 사용)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { approach, clamp, lerp, smoothstep, DEG } from '../core/math.js';
import { SURFACE, surfaceProps, surfaceKey, isVegetation } from '../world/Surfaces.js';

export const STANCES = ['stand', 'crouch', 'prone'];

const DEFAULT_CAPS = Object.freeze({
  canStand: true, canCrouch: true, canProne: true, canSprint: true, canJump: true, maxSpeedMultiplier: 1,
});

export class HumanMotor extends EventEmitter {
  /**
   * @param {import('../world/WorldQuery.js').WorldQuery} world
   * @param {{x:number, z:number, yaw?:number, noise?:import('../core/NoiseEvents.js').NoiseEvents, name?:string, loadKg?:number}} opts
   */
  constructor(world, opts = {}) {
    super();
    this.world = world;
    this.noise = opts.noise || null;
    this.name = opts.name || 'human';
    this.loadKg = opts.loadKg ?? CONFIG.load.baseKg;

    this.position = { x: opts.x ?? 0, y: 0, z: opts.z ?? 0 };   // y = 발 높이 (빠진 깊이 반영)
    this.velocity = { x: 0, z: 0 };       // 걷기로 제어되는 수평 속도
    this.slideVel = { x: 0, z: 0 };       // 경사 미끄러짐
    this.vy = 0;
    this.grounded = true;
    this.yaw = opts.yaw ?? 0;

    this.input = { move: { x: 0, z: 0 }, sprint: false, quiet: false, jump: false, lean: 0 };

    // 자세
    this.stance = 'stand';
    this.stanceFrom = 'stand';
    this.stanceProgress = 1;
    this.stanceDuration = 0;
    this.eyeHeight = CONFIG.stance.eyeHeight.stand;
    this.lean = 0;                        // -1 ~ 1 (실제 적용량)
    this.leanOffset = 0;                  // m (+ 오른쪽)
    this.leanRoll = 0;                    // rad

    // 진흙
    this.sink = 0;
    this.stillTime = 0;
    this.extracting = false;
    this.extractTimer = 0;
    this.extractDuration = 0;
    this.extractFrom = 0;

    // 스태미나·심박
    this.stamina = CONFIG.stamina.max;
    this.exhausted = false;
    this.heartRate = CONFIG.heart.rest;
    this.breath = 0;                      // 0~1 숨 가쁨
    this.effort = 0;
    this.drainRate = 0;
    this.regenRate = 0;

    // 걸음
    this.gait = 'idle';
    this.gaitPhase = 0;
    this.moveFactor = 0;                  // 0~1 (머리 흔들림 세기)
    this.speed = 0;                       // 실제 수평 속도
    this.targetSpeed = 0;
    this.lastNoiseRadius = 0;
    this.lastNoiseKind = '';
    this._slideNoiseTimer = 0;

    // 지면
    this.surface = SURFACE.LEAF_LITTER;
    this.ground = { terrain: 0, support: 0, waterDepth: 0, waterLevel: 0, onDike: false, obstacle: null };
    this.slope = { deg: 0, gx: 0, gz: 0 };
    this.uphillDeg = 0;
    this.sliding = false;
    this.landedTimer = 0;
    this.lastLandSpeed = 0;

    // 외부 이동 능력 제한
    this.restrictions = new Map();
    this.caps = { ...DEFAULT_CAPS };

    this.teleport(this.position.x, this.position.z, this.yaw);
  }

  // -----------------------------------------------------------------
  // 외부 API
  // -----------------------------------------------------------------
  teleport(x, z, yaw = this.yaw) {
    this.position.x = x;
    this.position.z = z;
    this.yaw = yaw;
    this.velocity.x = this.velocity.z = 0;
    this.slideVel.x = this.slideVel.z = 0;
    this.vy = 0;
    this.grounded = true;
    this.sink = 0;
    this.stillTime = 0;
    this.extracting = false;
    // 나무·대나무 안으로 순간이동하지 않게 밀어냄
    this.world.resolveCircles(this.position, CONFIG.movement.radius + 0.05, -1e4, 1e4);
    this._readGround();
    this.position.y = this.ground.support;
  }

  /** 이동 능력 제한 걸기 (이름별로 누적, 가장 엄격한 값이 적용됨) */
  setRestriction(name, restriction) {
    this.restrictions.set(name, restriction);
    this._recomputeCaps();
  }

  clearRestriction(name) {
    this.restrictions.delete(name);
    this._recomputeCaps();
  }

  hasRestriction(name) {
    return this.restrictions.has(name);
  }

  _recomputeCaps() {
    const c = { ...DEFAULT_CAPS };
    for (const r of this.restrictions.values()) {
      for (const k of ['canStand', 'canCrouch', 'canProne', 'canSprint', 'canJump']) {
        if (r[k] === false) c[k] = false;
      }
      if (r.maxSpeedMultiplier !== undefined) c.maxSpeedMultiplier = Math.min(c.maxSpeedMultiplier, r.maxSpeedMultiplier);
    }
    if (!c.canStand && !c.canCrouch) c.canProne = true; // 최소한 기어갈 수는 있게
    this.caps = c;
  }

  /** 자세 변경 요청. 불가능하면 false */
  requestStance(target) {
    if (target === this.stance && this.stanceProgress >= 1) return false;
    if (this.stanceProgress < 1) {
      // 전환 중에는 되돌리기만 허용
      if (target !== this.stanceFrom) return false;
    }
    if (!this.stanceAllowed(target)) return false;
    this._beginStance(target);
    return true;
  }

  /** 자세 허용 여부 (외부 제한 + 지형) */
  stanceAllowed(stance) {
    const c = this.caps;
    if (stance === 'stand' && !c.canStand) return false;
    if (stance === 'crouch' && !c.canCrouch) return false;
    if (stance === 'prone' && !c.canProne) return false;
    return this._stanceAllowedHere(stance);
  }

  _stanceAllowedHere(stance) {
    const sp = surfaceProps(this.surface);
    const depth = this.ground.waterDepth;
    if (stance === 'prone') return !sp.noProne && depth <= 0.3;
    if (stance === 'crouch') return depth <= 0.8;
    return true;
  }

  _beginStance(target, durationOverride) {
    // 전환 도중 되돌리기: 같은 시간 축을 거꾸로 (눈높이가 튀지 않게)
    if (this.stanceProgress < 1 && target === this.stanceFrom) {
      this.stanceFrom = this.stance;
      this.stance = target;
      this.stanceProgress = 1 - this.stanceProgress;
      return;
    }
    const key = `${this.stance}>${target}`;
    const dur = durationOverride ?? CONFIG.stance.transition[key] ?? 0.5;
    if (this.stance === 'prone' && target === 'stand') this.stamina = Math.max(0, this.stamina - CONFIG.stamina.proneToStandCost);
    this.stanceFrom = this.stance;
    this.stance = target;
    this.stanceDuration = Math.max(0.05, dur);
    this.stanceProgress = 0;
    const r = target === 'prone' ? CONFIG.noise.stanceChangeRadius.prone : CONFIG.noise.stanceChangeRadius.other;
    this._noise(r, 'stance');
    this.emit('stance', { from: this.stanceFrom, to: target, duration: this.stanceDuration });
  }

  get transitioning() { return this.stanceProgress < 1; }

  /** 카메라(눈) 월드 높이 */
  get eyeY() { return this.position.y + this.eyeHeight; }

  // -----------------------------------------------------------------
  // 메인 업데이트
  // -----------------------------------------------------------------
  update(dt) {
    // 큰 dt는 나눠서 처리 (안정성)
    const maxStep = 1 / 60;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(maxStep, remaining);
      this._step(h);
      remaining -= h;
    }
    this.input.jump = false;
  }

  _step(dt) {
    const C = CONFIG;
    const wetF = this._wetFactor();

    this._readGround();
    const sp = surfaceProps(this.surface);

    // ------------------------------------------------ 자세
    this._enforceStance();
    if (this.stanceProgress < 1) {
      this.stanceProgress = Math.min(1, this.stanceProgress + dt / this.stanceDuration);
    }
    const eyeFrom = C.stance.eyeHeight[this.stanceFrom];
    const eyeTo = C.stance.eyeHeight[this.stance];
    let eye = lerp(eyeFrom, eyeTo, smoothstep(0, 1, this.stanceProgress));
    // 물에 잠긴 채 엎드리거나 앉으면 머리를 물 위로 든다
    if (this.ground.waterLevel > -1000) {
      const minEye = this.ground.waterLevel + 0.12 - this.position.y;
      if (eye < minEye) eye = Math.min(minEye, C.stance.eyeHeight.stand);
    }
    this.eyeHeight = eye;

    // ------------------------------------------------ 이동 의도
    const mv = this.input.move;
    let mx = mv.x, mz = mv.z;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }
    const intent = Math.min(1, mag);
    const moving = intent > 0.1;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // yaw 0 = -Z(북). forward = (-sin, -cos), right = (cos, -sin)
    let dirX = cos * mx - sin * mz;
    let dirZ = -sin * mx - cos * mz;
    const dl = Math.hypot(dirX, dirZ);
    if (dl > 1e-5) { dirX /= dl; dirZ /= dl; }

    // ------------------------------------------------ 걸음걸이 결정
    const stance = this.stance;
    const caps = this.caps;
    const canSprintNow = this.input.sprint && mz > 0.3 && stance === 'stand' && !this.transitioning && caps.canSprint &&
      !sp.noSprint && !this.exhausted && this.stamina > 0 && this.grounded;
    let gait = 'idle';
    if (moving) {
      if (stance === 'prone') gait = 'prone';
      else if (stance === 'crouch') gait = 'crouch';
      else if (canSprintNow) gait = 'sprint';
      else if (this.input.quiet) gait = 'quiet';
      else gait = 'walk';
    }
    this.gait = gait;

    // ------------------------------------------------ 목표 속도
    let speed = 0;
    if (moving) {
      speed = C.movement.speed[gait] * intent;
      if (stance === 'crouch' && this.input.quiet) speed *= 0.7;
      // 방향 (뒤·옆)
      const side = Math.abs(mx) / (Math.abs(mx) + Math.abs(mz) + 1e-6);
      speed *= lerp(1, C.movement.strafeMul, side);
      if (mz < -0.1) speed *= C.movement.backwardMul;
      // 장비 무게
      const extraKg = Math.max(0, this.loadKg - C.load.freeKg);
      speed *= 1 - extraKg * C.load.speedPerKg - (gait === 'sprint' ? extraKg * C.load.sprintPerKg : 0);
      // 지면 (젖음도 반영)
      speed *= sp.speed * (1 - sp.wetSpeed * wetF);
      // 경사
      const up = (this.slope.gx * dirX + this.slope.gz * dirZ);
      this.uphillDeg = Math.atan(up) / DEG;
      speed *= this._slopeSpeedMul(this.uphillDeg);
      // 지침
      if (this.stamina < C.movement.lowStaminaThreshold) {
        speed *= lerp(C.movement.lowStaminaSpeedMul, 1, this.stamina / C.movement.lowStaminaThreshold);
      }
      // 외부 제한 (부상 등)
      speed *= caps.maxSpeedMultiplier;
      // 자세 전환 중
      if (this.transitioning) speed *= C.stance.moveMulDuringTransition;
      // 진흙에서 발 빼는 중
      if (this.extracting) speed *= C.mud.extractSpeedMul;
    } else {
      this.uphillDeg = 0;
    }
    const nominal = speed;
    // 걸음 주기에 맞춘 출렁임 (진흙에서 발을 빼는 느낌)
    const pulseAmp = sp.stepPulse * (stance === 'prone' ? 0.4 : 1);
    const pulse = pulseAmp > 0 ? (1 - pulseAmp * (0.5 + 0.5 * Math.cos(this.gaitPhase * Math.PI * 2))) / (1 - pulseAmp / 2) : 1;
    speed *= pulse;
    this.targetSpeed = nominal;

    let tvx = dirX * speed, tvz = dirZ * speed;
    // 35° 이상 오르막 성분 제거
    const gmag = Math.hypot(this.slope.gx, this.slope.gz);
    if (this.slope.deg >= C.slope.maxClimbDeg && gmag > 1e-4) {
      const ux = this.slope.gx / gmag, uz = this.slope.gz / gmag;
      const upc = tvx * ux + tvz * uz;
      if (upc > 0) { tvx -= ux * upc; tvz -= uz * upc; }
    }

    // ------------------------------------------------ 가속 (지면별 관성)
    const air = !this.grounded;
    const accel = (speed > 0.01 ? sp.accel : sp.decel) * (air ? C.movement.airControl : 1);
    const dvx = tvx - this.velocity.x, dvz = tvz - this.velocity.z;
    const dvl = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dvl > maxDv) {
      this.velocity.x += (dvx / dvl) * maxDv;
      this.velocity.z += (dvz / dvl) * maxDv;
    } else {
      this.velocity.x = tvx;
      this.velocity.z = tvz;
    }
    if (this.slope.deg >= C.slope.maxClimbDeg && gmag > 1e-4) {
      const ux = this.slope.gx / gmag, uz = this.slope.gz / gmag;
      const upc = this.velocity.x * ux + this.velocity.z * uz;
      if (upc > 0) { this.velocity.x -= ux * upc; this.velocity.z -= uz * upc; }
    }

    // ------------------------------------------------ 미끄러짐
    this._updateSlip(dt, sp, wetF, gait);

    // ------------------------------------------------ 점프
    if (this.input.jump) this._tryJump(sp);

    // ------------------------------------------------ 수평 이동 + 충돌
    this._move(dt);

    // ------------------------------------------------ 수직 (지지면·낙하·착지)
    this._readGround();
    const sp2 = surfaceProps(this.surface);
    this._updateSink(dt, sp2, wetF, moving);
    this._vertical(dt, sp2);

    // ------------------------------------------------ 걸음 주기·발소리
    const vx = this.velocity.x + this.slideVel.x, vz = this.velocity.z + this.slideVel.z;
    this.speed = Math.hypot(vx, vz);
    const walkSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveFactor = approach(this.moveFactor, moving && walkSpeed > 0.05 ? 1 : 0, dt * 3);
    if (this.grounded && moving && walkSpeed > 0.04) {
      const stride = this._strideLength(gait) * sp2.stride;
      const deP = walkSpeed / Math.max(0.35, pulse);
      const before = Math.floor(this.gaitPhase);
      this.gaitPhase += (deP / stride) * dt;
      if (Math.floor(this.gaitPhase) !== before) this._footstep(gait, sp2);
    }

    // ------------------------------------------------ 기울이기
    this._updateLean(dt);

    // ------------------------------------------------ 스태미나·심박
    this._updateStamina(dt, sp2, wetF, gait, moving);
    this.landedTimer = Math.max(0, this.landedTimer - dt);
  }

  // -----------------------------------------------------------------
  _wetFactor() {
    const base = CONFIG.weather.presets.clear.wetness;
    return clamp((this.world.wetness - base) / (1 - base), 0, 1);
  }

  _readGround() {
    const g = this.world.getGroundInfo(this.position.x, this.position.z);
    const o = this.ground;
    o.terrain = g.terrain; o.support = g.support; o.waterDepth = g.waterDepth; o.waterLevel = g.waterLevel;
    o.onDike = g.onDike; o.obstacle = g.obstacle;
    this.surface = g.surface;
    this.world.getSlope(this.position.x, this.position.z, this.slope);
    // 장애물·논둑 위에서는 지형 경사 무시
    if (g.obstacle || (g.onDike && g.support > g.terrain + 0.05)) { this.slope.deg = 0; this.slope.gx = 0; this.slope.gz = 0; }
  }

  _slopeSpeedMul(upDeg) {
    const S = CONFIG.slope;
    if (upDeg > S.slowStartDeg) {
      return lerp(1, S.minUphillSpeedMul, clamp((upDeg - S.slowStartDeg) / (S.maxClimbDeg - S.slowStartDeg), 0, 1));
    }
    if (upDeg < -20) return S.downhillSpeedMul;
    return 1;
  }

  _strideLength(gait) {
    const M = CONFIG.movement;
    if (gait === 'sprint') return M.sprintStrideLength;
    if (gait === 'crouch') return M.crouchStrideLength;
    if (gait === 'prone') return M.proneStrideLength;
    return M.standStrideLength;
  }

  _enforceStance() {
    // 외부 제한·지형 때문에 현재 자세가 불가능해지면 가능한 자세로 강제 전환
    if (this.stanceProgress < 1) return;
    if (this.stanceAllowed(this.stance)) return;
    const c = this.caps;
    const order = this.stance === 'prone' ? ['crouch', 'stand'] : this.stance === 'crouch' ? ['stand', 'prone'] : ['crouch', 'prone'];
    for (const s of order) {
      if (this.stanceAllowed(s)) { this._beginStance(s, s === 'prone' && !c.canCrouch ? 0.6 : undefined); return; }
    }
    // 지형상 가능한 자세가 없는데 제한 때문에 엎드려야 한다면 엎드림 유지 (머리만 듦)
    if (!c.canStand && !c.canCrouch && this.stance !== 'prone') this._beginStance('prone', 0.6);
  }

  _updateSlip(dt, sp, wetF, gait) {
    const S = CONFIG.slope;
    const g = CONFIG.movement.gravity;
    const deg = this.slope.deg;
    const gmag = Math.hypot(this.slope.gx, this.slope.gz);
    let a = 0;
    if (this.grounded && gmag > 1e-4 && this.ground.waterDepth < 0.3) {
      const slip = sp.slip + sp.wetSlip * wetF;
      const startDeg = sp.slipDeg - S.slipWetReductionDeg * wetF;
      const th = deg * DEG;
      if (slip >= S.minSlipperiness && deg > startDeg) {
        a = g * (Math.sin(th) - Math.tan(startDeg * DEG) * Math.cos(th)) * slip * S.slipAccel;
      }
      if (deg > S.cliffDeg) a = Math.max(a, g * (Math.sin(th) - 0.55 * Math.cos(th)));
      if (a > 0) {
        if (gait === 'sprint') a *= S.slipSprintMul;
        else if (gait === 'prone') a *= 0.6;
      }
    }
    if (a > 0) {
      const ux = -this.slope.gx / gmag, uz = -this.slope.gz / gmag; // 내리막 방향
      this.slideVel.x += ux * a * dt;
      this.slideVel.z += uz * a * dt;
      const k = Math.exp(-S.slipDamping * dt);
      this.slideVel.x *= k; this.slideVel.z *= k;
    } else {
      const k = Math.exp(-S.slipStopDamping * dt);
      this.slideVel.x *= k; this.slideVel.z *= k;
    }
    const sv = Math.hypot(this.slideVel.x, this.slideVel.z);
    this.sliding = sv > 0.25;
    if (this.sliding) {
      this._slideNoiseTimer -= dt;
      if (this._slideNoiseTimer <= 0) {
        this._slideNoiseTimer = 0.6;
        this._noise(CONFIG.noise.slideRadius * clamp(sv / 1.5, 0.4, 1.4), 'slide');
        this.emit('slide', { speed: sv, surface: this.surface });
      }
    } else {
      this._slideNoiseTimer = 0;
    }
  }

  _tryJump(sp) {
    const C = CONFIG;
    if (!this.grounded || this.stance !== 'stand' || this.transitioning) return false;
    if (!this.caps.canJump || sp.noJump || this.ground.waterDepth > 0.12) return false;
    if (this.sink > 0.06 || this.stamina < C.stamina.jumpCost * 0.5) return false;
    const h = C.movement.jumpHeight * (this.exhausted ? 0.7 : 1);
    this.vy = Math.sqrt(2 * C.movement.gravity * h);
    this.grounded = false;
    this.stamina = Math.max(0, this.stamina - C.stamina.jumpCost);
    this.emit('jump', {});
    return true;
  }

  _move(dt) {
    const p = this.position;
    const dx = (this.velocity.x + this.slideVel.x) * dt;
    const dz = (this.velocity.z + this.slideVel.z) * dt;
    if (Math.abs(dx) + Math.abs(dz) < 1e-7) return;
    if (this._canMoveTo(p.x + dx, p.z + dz, dx, dz)) {
      p.x += dx; p.z += dz;
    } else if (Math.abs(dx) > 1e-7 && this._canMoveTo(p.x + dx, p.z, dx, 0)) {
      p.x += dx;
      this.velocity.z = 0; this.slideVel.z = 0;
    } else if (Math.abs(dz) > 1e-7 && this._canMoveTo(p.x, p.z + dz, 0, dz)) {
      p.z += dz;
      this.velocity.x = 0; this.slideVel.x = 0;
    } else {
      this.velocity.x = this.velocity.z = 0;
      this.slideVel.x = this.slideVel.z = 0;
    }
    const bodyH = CONFIG.stance.bodyHeight[this.stance];
    if (this.world.resolveCircles(p, CONFIG.movement.radius, p.y, p.y + bodyH)) {
      // 나무에 부딪히면 그 방향 속도 감소
      this.velocity.x *= 0.85; this.velocity.z *= 0.85;
    }
    this.world.clampToBounds(p);
  }

  _canMoveTo(nx, nz, dx, dz) {
    const C = CONFIG.movement;
    const world = this.world;
    // 가슴 이상 깊은 물 진입 불가
    if (world.getWaterDepth(nx, nz) > C.maxWadeDepth) {
      // 이미 그 깊이에 있다면 (밀려 들어간 경우) 얕아지는 쪽은 허용
      if (world.getWaterDepth(nx, nz) >= world.getWaterDepth(this.position.x, this.position.z)) return false;
    }
    const len = Math.hypot(dx, dz) || 1;
    const r = C.radius * 0.9;
    const lx = nx + (dx / len) * r, lz = nz + (dz / len) * r;
    const supLead = world.getSupportHeight(lx, lz);
    const supNew = world.getSupportHeight(nx, nz);
    const standRef = this.grounded ? this.position.y + this.sink : this.position.y;
    const limit = standRef + C.stepHeight * (this.grounded ? 1 : 0.8);
    return Math.max(supLead, supNew) <= limit;
  }

  _updateSink(dt, sp, wetF, moving) {
    const M = CONFIG.mud;
    const proneMul = this.stance === 'prone' ? 0.35 : 1;
    const onSolid = this.ground.obstacle || this.ground.onDike;
    const wetMul = 1 + 0.15 * wetF;
    const sinkMove = onSolid ? 0 : sp.sink * proneMul * wetMul;
    const sinkStill = onSolid ? 0 : Math.max(sinkMove, sp.sinkStill * proneMul * wetMul);
    if (!this.grounded) return;

    if (!moving) {
      this.stillTime += dt;
      this.extracting = false;
      if (this.sink < sinkMove) this.sink = approach(this.sink, sinkMove, 0.6 * dt);
      else if (sinkStill > sinkMove) this.sink = approach(this.sink, sinkStill, ((sinkStill - sinkMove) / M.stillSinkTime) * dt);
      else this.sink = approach(this.sink, sinkMove, M.sinkRecoverRate * dt);
      return;
    }
    this.stillTime = 0;
    if (!this.extracting && this.sink > sinkMove + M.extractMinExcess && sinkMove > 0) {
      const excess = this.sink - sinkMove;
      const frac = clamp(excess / Math.max(0.05, sinkStill - sinkMove), 0.3, 1);
      this.extracting = true;
      this.extractDuration = M.extractTime * frac;
      this.extractTimer = this.extractDuration;
      this.extractFrom = this.sink;
      this._noise(CONFIG.noise.suctionRadius * frac, 'suction');
      this.emit('suction', { intensity: frac, surface: this.surface, x: this.position.x, y: this.position.y, z: this.position.z });
    }
    if (this.extracting) {
      this.extractTimer -= dt;
      const k = Math.max(0, this.extractTimer / this.extractDuration);
      this.sink = lerp(sinkMove, this.extractFrom, k * k);
      if (this.extractTimer <= 0) this.extracting = false;
    } else {
      const rate = this.sink < sinkMove ? 0.6 : M.sinkRecoverRate;
      this.sink = approach(this.sink, sinkMove, rate * dt);
    }
  }

  _vertical(dt, sp) {
    const p = this.position;
    const support = this.ground.support;
    const groundFeet = support - this.sink;
    if (this.grounded) {
      if (groundFeet < p.y - 0.4) {
        // 턱에서 떨어짐
        this.grounded = false;
        this.vy = 0;
      } else {
        p.y = groundFeet;
        return;
      }
    }
    this.vy -= CONFIG.movement.gravity * dt;
    p.y += this.vy * dt;
    if (p.y <= groundFeet) {
      const fall = -this.vy;
      p.y = groundFeet;
      this.vy = 0;
      this.grounded = true;
      this.lastLandSpeed = fall;
      this.landedTimer = 0.35;
      if (fall > 1.2) {
        const k = clamp(fall / 3, 0.4, 1.6);
        this._noise(sp.noise * CONFIG.noise.landingMul * k, 'land');
        this.emit('land', { speed: fall, surface: this.surface, x: p.x, y: p.y, z: p.z, waterDepth: this.ground.waterDepth });
      }
    }
  }

  _footstep(gait, sp) {
    const G = CONFIG.noise.gaitMul;
    let mul = G[gait] ?? 1;
    if (this.input.quiet && gait === 'crouch') mul *= 0.6;
    const radius = sp.noise * mul;
    const intensity = clamp(mul, 0.2, 1.8);
    this._noise(radius, 'footstep');
    this.emit('footstep', {
      surface: this.surface, surfaceKey: surfaceKey(this.surface), sound: sp.sound,
      gait, stance: this.stance, intensity, radius,
      x: this.position.x, y: this.position.y, z: this.position.z,
      waterDepth: this.ground.waterDepth, sink: this.sink, foot: Math.floor(this.gaitPhase) % 2 ? 'R' : 'L',
      onObstacle: !!this.ground.obstacle,
    });
    // 식물을 헤치고 지나가는 소리 — 식물 종류(지면)별 반경
    if (sp.rustle && isVegetation(this.surface) && !this.ground.obstacle) {
      const R = CONFIG.noise.rustleGaitMul;
      let k = R[gait] ?? 1;
      if (this.input.quiet && gait === 'crouch') k *= 0.7;
      const rr = sp.rustle * k;
      this._noise(rr, 'rustle');
      this.emit('rustle', { surface: this.surface, surfaceKey: surfaceKey(this.surface), radius: rr, gait, x: this.position.x, y: this.position.y, z: this.position.z });
    }
  }

  _noise(radius, kind) {
    this.lastNoiseRadius = radius * (this.noise ? this.noise.maskFactor() : 1);
    this.lastNoiseKind = kind;
    if (this.noise) this.noise.emitNoise({ x: this.position.x, y: this.position.y + 0.5, z: this.position.z }, radius, kind, this);
  }

  _updateLean(dt) {
    const L = CONFIG.lean;
    let target = clamp(this.input.lean, -1, 1);
    if (this.stance === 'prone') target *= L.proneMul;
    if (this.transitioning || this.gait === 'sprint') target = 0;
    // 나무·지형에 막히면 덜 기울어짐
    if (Math.abs(target) > 0.01) {
      const side = Math.sign(target);
      const rx = Math.cos(this.yaw) * side, rz = -Math.sin(this.yaw) * side;
      const eyeY = this.position.y + this.eyeHeight;
      let allowed = Math.abs(target);
      for (const f of [0.35, 0.7, 1.0]) {
        const d = L.offset * f * Math.abs(target) + L.clearance;
        const hx = this.position.x + rx * d, hz = this.position.z + rz * d;
        const clear = this.world.clearanceAt(hx, hz, eyeY);
        const terrainBlock = this.world.getSupportHeight(hx, hz) > eyeY - 0.12;
        if (clear < 0 || terrainBlock) {
          allowed = Math.min(allowed, Math.max(0, (L.offset * f * Math.abs(target) - L.clearance) / L.offset));
          break;
        }
      }
      target = side * allowed;
    }
    this.lean = lerp(this.lean, target, 1 - Math.exp(-L.speed * dt));
    this.leanOffset = this.lean * L.offset;
    this.leanRoll = this.lean * L.rollDeg * DEG;
  }

  _updateStamina(dt, sp, wetF, gait, moving) {
    const S = CONFIG.stamina;
    const H = CONFIG.heart;
    const walkSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const active = moving && (walkSpeed > 0.05 || this.extracting);
    let drain = 0, regen;
    if (active) {
      drain = S.drain[gait] ?? S.drain.walk;
      const extraKg = Math.max(0, this.loadKg - CONFIG.load.freeKg);
      drain *= 1 + extraKg * CONFIG.load.staminaPerKg;
      drain *= sp.stamina * (1 + sp.wetStamina * wetF);
      if (this.uphillDeg > 5) drain *= 1 + (this.uphillDeg - 5) * CONFIG.slope.uphillStaminaPerDeg;
      regen = gait === 'sprint' ? S.regen.sprint : S.regen.moving;
    } else {
      regen = S.regen.idle;
    }
    if (this.sliding) drain += S.slipStruggleDrain;
    this.drainRate = drain;
    this.regenRate = regen;
    this.stamina = clamp(this.stamina + (regen - drain) * dt, 0, S.max);

    if (!this.exhausted && this.stamina <= 0) {
      this.exhausted = true;
      this.emit('exhausted', {});
    } else if (this.exhausted && this.stamina >= S.exhaustedRecoverTo) {
      this.exhausted = false;
      this.emit('recovered', {});
    }

    // 심박수: 순간 노력 + 누적 피로
    const effortNow = clamp(drain / 12, 0, 1.2);
    this.effort = lerp(this.effort, effortNow, 1 - Math.exp(-1.5 * dt));
    const fatigue = Math.pow(1 - this.stamina / S.max, 1.3);
    const target = H.rest + (H.max - H.rest) * clamp(H.effortWeight * this.effort + H.fatigueWeight * fatigue + (this.exhausted ? 0.15 : 0), 0, 1);
    const rate = target > this.heartRate ? H.riseRate : H.fallRate;
    this.heartRate += (target - this.heartRate) * (1 - Math.exp(-rate * dt));
    // 숨 가쁨 (0~1): 심박 + 스태미나 부족
    const hrN = (this.heartRate - H.rest) / (H.max - H.rest);
    const breathTarget = clamp(hrN * 0.85 + fatigue * 0.45 + (this.exhausted ? 0.35 : 0), 0, 1);
    this.breath = lerp(this.breath, breathTarget, 1 - Math.exp(-2 * dt));
  }

  /** 디버그 오버레이·AI가 읽는 상태 요약 */
  getState() {
    return {
      position: this.position, eyeY: this.eyeY, stance: this.stance, transitioning: this.transitioning,
      gait: this.gait, speed: this.speed, surface: this.surface, sink: this.sink, waterDepth: this.ground.waterDepth,
      stamina: this.stamina, exhausted: this.exhausted, heartRate: this.heartRate, breath: this.breath,
      sliding: this.sliding, slopeDeg: this.slope.deg, caps: this.caps,
    };
  }
}
