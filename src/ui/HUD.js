// 최소 HUD: 조준점·체력·스태미나 바·탄약 수·미니맵 없음. 자세 아이콘만 구석에 작고 흐리게.
// 지침은 화면 가장자리 어두워짐(비네트)으로만 표현.
// 2단계: 제압 터널 시야 (가장자리가 어둡고 흐려짐), 짧은 글 (탄창 확인 결과·사격 모드 — toast),
//        F8 피격 로그 (오른쪽 위, 최신이 위 — 표적이 있을 때만), F7 제압 테스트 중 표시. 조준점·거치 아이콘은 없다.
const ICONS = {
  stand: '<svg viewBox="0 0 24 40"><circle cx="12" cy="5" r="3.2"/><path d="M8 11h8l1.5 13h-3l-.8 14h-3.4l-.8-14h-3z"/></svg>',
  crouch: '<svg viewBox="0 0 24 40"><circle cx="11" cy="15" r="3.2"/><path d="M7 20h8l3 7-3 2-1 9h-3.5l.5-8-5-2z"/></svg>',
  prone: '<svg viewBox="0 0 40 24"><circle cx="34" cy="14" r="3.2"/><path d="M4 16l26-3 .5 4-26 3z"/></svg>',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class HUD {
  constructor(root) {
    this.root = root;
    root.insertAdjacentHTML('beforeend', `
      <div id="vignette"></div>
      <div id="tunnel"></div>
      <div id="sink-shade"></div>
      <div id="stance-icon"><div class="icon"></div><div class="quiet-dot" title="조용히 걷기"></div></div>
      <div id="restrict-flag">거동 불능 시뮬레이션 (F6)</div>
      <div id="corner-tr"><div id="hitlog"><div class="title">피격 로그 (F8)</div><div class="lines"></div></div>
        <div id="f7hint">제압 테스트 중 (F7로 중지)</div></div>
      <div id="toast"></div>
    `);
    this.vignette = root.querySelector('#vignette');
    this.tunnelEl = root.querySelector('#tunnel');
    this.sinkShade = root.querySelector('#sink-shade');
    this.stanceEl = root.querySelector('#stance-icon .icon');
    this.quietDot = root.querySelector('#stance-icon .quiet-dot');
    this.restrictFlag = root.querySelector('#restrict-flag');
    this.hitlogEl = root.querySelector('#hitlog');
    this.hitlogLines = root.querySelector('#hitlog .lines');
    this.f7El = root.querySelector('#f7hint');
    this.toastEl = root.querySelector('#toast');
    this._stance = '';
    this._toastTimer = 0;
    this.pulse = 0;
    this.tunnel = 0;          // 제압 터널 시야 0~1 (Game 이 Suppression.effects().tunnel 을 넣음 — 이미 수치 비례)
    this._tunnelShown = -1;
  }

  toast(msg, seconds = 1.6) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    this._toastTimer = seconds;
  }

  /** F8 피격 로그 (최신이 앞). null 이면 숨김 */
  setHitLog(entries) {
    if (!entries) { this.hitlogEl.style.display = 'none'; return; }
    this.hitlogEl.style.display = 'block';
    this.hitlogLines.innerHTML = entries.length
      ? entries.map((e) => `<div>${esc(e.text)}</div>`).join('')
      : '<div class="empty">아직 명중 없음</div>';
  }

  setF7(active) {
    this.f7El.style.display = active ? 'block' : 'none';
  }

  update(dt, motor, quiet) {
    if (motor.stance !== this._stance) {
      this._stance = motor.stance;
      this.stanceEl.innerHTML = ICONS[motor.stance];
      this.stanceEl.className = `icon ${motor.stance}`;
    }
    this.quietDot.style.opacity = quiet ? '1' : '0';
    this.restrictFlag.style.display = motor.hasRestriction('incapacitated') ? 'block' : 'none';

    // 지침 비네트: 스태미나가 줄수록 가장자리가 어두워지고, 탈진 시 심장 박동에 맞춰 조여옴
    const fatigue = 1 - motor.stamina / 100;
    this.pulse += (motor.heartRate / 60) * dt;
    const beat = Math.pow(Math.max(0, Math.sin(this.pulse * Math.PI * 2)), 6);
    let v = Math.pow(fatigue, 1.6) * 0.75 + (motor.exhausted ? 0.18 + beat * 0.12 : 0);
    v += Math.max(0, motor.breath - 0.6) * 0.15;
    this.vignette.style.opacity = Math.min(0.95, v).toFixed(3);
    const inner = 70 - Math.min(35, v * 40);
    this.vignette.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,0.95) 135%)`;

    // 제압 터널 시야: 가장자리가 어둡고 흐려지며 (흐림은 backdrop-filter, 가장자리만 mask), 심하면 심장 박동에 맞춰 조여옴.
    // 0 이면 요소를 숨겨 흐림 비용이 없다
    const tn = Math.max(0, Math.min(1, this.tunnel));
    const tv = tn > 0.004 ? Math.min(1, tn * (1 + beat * 0.12 * tn)) : 0;
    if (Math.abs(tv - this._tunnelShown) > 0.003 || (tv === 0) !== (this._tunnelShown === 0)) {
      this._tunnelShown = tv;
      const s = this.tunnelEl.style;
      if (tv === 0) s.display = 'none';
      else {
        s.display = 'block';
        s.opacity = Math.min(1, tv * 2.2).toFixed(3);
        s.setProperty('--tin', `${(46 - tv * 26).toFixed(1)}%`);   // 맑은 가운데가 좁아짐
        s.setProperty('--tdark', (0.35 + 0.6 * tv).toFixed(3));
      }
    }

    // 깊이 빠졌을 때 시야 아래쪽이 살짝 어두워짐
    this.sinkShade.style.opacity = Math.min(0.6, motor.sink * 1.2).toFixed(3);

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}
