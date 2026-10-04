// =====================================================================
//  Screens — 5단계 화면 흐름: 로딩 → 타이틀 → 임무 선택 → 브리핑 → (플레이) → 결과.
//   플레이 중 Esc: 계속 / 설정 / 조작법 / 임무 포기.  설정은 브라우저 저장소에 (안 되면 기본값으로 그냥 동작).
//   이벤트: 'pick' {type} · 'reroll' · 'start' · 'resume' · 'abort' · 'title' · 'select' · 'checkpoint' · 'debug' (bool)
//  7단계: 임무 선택에 분대 모드 (기본) / 단독 모드, 브리핑에 분대원 이름·역할·지원 화력, 결과에 아군 사상자·오인 사격·지원·보급
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { MISSION_TYPES, MISSION_LABELS } from '../mission/MissionGen.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CONTROLS = [
  ['WASD', '이동'], ['마우스', '시점'], ['Shift', '달리기'], ['X', '조용히 걷기 (토글)'],
  ['C', '앉기'], ['Z', '엎드리기'], ['Q / E', '기울이기'], ['Space', '점프 (앉은 상태에선 일어서기)'],
  ['좌클릭', '사격'], ['우클릭 (누르기)', '가늠자 조준'], ['조준 중 Shift', '숨 참기 (최대 4초)'],
  ['R', '재장전 · 기능 고장 해결'], ['B', '사격 모드 (단발 / 연발)'], ['T', '탄창 확인 (길게: 탄약 주머니 무게)'],
  ['V (누르고 있기)', '탄창 채우기 — 앉거나 엎드려 멈춘 채'], ['M (누르고 있기)', '종이 지도'], ['N (누르고 있기)', '손목 나침반 · 시계'],
  ['F', '상호작용 — 문서 회수 (3초) · 총 줍기 (2초) · 알아챈 인계철선 해제 (5초) · 개울에서 앉아 수통 채우기 (10초)'],
  ['F (분대)', '다친 분대원 치료 (내 붕대·지혈대) · 쓰러진 무전병의 무전기 줍기 · 쓰러진 분대원의 탄창·낱발·붕대 회수 · 보급 상자 열기'],
  ['J (누르고 있기)', '명령 휠 — 마우스로 고르고 좌클릭 수신호 (소리 없음, 나를 보는 분대원만) · 우클릭 외치기 (모두, 적도 들음)'],
  ['M + 좌클릭', '지도에서 연필로 지점 → 지원 요청 (박격포·포병·조명탄·헬기 보급) — 무전병 10m 안이나 무전기를 멨을 때'],
  ['Y (누르고 있기)', '탐침 — 앞 1m 땅을 찔러 지뢰·구덩이 확인 (2초)'], ['U (누르고 있기)', '수통 마시기 (3초)'], ['L', '손전등 (켜면 멀리서도 보인다)'],
  ['H', '붕대 (2개 · 7초 · 멈춰서)'], ['G', '지혈대 (1개 · 5초 · 팔다리 출혈 정지)'],
  ['K', '사격 (마우스 잠금이 안 될 때)'], ['Esc', '일시정지 · 설정 · 임무 포기'],
];
const DEBUG_CONTROLS = [
  ['F3', '디버그 정보 (켜진 동안 1~9: 테스트 지점)'], ['F2', 'AI 디버그'], ['F4', '적 생성 메뉴'], ['F6', '대퇴 부상 (테스트)'],
  ['F7', '제압 테스트'], ['F8', '표적 배치'], ['F9', '피격 테스트 메뉴 · 무적'],
  ['F10', '6단계 시험 메뉴 — 함정 위치 표시 · 시각 · 달 · 피로 · 갈증 · 조명탄'],
  ['O', '분대 다시 생성 (분대 모드)'], ['I', '지원 화력·보급 횟수 초기화'], ['P', '탄창·낱발 탄약 처음 상태로'],
  ['F2 (분대)', 'AI 디버그에 분대원 상태 — 따르는 명령·제압 (60 이상 명령 거부)·처치·업기·피로'],
];
const MISSION_TEXT = {
  recon: '지도에 표시한 지형지물 2~3곳을 직접 확인하고 회수 지점으로 돌아온다. 교전을 피할수록 유리하다.',
  ambush: '표시한 오솔길 구간에서 언제 올지 모르는 적 보급 행렬을 기다렸다가 기습하고, 증원이 오기 전에 철수한다.',
  raid: '지도에 대략적인 범위만 표시된 적 야영지를 찾아 오두막 안의 문서를 가져온다. 보초와 접근로 매복이 있다.',
};

export class Screens extends EventEmitter {
  constructor(root, settings) {
    super();
    this.settings = settings;
    this.root = root;
    const s = settings.values;
    const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    const vol = (id, label, v) => `<label>${label} <span id="v-${id}">${Math.round(v * 100)}</span><input id="in-${id}" type="range" min="0" max="1" step="0.05" value="${v}"></label>`;
    root.insertAdjacentHTML('beforeend', `
      <div id="screens" class="screen">
        <div class="panel" id="sc-panel">
          <section data-sc="loading">
            <h1>정글</h1><div class="sub">동남아 열대 정글 · 7단계 — 분대 · 명령 · 지원 화력 · 보급</div>
            <div id="loading"><div class="bar"><div class="fill"></div></div><div class="msg">맵 생성 중…</div></div>
          </section>
          <section data-sc="title" hidden>
            <h1>정글</h1><div class="sub">동남아 열대 정글 · 7단계 — 분대 · 명령 · 지원 화력 · 보급</div>
            <p class="brief">지도에 내 위치는 없다. 종이 지도(M)의 등고선과 개울, 손목 나침반(N)과 시계, 지형과 소리로 길을 찾는다.
              탄약은 탄창 여섯 개와 낱발 90발뿐 — 비면 직접 채워야 한다(V). 대부분의 시간은 걷고, 듣고, 살핀다. 싸움은 짧고 혼란스럽다.</p>
            <p class="brief">빠른 길에는 함정이 숨어 있다. 밤에는 소리와 빛이 생사를 가른다. 오래 걸으면 몸이 무거워지고 목이 마르다.</p>
            <p class="brief">분대장으로서 분대원 서너 명을 이끈다. 수신호는 조용하지만 보는 사람만 받고, 외치면 모두 — 그리고 적도 — 듣는다.
              무전병 곁에서 지도로 박격포·포병을 부를 수 있지만, 지도에 찍은 점이 틀리면 엉뚱한 곳에 떨어진다. 아군도 맞는다.</p>
            <p class="brief">한 번 죽으면 끝이다.</p>
            <p class="touch-note">키보드와 마우스가 필요합니다. 데스크톱 브라우저에서 열어 주세요.</p>
            <div class="row"><button class="primary" data-act="select">임무 선택</button>
              <button class="ghost" data-act="settings">설정</button><button class="ghost" data-act="controls">조작법</button></div>
          </section>
          <section data-sc="select" hidden>
            <h2>임무 선택</h2>
            <div class="mode-row"><span class="mode-label">편성</span>
              <button class="mode-btn" data-mode="squad">분대 모드 <small>분대원 3~5명 · 명령 · 지원 화력</small></button>
              <button class="mode-btn" data-mode="solo">단독 모드 <small>혼자 (6단계까지처럼)</small></button></div>
            <div class="cards">${MISSION_TYPES.map((t) => `<button class="card" data-pick="${t}"><b>${MISSION_LABELS[t]}</b><span>${MISSION_TEXT[t]}</span></button>`).join('')}</div>
            <div class="row"><button class="ghost" data-act="title">뒤로</button></div>
          </section>
          <section data-sc="briefing" hidden>
            <h2 id="br-title"></h2>
            <div class="brief-cols">
              <div class="brief-text" id="br-text"></div>
              <div class="brief-map"><canvas id="br-map" width="560" height="560"></canvas><div class="map-note">연필 표시: 목표·회수 지점 (내 위치는 지도에 없다)</div></div>
            </div>
            <div class="row"><button class="primary" data-act="start">작전 시작</button>
              <button class="ghost" data-act="reroll">다른 작전</button><button class="ghost" data-act="select">뒤로</button></div>
            <div id="lock-msg"></div>
          </section>
          <section data-sc="pause" hidden>
            <h2>일시정지</h2>
            <div id="pause-info" class="sub"></div>
            <div class="col-buttons">
              <button class="primary" data-act="resume">계속</button>
              <button class="ghost" data-act="settings">설정</button>
              <button class="ghost" data-act="controls">조작법</button>
              <button class="ghost danger" data-act="abortAsk">임무 포기</button>
            </div>
            <div id="abort-confirm" hidden><p>임무를 포기하면 실패로 끝난다.</p>
              <div class="row"><button class="ghost danger" data-act="abort">포기한다</button><button class="ghost" data-act="abortNo">취소</button></div></div>
            <div id="lock-msg2"></div>
          </section>
          <section data-sc="settings" hidden>
            <h2>설정</h2>
            <div class="cols">
              <div class="col">
                <label>마우스 감도 <span id="v-sens">${s.sensitivity.toFixed(2)}</span><input id="in-sens" type="range" min="0.2" max="3" step="0.05" value="${s.sensitivity}"></label>
                <label>시야각 (FOV) <span id="v-fov">${s.fov}</span><input id="in-fov" type="range" min="60" max="100" step="1" value="${s.fov}"></label>
                <label>그래픽 품질 <select id="in-quality">${opt(CONFIG.graphics, s.quality)}</select></label>
                <label class="check"><input id="in-checkpoint" type="checkbox" ${s.checkpoint ? 'checked' : ''}> 체크포인트 1회 (중간 목표 달성 때 한 번 저장)</label>
                <label class="check"><input id="in-debugmode" type="checkbox" ${s.debugMode ? 'checked' : ''}> 디버그 모드 (F2~F9 테스트 키)</label>
                <label class="check" id="lbl-debug"><input id="in-debug" type="checkbox"> 디버그 정보 표시 (F3)</label>
              </div>
              <div class="col">
                ${vol('vol', '전체 음량', s.volume)}
                ${vol('vfx', '효과음', s.volEffects)}
                ${vol('vamb', '환경음', s.volAmbience)}
                ${vol('vradio', '무전', s.volRadio)}
                <p class="note">설정은 이 브라우저에 저장됩니다 (저장할 수 없으면 이번에만 적용).</p>
              </div>
            </div>
            <div class="row"><button class="ghost" data-act="back">돌아가기</button></div>
          </section>
          <section data-sc="controls" hidden>
            <h2>조작법</h2>
            <table>${CONTROLS.map(([k, v]) => `<tr><td class="key">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
            <h3>디버그 모드에서만</h3>
            <table>${DEBUG_CONTROLS.map(([k, v]) => `<tr><td class="key">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
            <div class="row"><button class="ghost" data-act="back">돌아가기</button></div>
          </section>
          <section data-sc="result" hidden>
            <h2 id="rs-title"></h2>
            <div class="sub" id="rs-reason"></div>
            <div id="rs-body"></div>
            <div class="row"><button class="primary" data-act="select">임무 선택</button>
              <button class="ghost" id="btn-cp" data-act="checkpoint" hidden>체크포인트에서 다시</button>
              <button class="ghost" data-act="title">타이틀</button></div>
          </section>
        </div>
      </div>
    `);
    this.el = root.querySelector('#screens');
    this.sections = Object.fromEntries([...root.querySelectorAll('#screens section')].map((e) => [e.dataset.sc, e]));
    this.loading = root.querySelector('#loading');
    this.current = 'loading';
    this._back = 'title';
    const $ = (id) => root.querySelector(id);
    // 설정
    const bind = (id, key, fmt, lab) => $(id).addEventListener('input', (e) => { settings.set(key, +e.target.value); if (lab) $(lab).textContent = fmt(+e.target.value); });
    bind('#in-sens', 'sensitivity', (v) => v.toFixed(2), '#v-sens');
    bind('#in-fov', 'fov', (v) => String(v), '#v-fov');
    bind('#in-vol', 'volume', (v) => String(Math.round(v * 100)), '#v-vol');
    bind('#in-vfx', 'volEffects', (v) => String(Math.round(v * 100)), '#v-vfx');
    bind('#in-vamb', 'volAmbience', (v) => String(Math.round(v * 100)), '#v-vamb');
    bind('#in-vradio', 'volRadio', (v) => String(Math.round(v * 100)), '#v-vradio');
    $('#in-quality').addEventListener('change', (e) => settings.set('quality', e.target.value));
    $('#in-checkpoint').addEventListener('change', (e) => settings.set('checkpoint', e.target.checked));
    $('#in-debugmode').addEventListener('change', (e) => { settings.set('debugMode', e.target.checked); this._syncDebugRow(); if (!e.target.checked) this.emit('debug', false); });
    this.debugBox = $('#in-debug');
    this.debugBox.addEventListener('change', (e) => this.emit('debug', e.target.checked));
    this._syncDebugRow();
    // 버튼
    this._syncMode();
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.pick) { this.emit('pick', { type: b.dataset.pick }); return; }
      if (b.dataset.mode) { settings.set('squadMode', b.dataset.mode === 'squad'); this._syncMode(); return; }
      const act = b.dataset.act;
      switch (act) {
        case 'select': this.show('select'); this.emit('select'); break;
        case 'title': this.show('title'); this.emit('title'); break;
        case 'settings': this._back = this.current; this.show('settings'); break;
        case 'controls': this._back = this.current; this.show('controls'); break;
        case 'back': this.show(this._back); break;
        case 'start': this.emit('start'); break;
        case 'reroll': this.emit('reroll'); break;
        case 'resume': this.emit('resume'); break;
        case 'abortAsk': $('#abort-confirm').hidden = false; break;
        case 'abortNo': $('#abort-confirm').hidden = true; break;
        case 'abort': $('#abort-confirm').hidden = true; this.emit('abort'); break;
        case 'checkpoint': this.emit('checkpoint'); break;
        default: break;
      }
    });
  }

  _syncDebugRow() { this.root.querySelector('#lbl-debug').style.display = this.settings.get('debugMode') ? '' : 'none'; }

  /** 7단계: 분대 / 단독 모드 버튼 */
  _syncMode() {
    const squad = this.settings.get('squadMode') !== false;
    for (const b of this.root.querySelectorAll('.mode-btn')) b.classList.toggle('on', (b.dataset.mode === 'squad') === squad);
  }

  setProgress(p, msg) {
    this.loading.querySelector('.fill').style.width = `${Math.round(p * 100)}%`;
    if (msg) this.loading.querySelector('.msg').textContent = msg;
  }

  show(name) {
    this.el.style.display = 'flex';
    for (const [k, e] of Object.entries(this.sections)) e.hidden = k !== name;
    this.current = name;
    this.el.querySelector('#sc-panel').classList.toggle('wide', name === 'briefing' || name === 'result');
    for (const id of ['#lock-msg', '#lock-msg2']) { const m = this.root.querySelector(id); if (m) m.textContent = ''; }
    if (name === 'pause') this.root.querySelector('#abort-confirm').hidden = true;
  }

  hide() { this.el.style.display = 'none'; this.current = null; }
  get visible() { return this.el.style.display !== 'none'; }

  sync(state) { this.debugBox.checked = !!state.debug; }

  lockFailed() {
    for (const id of ['#lock-msg', '#lock-msg2']) { const m = this.root.querySelector(id); if (m) m.textContent = '마우스 잠금 실패 — 잠시 후 다시 누르세요.'; }
  }

  /** 브리핑: def.briefing + 지도 그림 (PaperMap.drawTo) */
  showBriefing(def, drawMap) {
    const B = def.briefing;
    this.root.querySelector('#br-title').textContent = B.title;
    this.root.querySelector('#br-text').innerHTML = `
      <p class="meta">${esc(B.start)}<br>${esc(B.limit)}<br>${esc(B.weather)}${B.night ? `<br>${esc(B.night)}` : ''}<br>${esc(B.enemy)}</p>
      ${B.lines.map((l) => `<p class="${l.startsWith('  ') ? 'obj' : ''}">${esc(l.trim())}</p>`).join('')}
      ${B.squad ? `<h3>분대</h3><ul class="equip">${B.squad.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<h3>편성</h3><p>단독 — 분대 없이 혼자 간다.</p>'}
      ${B.support ? B.support.map((l) => `<p class="obj">${esc(l)}</p>`).join('') : ''}
      <h3>장비</h3><ul class="equip">${B.equipment.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <p class="note">무전으로 오는 적 정보는 늦고, 열에 셋은 틀린다.</p>`;
    drawMap(this.root.querySelector('#br-map'));
    this.show('briefing');
  }

  showPause(info) {
    this.root.querySelector('#pause-info').textContent = info ?? '';
    this.show('pause');
  }

  /** 7단계 결과: 아군 사상자 (이름별) · 오인 사격 · 지원 화력 · 보급 */
  _squadResult(sum, row) {
    if (sum.mode !== 'squad' || !sum.squad) return '<p class="note">단독 임무</p>';
    const st = { 전사: 'fail', 부상: 'warn', 경상: 'warn', 무사: 'ok' };
    const sq = sum.squad.map((a) => `<span class="${st[a.status] ?? ''}">${esc(a.name)} (${esc(a.role)}) — ${esc(a.status)}</span>${a.wounds.length ? ` <span class="dim">${a.wounds.map(esc).join(', ')}</span>` : ''}${a.friendlyHits ? ` <span class="warn">· 아군 탄 ${a.friendlyHits}발</span>` : ''}`).join('<br>');
    const ff = sum.friendlyFire;
    const ffTxt = ff && ff.incidents ? `${ff.incidents}건 · 명중 ${ff.hits}발<br><span class="dim">${ff.list.map(esc).join(' · ')}</span>` : '없음';
    const S = sum.support;
    const sup = S ? `박격포 ${S.mortar}회 · 포병 ${S.artillery}회 · 조명탄 ${S.illum}회 (시험 사격 ${S.spot} · 효력 사격 ${S.ffe} · 공중 폭발 ${S.airbursts} · 거절 ${S.denied} · 위험 근접 경고 ${S.dangerClose})<br>`
      + `<span class="dim">쏜 포탄: 박격포 ${S.rounds.mortar} · 포병 ${S.rounds.artillery} · 조명 ${S.rounds.illum} · 적 박격포 ${S.rounds.enemy}</span>` : '-';
    const U = sum.supply;
    const sup2 = U ? `탄창 받음 ${U.ammoThrown}회 · 쓰러진 아군 물자 회수 ${U.looted}회 · 헬기 보급 ${S?.resupply ?? 0}회 (상자 연 횟수 ${U.crate})${U.radioTaken ? ' · 무전기를 직접 멨음' : ''}` : '-';
    const act = U ? `명령 ${U.orders}번 · 적 발견 보고 ${U.reports}번 · 첨병 함정 정지 ${U.trapHalts}번` : '';
    return `<h3>분대</h3><div class="cols"><div class="col"><table>
        ${row('분대원', sq)}
        ${row('오인 사격', ffTxt)}
      </table></div><div class="col"><table>
        ${row('지원 화력', sup)}
        ${row('보급', sup2)}
        ${act ? row('분대 활동', act) : ''}
      </table></div></div>`;
  }

  /** 결과 화면 (Mission.summary + 추가 정보) */
  showResult(sum, opts = {}) {
    const t = sum.time, mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    this.root.querySelector('#rs-title').textContent = sum.success ? '임무 성공' : '임무 실패';
    this.root.querySelector('#rs-title').className = sum.success ? 'ok' : 'fail';
    this.root.querySelector('#rs-reason').textContent = sum.success ? `${opts.label ?? ''} — 헬기로 회수됨` : `${opts.label ?? ''} — ${sum.reasonLabel}`;
    const acc = sum.shots > 0 ? ` (${Math.round(sum.hits / sum.shots * 100)}%)` : '';
    const wounds = sum.wounds.length ? sum.wounds.map(esc).join(', ') : '없음';
    const row = (k, v) => `<tr><td class="key">${k}</td><td>${v}</td></tr>`;
    this.root.querySelector('#rs-body').innerHTML = `
      <div class="cols"><div class="col"><table>
        ${row('경과 시간', `${mm}분 ${String(ss).padStart(2, '0')}초`)}
        ${row('이동 거리', `${Math.round(sum.distance)} m`)}
        ${row('발사 / 명중', `${sum.shots}발 / ${sum.hits}발${acc}`)}
        ${row('사용한 탄', `${sum.used}발`)}
        ${row('남은 탄', `탄창 속 ${sum.roundsLeft}발 · 낱발 ${sum.looseLeft}발${sum.loaded ? ` (낱발 ${sum.loaded}발을 탄창에 채움)` : ''}`)}
        ${row('들고 나온 총', esc(sum.weapon || '-'))}
      </table></div><div class="col"><table>
        ${row('입은 부상', wounds)}
        ${row('적 사상자 — 확인 사살', `${sum.confirmed}명 (쓰러지는 것을 봄)`)}
        ${row('적 사상자 — 추정', `${sum.estimated}명 (확인 못 함)`)}
        ${row('적 부상', `${sum.enemyWounded}명`)}
        ${sum.traps ? row('함정', `알아챔 ${sum.traps.known}개 · 걸림 ${sum.traps.triggered}개 · 해제 ${sum.traps.disarmed}개`) : ''}
        ${row('목표', sum.objectives.map((o) => `${o.done ? '✓' : '✗'} ${esc(o.label)}`).join('<br>'))}
      </table></div></div>${this._squadResult(sum, row)}`;
    this.root.querySelector('#btn-cp').hidden = !opts.checkpoint;
    this.show('result');
  }
}
