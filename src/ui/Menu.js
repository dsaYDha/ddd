// 로딩·시작·일시정지(설정) 화면
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';

const CONTROLS = [
  ['WASD', '이동'], ['마우스', '시점'], ['Shift', '달리기'], ['X', '조용히 걷기 (토글)'],
  ['C', '앉기'], ['Z', '엎드리기'], ['Q / E', '기울이기'], ['Space', '점프 (앉은 상태에선 일어서기)'],
  ['Esc', '일시정지·설정'], ['F3', '디버그 정보 (켜진 동안 1~9: 테스트 지점)'], ['F6', '거동 불능 시뮬레이션'],
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
          <div class="sub">동남아 열대 정글 · 1단계 — 지형과 이동</div>
          <div id="loading"><div class="bar"><div class="fill"></div></div><div class="msg">맵 생성 중…</div></div>
          <div id="menu-body" style="display:none">
            <p class="brief">지형 자체가 적이다. 진흙은 발을 붙잡고, 논은 걸음을 늦추고, 젖은 비탈은 몸을 끌어내린다.
              오솔길은 빠르지만 드러나고, 숲은 느리고 바스락거리지만 몸을 숨겨 준다.
              체력 바는 없다 — 숨소리와 흐려지는 시야로 몸 상태를 느껴라.</p>
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
                <label class="check"><input id="in-incap" type="checkbox"> 거동 불능 시뮬레이션 (F6)</label>
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
    this.incapBox = $('#in-incap');
    this.debugBox.addEventListener('change', (e) => this.emit('debug', e.target.checked));
    this.incapBox.addEventListener('change', (e) => this.emit('incapacitate', e.target.checked));
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
    this.incapBox.checked = state.incapacitated;
  }

  lockFailed() {
    this.lockMsg.textContent = '마우스 잠금 실패 — 잠시 후 다시 클릭하세요.';
  }
}
