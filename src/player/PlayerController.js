// 입력 → 이동 컴포넌트 의도. 마우스 시점은 지연 없이 즉각 반영.
import { CONFIG } from '../config.js';
import { clamp } from '../core/math.js';
import { EventEmitter } from '../core/EventEmitter.js';

export class PlayerController extends EventEmitter {
  constructor(motor, input, settings) {
    super();
    this.motor = motor;
    this.input = input;
    this.settings = settings;
    this.yaw = motor.yaw;
    this.pitch = 0;
    this.quiet = false;
  }

  update(dt) {
    void dt;
    const K = CONFIG.controls;
    const inp = this.input;
    const m = this.motor;

    // 시점 (즉각)
    const { dx, dy } = inp.consumeMouse();
    const sens = CONFIG.camera.sensitivity * this.settings.get('sensitivity');
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    let up = CONFIG.camera.pitchLimitDeg, down = CONFIG.camera.pitchLimitDeg;
    if (m.stance === 'prone' && m.stanceProgress > 0.6) {
      up = CONFIG.camera.pronePitchLimitDeg.up;
      down = CONFIG.camera.pronePitchLimitDeg.down;
    }
    this.pitch = clamp(this.pitch, -down * Math.PI / 180, up * Math.PI / 180);
    m.yaw = this.yaw;

    // 이동
    const f = (inp.isDown(K.forward) ? 1 : 0) - (inp.isDown(K.back) ? 1 : 0);
    const r = (inp.isDown(K.right) ? 1 : 0) - (inp.isDown(K.left) ? 1 : 0);
    m.input.move.x = r;
    m.input.move.z = f;
    m.input.sprint = inp.isDown(K.sprint);

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

  _stance(s, silent = false) {
    const ok = this.motor.requestStance(s);
    if (!ok && !silent) {
      const why = !this.motor.stanceAllowed(s)
        ? (this.motor.restrictions.size ? '몸을 가눌 수 없다' : '여기서는 불가능하다')
        : '';
      if (why) this.emit('toast', why);
    }
    return ok;
  }
}
