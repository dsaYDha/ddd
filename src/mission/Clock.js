// =====================================================================
//  GameClock — 5단계 게임 시계 (순수 로직). 실제 시간의 CONFIG.mission.timeScale 배로 흐른다.
//   hours: 시작 시각부터 계속 늘어남 (24 를 넘을 수 있음 — 6단계 밤 임무), label 'HH:MM'. todBlend(): 시계 키(CONFIG.timeOfDay.clock)
//   사이 보간 (24 로 나눈 나머지 시각) — Atmosphere 가 두 시간대 프리셋을 섞고, 환경음이 새벽 새·한낮 매미·해질녘 벌레·밤 개구리 비중을 정한다.
//   light: 낮 빛 비율 (6단계 — 1 − light 만큼 밤 빛), night: 1 − light
// =====================================================================
import { CONFIG } from '../config.js';

export class GameClock {
  constructor(startHour = 6, speed = CONFIG.mission.timeScale) {
    this.start = startHour;
    this.hours = startHour;
    this.speed = speed;
    this.elapsed = 0;          // 실제 s
    this._blend = { a: 'dawn', b: 'dawn', k: 0, dawn: 1, day: 0, dusk: 0, nightAmb: 0, light: 1, night: 0 };
  }

  update(dt) {
    if (!(dt > 0)) return;
    this.elapsed += dt;
    this.hours = this.start + (this.elapsed * this.speed) / 3600;
  }

  /** 실제 s 동안 흐를 게임 시간 (시간) */
  static gameHours(realSeconds, speed = CONFIG.mission.timeScale) { return (realSeconds * speed) / 3600; }

  static format(h) {
    const hh = ((Math.floor(h) % 24) + 24) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  get label() { return GameClock.format(this.hours); }

  /** 시간대 섞기: { a, b, k (0→a, 1→b), dawn, day, dusk, nightAmb (환경음 가중치), light (낮 빛 비율), night } */
  todBlend(h = this.hours, out = this._blend) {
    const keys = CONFIG.timeOfDay.clock, P = CONFIG.timeOfDay.presets;
    h = ((h % 24) + 24) % 24;
    let a = keys[0], b = keys[0];
    if (h <= keys[0][0]) { a = b = keys[0]; }
    else if (h >= keys[keys.length - 1][0]) { a = b = keys[keys.length - 1]; }
    else {
      for (let i = 0; i < keys.length - 1; i++) {
        if (h >= keys[i][0] && h <= keys[i + 1][0]) { a = keys[i]; b = keys[i + 1]; break; }
      }
    }
    const span = b[0] - a[0];
    const k = span > 0 ? (h - a[0]) / span : 0;
    const s = k * k * (3 - 2 * k);
    out.a = a[1]; out.b = b[1]; out.k = s;
    const A = P[a[1]], B = P[b[1]];
    out.dawn = A.ambienceDawn + (B.ambienceDawn - A.ambienceDawn) * s;
    out.day = A.ambienceDay + (B.ambienceDay - A.ambienceDay) * s;
    out.dusk = A.ambienceDusk + (B.ambienceDusk - A.ambienceDusk) * s;
    out.nightAmb = (A.ambienceNight ?? 0) + ((B.ambienceNight ?? 0) - (A.ambienceNight ?? 0)) * s;
    out.light = (A.light ?? 1) + ((B.light ?? 1) - (A.light ?? 1)) * s;
    out.night = 1 - out.light;
    return out;
  }
}
