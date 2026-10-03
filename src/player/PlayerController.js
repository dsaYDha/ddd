// 입력 → 이동 컴포넌트 의도 + 사격 입력. 마우스 시점은 지연 없이 즉각 반영.
//  2단계: 좌클릭 사격 (끌어서 보기 모드에선 F) / 우클릭 누르기 조준 / 조준 중 Shift = 숨 참기 (달리기 아님) /
//         R 재장전·고장 해결 / B 사격 모드 / T 탄창 확인 → weaponInput (Shooter.update 의 input)
//         조준 중(전환 포함)에는 이동 제한 'aiming' (속도 × aim.adsMoveMul, 달리기 불가). 방아쇠를 당기면 달리기를 멈춘다.
//  3단계: locked = true 이면 (총에 맞은 충격·사망) 마우스·키 입력을 모두 버린다 — 이동·시점·자세·사격 없음.
import { CONFIG } from '../config.js';
import { clamp } from '../core/math.js';
import { EventEmitter } from '../core/EventEmitter.js';

const DEG = Math.PI / 180;

export class PlayerController extends EventEmitter {
  constructor(motor, input, settings) {
    super();
    this.motor = motor;
    this.input = input;
    this.settings = settings;
    this.yaw = motor.yaw;
    this.pitch = 0;
    this.quiet = false;
    // 이번 프레임 마우스 시점 변화 (rad) — 무기 관성(AimModel) 입력. 반동으로 움직인 시선은 들어가지 않는다
    this.lookDeltaYaw = 0;
    this.lookDeltaPitch = 0;
    this.aim = null;   // AimModel (Game 이 붙임) — 우클릭을 놓은 뒤 총을 내리는 동안에도 조준 이동 제한 유지
    this.weaponInput = { trigger: false, triggerPressed: false, aim: false, holdBreath: false, reload: false, mode: false, magCheck: false };
    this.locked = false;
  }

  update(dt) {
    void dt;
    const K = CONFIG.controls;
    const inp = this.input;
    const m = this.motor;

    // 시점 (즉각)
    const { dx, dy } = inp.consumeMouse();
    if (this.locked) {
      // 충격·사망: 입력을 버림 (마우스 이동량도 소비해 풀리는 순간 시점이 튀지 않게)
      this.lookDeltaYaw = 0; this.lookDeltaPitch = 0;
      const W = this.weaponInput;
      W.aim = W.trigger = W.triggerPressed = W.holdBreath = W.reload = W.mode = W.magCheck = false;
      m.input.move.x = 0; m.input.move.z = 0; m.input.sprint = false; m.input.jump = false; m.input.lean = 0;
      if (m.restrictions.has('aiming')) m.clearRestriction('aiming');
      return;
    }
    const sens = CONFIG.camera.sensitivity * this.settings.get('sensitivity');
    const yaw0 = this.yaw, pitch0 = this.pitch;
    this.yaw -= dx * sens;
    this.pitch = this._clampPitch(this.pitch - dy * sens);
    this.lookDeltaYaw = this.yaw - yaw0;
    this.lookDeltaPitch = this.pitch - pitch0;
    m.yaw = this.yaw;

    // 사격 입력 — 끌어서 보기 모드에서는 왼쪽 버튼이 시점 끌기라 F 로 쏜다
    const W = this.weaponInput;
    const aimHeld = inp.isDown(K.aim);
    const shift = inp.isDown(K.sprint);
    W.aim = aimHeld;
    W.trigger = (!inp.dragLook && inp.isDown(K.fire)) || inp.isDown(K.fireAlt);
    W.triggerPressed = (!inp.dragLook && inp.pressed(K.fire)) || inp.pressed(K.fireAlt);
    W.holdBreath = aimHeld && shift;
    W.reload = inp.pressed(K.reload);
    W.mode = inp.pressed(K.fireMode);
    W.magCheck = inp.pressed(K.magCheck);
    const aiming = aimHeld || (this.aim ? this.aim.ads > 0.02 : false);
    const cur = m.restrictions.get('aiming');
    if (aiming && (!cur || cur.maxSpeedMultiplier !== CONFIG.aim.adsMoveMul)) {
      m.setRestriction('aiming', { maxSpeedMultiplier: CONFIG.aim.adsMoveMul, canSprint: false });
    } else if (!aiming && cur) m.clearRestriction('aiming');

    // 이동
    const f = (inp.isDown(K.forward) ? 1 : 0) - (inp.isDown(K.back) ? 1 : 0);
    const r = (inp.isDown(K.right) ? 1 : 0) - (inp.isDown(K.left) ? 1 : 0);
    m.input.move.x = r;
    m.input.move.z = f;
    // 조준 중 Shift 는 숨 참기, 방아쇠를 당기고 있으면 달리지 않음
    m.input.sprint = shift && !aimHeld && !W.trigger;

    if (inp.pressed(K.quiet)) {
      this.quiet = !this.quiet;
      this.emit('toast', this.quiet ? '조용히 걷기' : '보통 걸음');
    }
    m.input.quiet = this.quiet && !m.input.sprint;

    // 자세
    if (inp.pressed(K.crouch)) {
      if (m.stance === 'crouch') this._stance('stand');
      else this._stance('crouch');
    }
    if (inp.pressed(K.prone)) {
      if (m.stance === 'prone') { if (!this._stance('stand', true)) this._stance('crouch'); }
      else this._stance('prone');
    }
    if (inp.pressed(K.jump)) {
      if (m.stance === 'stand') m.input.jump = true;
      else if (m.stance === 'crouch') this._stance('stand');
    }
    // 앉은 채 달리기 → 일어서서 달림
    if (m.input.sprint && f > 0 && m.stance === 'crouch' && !m.transitioning && inp.pressed(K.sprint)) this._stance('stand', true);

    // 기울이기 (누르고 있는 동안)
    m.input.lean = (inp.isDown(K.leanRight) ? 1 : 0) - (inp.isDown(K.leanLeft) ? 1 : 0);
  }

  /** 반동 등 마우스가 아닌 시선 변화 (rad) — 관성 입력(lookDelta)에는 넣지 않는다 */
  addLook(dyaw, dpitch) {
    this.yaw += dyaw;
    this.pitch = this._clampPitch(this.pitch + dpitch);
    this.motor.yaw = this.yaw;
  }

  _clampPitch(p) {
    const m = this.motor;
    let up = CONFIG.camera.pitchLimitDeg, down = CONFIG.camera.pitchLimitDeg;
    if (m.stance === 'prone' && m.stanceProgress > 0.6) {
      up = CONFIG.camera.pronePitchLimitDeg.up;
      down = CONFIG.camera.pronePitchLimitDeg.down;
    }
    return clamp(p, -down * DEG, up * DEG);
  }

  _stance(s, silent = false) {
    const ok = this.motor.requestStance(s);
    if (!ok && !silent) {
      // 조준 제한('aiming')은 자세를 막지 않으므로 '몸을 가눌 수 없다'의 이유가 아니다
      let restricted = false;
      for (const k of this.motor.restrictions.keys()) if (k !== 'aiming') restricted = true;
      const why = !this.motor.stanceAllowed(s)
        ? (restricted ? '몸을 가눌 수 없다' : '여기서는 불가능하다')
        : '';
      if (why) this.emit('toast', why);
    }
    return ok;
  }
}
