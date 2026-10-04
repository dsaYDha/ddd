// 로딩·시작·일시정지(설정) 화면
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const CONTROLS = [
  ['WASD', '이동'], ['마우스', '시점'], ['Shift', '달리기'], ['X', '조용히 걷기 (토글)'],
  ['C', '앉기'], ['Z', '엎드리기'], ['Q / E', '기울이기'], ['Space', '점프 (앉은 상태에선 일어서기)'],
  ['좌클릭', '사격'], ['우클릭 (누르기)', '가늠자 조준'], ['조준 중 Shift', '숨 참기 (최대 4초)'],
  ['R', '재장전 · 기능 고장 해결'], ['B', '사격 모드 (단발 / 연발)'], ['T', '탄창 확인'],
  ['V', '사격 (마우스 잠금이 안 될 때)'],
  ['H', '붕대 (2개 · 7초 · 멈춰서)'], ['G', '지혈대 (1개 · 5초 · 팔다리 출혈 정지)'], ['F', '떨어뜨린 총 줍기 (2초)'],
  ['Esc', '일시정지·설정'], ['F3', '디버그 정보 (켜진 동안 1~9: 테스트 지점, F8 피격 로그)'], ['F6', '대퇴 부상 (테스트)'],
  ['F7', '제압 테스트 (빗나가는 연발)'], ['F8', '표적 배치 · 제거'], ['F9', '피격 테스트 메뉴 (↑↓ · Enter, 무적 켜기)'],
  ['F4', '적 생성 메뉴 (순찰 분대 · 매복조 · 기관총 · 거리)'], ['F2', 'AI 디버그 (상태 · 시야 · 발견 수치 · 추정 위치 · 경로)'],
  ['Enter', '사망 후 다시 시작'],
];

export class Menu extends EventEmitter {
  constructor(root, settings) {
    super();
    this.settings = settings;
    const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v.label}</option>`).join('');
    const s = settings.values;
    root.insertAdjacentHTML('beforeend', `
      <div id="menu" class="screen">
        <div class="panel">
          <h1>정글</h1>
          <div class="sub">동남아 열대 정글 · 4단계 — 적 AI와 소리 정보</div>
          <div id="loading"><div class="bar"><div class="fill"></div></div><div class="msg">맵 생성 중…</div></div>
          <div id="menu-body" style="display:none">
            <p class="brief">조준점은 없다 — 가늠자와 가늠쇠뿐이다. 총은 숨을 쉴 때마다 8자로 흔들리고, 뛰고 나면 심장 박동만큼 더 흔들린다.
              자세를 낮추고, 숨을 참고, 통나무나 나무에 총을 얹어야 겨우 맞는다. 반동은 절반 넘게 스스로 끌어내려야 하고,
              총알이 귀 옆을 스치면 겁이 나 손이 떨리고 시야가 좁아진다. 탄약 수는 보이지 않는다 — 탄창을 직접 가늠해라.</p>
            <p class="brief">한 발이면 끝이다. 머리·목·심장·척추는 즉사, 가슴·배·골반·허벅지는 그 자리에 쓰러져 기어야 하고,
              팔을 맞으면 총을 제대로 들 수 없다. 체력 바는 없다 — 심장 소리, 좁아지는 시야, 잿빛으로 흐려지는 화면이 남은 피다.
              동맥이 터지면 1~2분. 멈춰서 붕대(H)나 지혈대(G)를 감아라. 치유는 없다.</p>
            <p class="brief">적도 같은 규칙을 따른다. 숨어서 먼저 쏘고, 분대로 움직이며, 겁먹고, 실수하고, 다치면 고통스러워한다.
              보이는 것보다 들리는 것이 많다 — 총성의 거리와 종류, 갑자기 조용해지는 벌레 소리, 수풀 속 고함과 탄창 가는 소리가 위치다.
              F4 로 순찰 분대나 매복조를 부르고, F2 로 그들의 머릿속을 볼 수 있다.</p>
            <p class="touch-note">키보드와 마우스가 필요합니다. 데스크톱 브라우저에서 열어 주세요.</p>
            <button id="btn-play" class="primary">클릭하여 시작</button>
            <div id="lock-msg"></div>
            <div class="cols">
              <div class="col">
                <h3>설정</h3>
                <label>마우스 감도 <span id="v-sens">${s.sensitivity.toFixed(2)}</span>
                  <input id="in-sens" type="range" min="0.2" max="3" step="0.05" value="${s.sensitivity}"></label>
                <label>시야각 (FOV) <span id="v-fov">${s.fov}</span>
                  <input id="in-fov" type="range" min="60" max="100" step="1" value="${s.fov}"></label>
                <label>그래픽 품질 <select id="in-quality">${opt(CONFIG.graphics, s.quality)}</select></label>
                <label>시간대 <select id="in-tod">${opt(CONFIG.timeOfDay.presets, s.timeOfDay)}</select></label>
                <label>날씨 <select id="in-weather">${opt(CONFIG.weather.presets, s.weather)}</select></label>
                <label>음량 <span id="v-vol">${Math.round(s.volume * 100)}</span>
                  <input id="in-vol" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
                <label class="check"><input id="in-debug" type="checkbox"> 디버그 정보 (F3)</label>
              </div>
              <div class="col">
                <h3>조작</h3>
                <table>${CONTROLS.map(([k, v]) => `<tr><td class="key">${k}</td><td>${v}</td></tr>`).join('')}</table>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
    this.el = root.querySelector('#menu');
    this.loading = root.querySelector('#loading');
    this.body = root.querySelector('#menu-body');
    this.playBtn = root.querySelector('#btn-play');
    this.lockMsg = root.querySelector('#lock-msg');
    const $ = (id) => root.querySelector(id);

    $('#in-sens').addEventListener('input', (e) => { settings.set('sensitivity', +e.target.value); $('#v-sens').textContent = (+e.target.value).toFixed(2); });
    $('#in-fov').addEventListener('input', (e) => { settings.set('fov', +e.target.value); $('#v-fov').textContent = e.target.value; });
    $('#in-quality').addEventListener('change', (e) => settings.set('quality', e.target.value));
    $('#in-tod').addEventListener('change', (e) => settings.set('timeOfDay', e.target.value));
    $('#in-weather').addEventListener('change', (e) => settings.set('weather', e.target.value));
    $('#in-vol').addEventListener('input', (e) => { settings.set('volume', +e.target.value); $('#v-vol').textContent = Math.round(e.target.value * 100); });
    this.debugBox = $('#in-debug');
    this.debugBox.addEventListener('change', (e) => this.emit('debug', e.target.checked));
    this.playBtn.addEventListener('click', () => this.emit('play'));
  }

  setProgress(p, msg) {
    this.loading.querySelector('.fill').style.width = `${Math.round(p * 100)}%`;
    if (msg) this.loading.querySelector('.msg').textContent = msg;
  }

  ready() {
    this.loading.style.display = 'none';
    this.body.style.display = 'block';
  }

  show(paused) {
    this.el.style.display = 'flex';
    this.playBtn.textContent = paused ? '계속하기' : '클릭하여 시작';
    this.lockMsg.textContent = '';
  }

  hide() { this.el.style.display = 'none'; }

  sync(state) {
    this.debugBox.checked = state.debug;
  }

  lockFailed() {
    this.lockMsg.textContent = '마우스 잠금 실패 — 잠시 후 다시 클릭하세요.';
  }
}
