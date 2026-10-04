// 최소 HUD: 조준점·체력·스태미나 바·탄약 수·미니맵 없음. 자세 아이콘만 구석에 작고 흐리게.
// 지침은 화면 가장자리 어두워짐(비네트)으로만 표현.
// 2단계: 제압 터널 시야 (가장자리가 어둡고 흐려짐), 짧은 글 (탄창 확인 결과·사격 모드 — toast),
//        F8 피격 로그 (오른쪽 위, 최신이 위 — 표적이 있을 때만), F7 제압 테스트 중 표시. 조준점·거치 아이콘은 없다.
// 3단계: 체력 바·부상 아이콘·히트마커 없음. 맞은 순간 화면 충격(어두운 붉은 번쩍임), 의식이 흐려지면 검게 꺼짐(blackout),
//        사망 화면 (원인·생존 시간·Enter 다시 시작), F9 피격 테스트 메뉴 (↑↓ 고르기, Enter 적용, F9 닫기).
//        F8 피격 로그는 F3 디버그를 켰을 때만 보인다 (Game 이 결정).
// 4단계: F4 적 생성 메뉴 (↑↓ 고르기, ←→ 값 바꾸기, Enter 실행, F4 닫기).
// 5단계: 무전 자막 (화면 아래 — 잡음과 함께 짧게), 내 위치·목표·거리 표시는 없다.
// 6단계: 갈증이 심하면 맥박에 맞춰 시야가 어두워졌다 밝아짐 (thirstPulse), F10 6단계 시험 메뉴 (함정·시각·달·피로·갈증 — 디버그 모드).
// 7단계: 분대 말 자막 (왼쪽 아래 — 이름: 말, 몇 초 뒤 사라짐. 들리는 거리 안의 말만 — Game 이 거름).
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
      <div id="corner-tr"><div id="hitlog"><div class="title">피격 로그 (F8)</div><div class="lines"></div></div>
        <div id="f7hint">제압 테스트 중 (F7로 중지)</div></div>
      <div id="radio"><span class="tag">무전</span><span class="text"></span></div>
      <div id="chatter"></div>
      <div id="toast"></div>
      <div id="hitflash"></div>
      <div id="blackout"></div>
      <div id="hittest"><div class="title">피격 테스트 (F9) — ↑↓ 고르기 · Enter 맞기 · F9 닫기</div><div class="items"></div></div>
      <div id="spawnmenu"><div class="title">적 생성 (F4) — ↑↓ 고르기 · ←→ 바꾸기 · Enter 실행 · F4 닫기</div><div class="items"></div></div>
      <div id="fieldmenu"><div class="title">6단계 시험 (F10) — ↑↓ 고르기 · ←→ 바꾸기 · Enter 실행 · F10 닫기</div><div class="items"></div></div>
      <div id="thirstpulse"></div>
      <div id="death"><div class="box"><div class="dead">사망</div><div class="cause"></div><div class="time"></div>
        <div class="again">Enter — 결과 보기 (임무 실패)</div></div></div>
    `);
    this.hitflashEl = root.querySelector('#hitflash');
    this.blackoutEl = root.querySelector('#blackout');
    this.hittestEl = root.querySelector('#hittest');
    this.hittestItems = root.querySelector('#hittest .items');
    this.spawnEl = root.querySelector('#spawnmenu');
    this.spawnItems = root.querySelector('#spawnmenu .items');
    this.deathEl = root.querySelector('#death');
    this.fieldEl = root.querySelector('#fieldmenu');
    this.fieldItems = root.querySelector('#fieldmenu .items');
    this.thirstEl = root.querySelector('#thirstpulse');
    this.thirstPulse = 0;     // 6단계: 갈증 맥박 시야 깊이 (Endurance.effects().pulse)
    this._thirstShown = -1;
    this._flash = 0;
    this._flashShown = -1;
    this._blackShown = -1;
    this.vignette = root.querySelector('#vignette');
    this.tunnelEl = root.querySelector('#tunnel');
    this.sinkShade = root.querySelector('#sink-shade');
    this.stanceEl = root.querySelector('#stance-icon .icon');
    this.quietDot = root.querySelector('#stance-icon .quiet-dot');
    this.hitlogEl = root.querySelector('#hitlog');
    this.hitlogLines = root.querySelector('#hitlog .lines');
    this.f7El = root.querySelector('#f7hint');
    this.toastEl = root.querySelector('#toast');
    this.radioEl = root.querySelector('#radio');
    this.radioText = root.querySelector('#radio .text');
    this._radioTimer = 0;
    this.chatterEl = root.querySelector('#chatter');
    this._chat = [];          // { el, t }
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

  /** 5단계 무전 자막 (seconds 동안) */
  radio(text, seconds = 4) {
    this.radioText.textContent = text;
    this.radioEl.classList.add('show');
    this._radioTimer = seconds;
  }

  clearRadio() { this._radioTimer = 0; this.radioEl.classList.remove('show'); this.clearChatter(); }

  /** 7단계 분대 말 자막: who (이름), text, opts { me: 내 말, far: 멀리서 (흐리게) } — 최근 4줄 */
  chatter(who, text, opts = {}) {
    const el = document.createElement('div');
    el.className = `line${opts.me ? ' me' : ''}${opts.far ? ' far' : ''}`;
    el.innerHTML = `<span class="who">${esc(who)}</span>${esc(text)}`;
    this.chatterEl.appendChild(el);
    this._chat.push({ el, t: 3.2 + String(text).length * 0.06 });
    while (this._chat.length > 4) this._chat.shift().el.remove();
  }

  clearChatter() { for (const c of this._chat) c.el.remove(); this._chat.length = 0; }

  /** F8 피격 로그 (최신이 앞). null 이면 숨김 */
  setHitLog(entries) {
    if (!entries) { this.hitlogEl.style.display = 'none'; return; }
    this.hitlogEl.style.display = 'block';
    this.hitlogLines.innerHTML = entries.length
      ? entries.map((e) => `<div>${esc(e.text)}</div>`).join('')
      : '<div class="empty">아직 명중 없음</div>';
  }

  /** 맞은 순간 화면 충격 (0~1.5) */
  hitFlash(strength = 1) {
    this._flash = Math.min(1.2, Math.max(this._flash, strength));
  }

  /** 화면이 검게 꺼짐 0~1 (의식 상실·사망) */
  setBlackout(a) {
    const v = Math.max(0, Math.min(1, a));
    if (Math.abs(v - this._blackShown) < 0.004) return;
    this._blackShown = v;
    this.blackoutEl.style.display = v > 0 ? 'block' : 'none';
    this.blackoutEl.style.opacity = v.toFixed(3);
  }

  /** 사망 화면 ({cause, time (s)}) — null 이면 숨김 */
  setDeath(info) {
    if (!info) { this.deathEl.style.display = 'none'; return; }
    const t = Math.max(0, info.time || 0);
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    this.deathEl.querySelector('.cause').textContent = `사인: ${info.cause}`;
    this.deathEl.querySelector('.time').textContent = `생존 시간 ${mm}분 ${String(ss).padStart(2, '0')}초`;
    this.deathEl.style.display = 'flex';
  }

  /** F9 메뉴 — items [{label}], index 선택. null 이면 닫음 */
  setHitTest(items, index = 0) {
    if (!items) { this.hittestEl.style.display = 'none'; return; }
    this.hittestEl.style.display = 'block';
    this.hittestItems.innerHTML = items.map((it, i) => `<div class="${i === index ? 'sel' : ''}">${i === index ? '▶ ' : '&nbsp;&nbsp;'}${esc(it.label)}</div>`).join('');
  }

  /** F4 적 생성 메뉴 — items [{label, value?}] (value 가 있으면 ←→ 로 바꾸는 항목), index 선택. null 이면 닫음 */
  setSpawnMenu(items, index = 0) {
    if (!items) { this.spawnEl.style.display = 'none'; return; }
    this.spawnEl.style.display = 'block';
    this.spawnItems.innerHTML = items.map((it, i) => {
      const v = it.value !== undefined ? ` <span class="val">◀ ${esc(it.value)} ▶</span>` : '';
      return `<div class="${i === index ? 'sel' : ''}">${i === index ? '▶ ' : '&nbsp;&nbsp;'}${esc(it.label)}${v}</div>`;
    }).join('');
  }

  /** 6단계 F10 시험 메뉴 (setSpawnMenu 와 같은 꼴) */
  setFieldMenu(items, index = 0) {
    if (!items) { this.fieldEl.style.display = 'none'; return; }
    this.fieldEl.style.display = 'block';
    this.fieldItems.innerHTML = items.map((it, i) => {
      const v = it.value !== undefined ? ` <span class="val">◀ ${esc(it.value)} ▶</span>` : '';
      return `<div class="${i === index ? 'sel' : ''}">${i === index ? '▶ ' : '&nbsp;&nbsp;'}${esc(it.label)}${v}</div>`;
    }).join('');
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

    // 6단계 갈증: 맥박에 맞춰 시야 가장자리부터 어두워졌다 밝아짐
    const tp = Math.max(0, this.thirstPulse || 0);
    const tvv = tp > 0.001 ? tp * (0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(this.pulse * Math.PI)), 2)) : 0;
    if (Math.abs(tvv - this._thirstShown) > 0.004) {
      this._thirstShown = tvv;
      this.thirstEl.style.display = tvv > 0 ? 'block' : 'none';
      this.thirstEl.style.opacity = Math.min(1, tvv * 2).toFixed(3);
    }

    // 깊이 빠졌을 때 시야 아래쪽이 살짝 어두워짐
    this.sinkShade.style.opacity = Math.min(0.6, motor.sink * 1.2).toFixed(3);

    // 맞은 순간 화면 충격 — 빠르게 사라짐
    if (this._flash > 0) this._flash = Math.max(0, this._flash - dt * 2.2);
    if (Math.abs(this._flash - this._flashShown) > 0.004) {
      this._flashShown = this._flash;
      this.hitflashEl.style.display = this._flash > 0 ? 'block' : 'none';
      this.hitflashEl.style.opacity = Math.min(1, this._flash).toFixed(3);
    }

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('show');
    }
    if (this._radioTimer > 0) {
      this._radioTimer -= dt;
      if (this._radioTimer <= 0) this.radioEl.classList.remove('show');
    }
    for (let i = this._chat.length - 1; i >= 0; i--) {
      const c = this._chat[i];
      c.t -= dt;
      if (c.t < 0.6) c.el.style.opacity = Math.max(0, c.t / 0.6).toFixed(2);
      if (c.t <= 0) { c.el.remove(); this._chat.splice(i, 1); }
    }
  }
}
