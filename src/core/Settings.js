// 사용자 설정 (Esc 메뉴) — localStorage에 저장, 실패해도 기본값으로 동작
import { CONFIG } from '../config.js';
import { EventEmitter } from './EventEmitter.js';

const KEY = 'jungle-fps-settings-v1';

export class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = { ...CONFIG.defaults };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.values, JSON.parse(raw));
    } catch { /* 저장소 사용 불가 */ }
    // 잘못된 값 보정
    if (!CONFIG.graphics[this.values.quality]) this.values.quality = CONFIG.defaults.quality;
    if (!CONFIG.timeOfDay.presets[this.values.timeOfDay]) this.values.timeOfDay = CONFIG.defaults.timeOfDay;
    if (!CONFIG.weather.presets[this.values.weather]) this.values.weather = CONFIG.defaults.weather;
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* 무시 */ }
    this.emit('change', { key: k, value: v });
  }
}
