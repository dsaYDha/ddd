// 최소 HUD: 조준점·체력·스태미나 바·미니맵 없음. 자세 아이콘만 구석에 작고 흐리게.
// 지침은 화면 가장자리 어두워짐(비네트)으로만 표현.
const ICONS = {
  stand: '<svg viewBox="0 0 24 40"><circle cx="12" cy="5" r="3.2"/><path d="M8 11h8l1.5 13h-3l-.8 14h-3.4l-.8-14h-3z"/></svg>',
  crouch: '<svg viewBox="0 0 24 40"><circle cx="11" cy="15" r="3.2"/><path d="M7 20h8l3 7-3 2-1 9h-3.5l.5-8-5-2z"/></svg>',
  prone: '<svg viewBox="0 0 40 24"><circle cx="34" cy="14" r="3.2"/><path d="M4 16l26-3 .5 4-26 3z"/></svg>',
};

export class HUD {
  constructor(root) {
    this.root = root;
    root.insertAdjacentHTML('beforeend', `
      <div id="vignette"></div>
      <div id="sink-shade"></div>
      <div id="stance-icon"><div class="icon"></div><div class="quiet-dot" title="조용히 걷기"></div></div>
      <div id="restrict-flag">거동 불능 시뮬레이션 (F6)</div>
      <div id="toast"></div>
    `);
    this.vignette = root.querySelector('#vignette');
    this.sinkShade = root.querySelector('#sink-shade');
    this.stanceEl = root.querySelector('#stance-icon .icon');
    this.quietDot = root.querySelector('#stance-icon .quiet-dot');
    this.restrictFlag = root.querySelector('#restrict-flag');
    this.toastEl = root.querySelector('#toast');
    this._stance = '';
    this._toastTimer = 0;
    this.pulse = 0;
  }

  toast(msg, seconds = 1.6) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this._toastTimer = seconds;
  }

  update(dt, motor, quiet) {
    if (motor.stance !== this._stance) {
      this._stance = motor.stance;
      this.stanceEl.innerHTML = ICONS[motor.stance];
      this.stanceEl.className = `icon ${motor.stance}`;
    }
    this.quietDot.style.opacity = quiet ? '1' : '0';
    this.restrictFlag.style.display = motor.restrictions.size ? 'block' : 'none';

    // 지침 비네트: 스태미나가 줄수록 가장자리가 어두워지고, 탈진 시 심장 박동에 맞춰 조여옴
    const fatigue = 1 - motor.stamina / 100;
    this.pulse += (motor.heartRate / 60) * dt;
    const beat = Math.pow(Math.max(0, Math.sin(this.pulse * Math.PI * 2)), 6);
    let v = Math.pow(fatigue, 1.6) * 0.75 + (motor.exhausted ? 0.18 + beat * 0.12 : 0);
    v += Math.max(0, motor.breath - 0.6) * 0.15;
    this.vignette.style.opacity = Math.min(0.95, v).toFixed(3);
    const inner = 70 - Math.min(35, v * 40);
    this.vignette.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,0.95) 135%)`;

    // 깊이 빠졌을 때 시야 아래쪽이 살짝 어두워짐
    this.sinkShade.style.opacity = Math.min(0.6, motor.sink * 1.2).toFixed(3);

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}
