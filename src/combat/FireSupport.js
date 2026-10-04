// =====================================================================
//  FireSupport — 7단계 무전 지원 화력·헬기 보급 (순수 로직: three.js·DOM 없음 → Node 테스트 가능)
//   요청은 '지도에서 고른 지점' 기준 — 플레이어가 자기 위치를 잘못 알면 엉뚱한 곳에 떨어진다 (실제 위치는 모름).
//   · 무전: 응답까지 radioLag 초, unavailable 확률로 '지금 불가' (횟수는 그대로)
//   · 위험 근접: 고른 지점이 아군 실제 위치(플레이어·분대원)에서 dangerClose m 안이면 경고 → confirm() 해야 사격
//   · 박격포·포병: 시험 사격(adjust) 1발 = 고른 지점 + spotError → 탄착을 보고 지도에서 다시 고르면 (adjust) 오차가 adjustError 로
//     줄어든 효력 사격 (박격포 6발 / 포병 12발, spread m 안에 흩어짐). 시험 사격 없이 바로 효력 사격(ffe)도 되지만 오차는 처음 그대로.
//     도착: 요청부터 arrive 초 (무전 응답 포함). 날아오는 소리는 whistle 초 먼저 ('incoming').
//   · 탄착: 6단계 폭발 (CombatSystem.explode — 파편 → 부위별 부상, 거리표 제압). 캐노피가 짙으면 수관 폭발 (나무 높이에서
//     터져 파편이 위에서 아래로), 땅이면 포탄 구덩이 ('crater').
//   · 조명탄 사격 (밤): 지정 지점 위에 3발 (6단계 Flares — 높이·수명만 다름)
//   · 헬기 보급: 개활지(캐노피 maxCanopy 미만·깊은 물 아님)만, arrive 초 뒤 상자 투하 — 헬기 소리가 아주 멀리 들림 (소음 noise m)
//   · 적 박격포 (습격 임무): enemyBarrage — 적이 아는 플레이어 쪽 위치 ± error 로 몇 발 (발사음 → flight 초 뒤 탄착)
//  이벤트: 'radio' {text, kind, mission} · 'dangerClose' {mission} · 'incoming' {shell, eta} · 'impact' {shell, point, airburst, crater}
//          'fired' {mission, rounds} · 'mission' {mission, state} · 'heli' {state: 'inbound'|'drop', point, eta} · 'drop' {crate}
//          'enemyLaunch' {from, shell}
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';

const rr = (rng, r) => rng.range(r[0], r[1]);
export const SUPPORT_LABELS = { mortar: '박격포', artillery: '포병', illum: '조명탄', resupply: '헬기 보급' };

export class FireSupport extends EventEmitter {
  /**
   * @param {{ combat?, query?, noise?, flares?, rng?, friendlies?: () => Array<{x,z}> }} opts
   *   friendlies: 아군 실제 위치 (위험 근접 판정 — 플레이어 + 살아 있는 분대원)
   */
  constructor(opts = {}) {
    super();
    this.combat = opts.combat ?? null;
    this.query = opts.query ?? null;
    this.noise = opts.noise ?? null;
    this.flares = opts.flares ?? null;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.friendlies = opts.friendlies ?? (() => []);
    this.time = 0;
    this.missions = [];
    this.shells = [];             // 날아오는 탄 { kind, point, at, eta, faction, mission, whistled }
    this.crates = [];             // 떨어진 보급 상자 { x, y, z, opened }
    this.craters = [];
    this.reset();
  }

  /** 임무 시작: 횟수·기록 초기화 */
  reset() {
    const S = CONFIG.support, U = CONFIG.supply;
    this.left = { mortar: S.mortar.count, artillery: S.artillery.count, illum: S.illum.count, resupply: U.heli.count };
    this.missions.length = 0;
    this.shells.length = 0;
    this.crates.length = 0;
    this.craters.length = 0;
    this.log = { requests: 0, denied: 0, dangerClose: 0, spot: 0, ffe: 0, rounds: { mortar: 0, artillery: 0, illum: 0, enemy: 0 }, airbursts: 0, resupply: 0, byKind: { mortar: 0, artillery: 0, illum: 0, resupply: 0 } };
    this._id = 1;
  }

  /** 디버그: 횟수만 처음대로 */
  resetCounts() {
    const S = CONFIG.support, U = CONFIG.supply;
    this.left = { mortar: S.mortar.count, artillery: S.artillery.count, illum: S.illum.count, resupply: U.heli.count };
  }

  // =================================================================
  // 요청
  // =================================================================
  /**
   * @param {'mortar'|'artillery'|'illum'|'resupply'} kind
   * @param {{x,z}} point  지도에서 고른 지점
   * @param {{ mode?: 'adjust'|'ffe', night?: number }} opts  mode: 시험 사격부터 (기본) / 바로 효력 사격
   * @returns {{ ok: boolean, reason?: string, mission?: object }}  reason: 'none' (횟수 없음) · 'day' (조명탄은 밤만) · 'open' (헬기: 개활지 아님) · 'busy'
   */
  request(kind, point, opts = {}) {
    const S = CONFIG.support;
    if (!(kind in this.left)) return { ok: false, reason: 'kind' };
    if (this.left[kind] <= 0) return { ok: false, reason: 'none' };
    if (kind === 'illum' && (opts.night ?? 1) < 0.35) return { ok: false, reason: 'day' };
    if (kind === 'resupply' && !this.openGround(point)) return { ok: false, reason: 'open' };
    if (this.missions.some((m) => m.kind === kind && !m.done && m.state !== 'adjusting')) return { ok: false, reason: 'busy' };
    const now = this.time;
    const m = {
      id: this._id++, kind, mode: kind === 'mortar' || kind === 'artillery' ? (opts.mode ?? 'adjust') : 'ffe',
      point: { x: point.x, z: point.z }, aim: null, state: 'radio', at: now + rr(this.rng, S.radioLag), requestedAt: now,
      confirmed: false, done: false, spot: null, rounds: 0,
    };
    this.missions.push(m);
    this.log.requests++;
    this.emit('mission', { mission: m, state: 'radio' });
    return { ok: true, mission: m };
  }

  /** 시험 사격 탄착을 보고 지도에서 다시 고른 지점 → 효력 사격 */
  adjust(mission, point) {
    const S = CONFIG.support;
    if (!mission || mission.state !== 'adjusting') return { ok: false, reason: 'state' };
    mission.point = { x: point.x, z: point.z };
    mission.mode = 'ffe';
    mission.adjusted = true;
    mission.confirmed = false;
    mission.state = 'radio';
    mission.at = this.time + rr(this.rng, S.radioLag);
    mission.requestedAt = this.time;
    this.emit('mission', { mission, state: 'radio' });
    return { ok: true, mission };
  }

  /** 위험 근접 경고 뒤 확인 → 사격 */
  confirm(mission) {
    if (!mission || mission.state !== 'dangerClose') return false;
    mission.confirmed = true;
    mission.state = 'radio';
    mission.at = this.time + 4;
    this.emit('mission', { mission, state: 'radio' });
    return true;
  }

  cancel(mission) {
    if (!mission || mission.done) return;
    mission.done = true;
    mission.state = 'cancelled';
    this.emit('mission', { mission, state: 'cancelled' });
  }

  /** 지금 받을 수 있는 임무: 위험 근접 확인 대기 · 수정 대기 */
  get pendingConfirm() { return this.missions.find((m) => m.state === 'dangerClose' && !m.done) ?? null; }
  get pendingAdjust() { return this.missions.find((m) => m.state === 'adjusting' && !m.done) ?? null; }

  /** 헬기가 내릴 수 있는 개활지 (논·강가·모래톱 — 캐노피가 얇고 깊은 물이 아님) */
  openGround(p) {
    const q = this.query;
    if (!q) return true;
    const U = CONFIG.supply.heli;
    let cov = 0;
    for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]]) cov = Math.max(cov, q.getCanopyCover(p.x + dx, p.z + dz));
    return cov < U.maxCanopy && q.getWaterDepth(p.x, p.z) < 0.6;
  }

  /** 아군 실제 위치에서 가장 가까운 거리 */
  nearestFriendly(p) {
    let best = Infinity;
    for (const f of this.friendlies()) best = Math.min(best, Math.hypot(f.x - p.x, f.z - p.z));
    return best;
  }

  // =================================================================
  // 프레임
  // =================================================================
  update(dt) {
    if (!(dt > 0)) return;
    this.time += dt;
    const now = this.time, S = CONFIG.support;
    this._enemyLaunches();
    for (const m of this.missions) {
      if (m.done) continue;
      if (m.state === 'radio' && now >= m.at) this._reply(m);
      else if (m.state === 'dangerClose' && now >= m.confirmUntil) { this.cancel(m); this._radio(`${SUPPORT_LABELS[m.kind]} — 확인이 없어 사격 취소.`, m); }
      else if (m.state === 'adjusting' && now >= m.adjustUntil) { m.done = true; m.state = 'ended'; this._radio('수정 지점이 오지 않음. 사격 임무 종료.', m); }
    }
    // 날아오는 탄
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      if (!sh.whistled && now >= sh.at - sh.whistle) {
        sh.whistled = true;
        this.emit('incoming', { shell: sh, eta: sh.at - now });
      }
      if (now < sh.at) continue;
      this.shells.splice(i, 1);
      this._impact(sh);
    }
    // 헬기
    for (const m of this.missions) {
      if (m.kind !== 'resupply' || m.done || m.state !== 'inbound') continue;
      if (!m.heliNoise && now >= m.eta - 40) {
        // 헬기가 다가오는 소리 — 아주 멀리까지 들림 (근처 적이 몰려옴)
        m.heliNoise = true;
        this.noise?.emitNoise({ x: m.aim.x, y: 40, z: m.aim.z }, CONFIG.supply.heli.noise, 'explosion', null, { faction: 'none', heli: true });
        this.emit('heli', { state: 'approach', point: m.aim, eta: m.eta - now, mission: m });
      }
      if (now >= m.eta) this._drop(m);
    }
  }

  /** 무전 응답 (radioLag 뒤) */
  _reply(m) {
    const S = CONFIG.support, now = this.time;
    const label = SUPPORT_LABELS[m.kind];
    // 지금 불가
    if (!m.confirmed && this.rng.chance(S.unavailable)) {
      m.done = true; m.state = 'denied';
      this.log.denied++;
      this._radio(`${label} 요청 — 지금은 불가. 나중에 다시 하라.`, m, 'deny');
      return;
    }
    // 위험 근접 (지도에서 고른 지점이 아군 실제 위치 가까이)
    if (!m.confirmed && m.kind !== 'resupply' && m.kind !== 'illum' && this.nearestFriendly(m.point) < S.dangerClose) {
      m.state = 'dangerClose';
      m.confirmUntil = now + S.confirmWindow;
      this.log.dangerClose++;
      this._radio(`위험 근접! 지정 지점이 아군 위치 ${S.dangerClose}m 안이다. 확인하면 사격한다 — 다시 확인하라.`, m, 'danger');
      this.emit('dangerClose', { mission: m });
      return;
    }
    // 횟수는 실제로 쏠 때 (첫 응답 때 한 번)
    if (!m.counted) { m.counted = true; this.left[m.kind]--; this.log.byKind[m.kind]++; }
    if (m.kind === 'resupply') {
      const U = CONFIG.supply.heli;
      m.state = 'inbound';
      m.eta = m.requestedAt + rr(this.rng, U.arrive);
      const e = rr(this.rng, U.dropError), a = this.rng.range(0, Math.PI * 2);
      m.aim = { x: m.point.x + Math.cos(a) * e, z: m.point.z + Math.sin(a) * e };
      this.log.resupply++;
      this._radio(`보급 헬기 출발. 약 ${Math.round((m.eta - now) / 60 + 0.4)}분 뒤 지정 지점. 연막은 없다 — 소리를 듣고 가라.`, m);
      this.emit('heli', { state: 'inbound', point: m.aim, eta: m.eta - now, mission: m });
      return;
    }
    if (m.kind === 'illum') {
      const I = S.illum;
      m.state = 'fired';
      const arrive = m.requestedAt + rr(this.rng, I.arrive);
      for (let k = 0; k < I.rounds; k++) {
        const e = rr(this.rng, I.error), a = this.rng.range(0, Math.PI * 2);
        const at = Math.max(now + 3, arrive) + k * rr(this.rng, I.interval);
        this.shells.push({ kind: 'illum', point: { x: m.point.x + Math.cos(a) * e, z: m.point.z + Math.sin(a) * e }, at, whistle: 0.8, faction: 'friend', mission: m });
      }
      m.rounds = I.rounds;
      this.log.rounds.illum += I.rounds;
      this._radio(`조명탄 ${I.rounds}발, 약 ${Math.round(arrive - now)}초 뒤.`, m);
      this.emit('fired', { mission: m, rounds: I.rounds });
      return;
    }
    // 박격포·포병
    const K = S[m.kind];
    const arrive = Math.max(now + 6, m.requestedAt + rr(this.rng, K.arrive));
    const err = m.adjusted ? rr(this.rng, S.adjustError) : rr(this.rng, S.spotError);
    const a = this.rng.range(0, Math.PI * 2);
    const center = { x: m.point.x + Math.cos(a) * err, z: m.point.z + Math.sin(a) * err };
    m.aim = center; m.error = err;
    if (m.mode === 'adjust' && !m.adjusted) {
      m.state = 'spotting';
      m.spot = { at: arrive, point: center };
      this.shells.push({ kind: m.kind, point: center, at: arrive, whistle: rr(this.rng, S.whistle), faction: 'friend', mission: m, spot: true });
      m.rounds = 1;
      this.log.spot++;
      this.log.rounds[m.kind]++;
      this._radio(`${label} 시험 사격 1발, 약 ${Math.round(arrive - now)}초 뒤. 탄착을 보고 지도에서 수정 지점을 알려라.`, m);
      this.emit('fired', { mission: m, rounds: 1, spot: true });
      return;
    }
    m.state = 'ffe';
    let t = arrive;
    for (let k = 0; k < K.rounds; k++) {
      const r = Math.sqrt(this.rng.range(0, 1)) * S.spread, b = this.rng.range(0, Math.PI * 2);
      this.shells.push({ kind: m.kind, point: { x: center.x + Math.cos(b) * r, z: center.z + Math.sin(b) * r }, at: t, whistle: rr(this.rng, S.whistle), faction: 'friend', mission: m });
      t += rr(this.rng, K.interval);
    }
    m.rounds += K.rounds;
    this.log.ffe++;
    this.log.rounds[m.kind] += K.rounds;
    this._radio(`${label} 효력 사격 ${K.rounds}발, 약 ${Math.round(arrive - now)}초 뒤.`, m);
    this.emit('fired', { mission: m, rounds: K.rounds });
  }

  /** 탄착 */
  _impact(sh) {
    const S = CONFIG.support, q = this.query, now = this.time;
    const p = sh.point;
    if (sh.kind === 'illum') {
      const I = S.illum;
      if (this.flares) {
        const gy = q ? q.getTerrainHeight(p.x, p.z) : 0;
        this.flares.launch({ x: p.x, y: gy + rr(this.rng, I.height) + 25, z: p.z }, null,
          { at: { x: p.x, y: gy + rr(this.rng, I.height), z: p.z }, life: I.life, illum: true });
      }
      this.emit('impact', { shell: sh, point: { x: p.x, y: 0, z: p.z }, illum: true });
      this._checkDone(sh.mission);
      return;
    }
    const K = sh.kind === 'enemyMortar' ? { ...S.mortar, fragments: S.enemyMortar.fragments } : S[sh.kind];
    const ground = q ? q.getSupportHeight(p.x, p.z) : 0;
    const canopy = q && q.getCanopyCover ? q.getCanopyCover(p.x, p.z) : 0;
    const AB = S.airburst;
    const airburst = canopy >= AB.minCanopy && this.rng.chance(Math.min(1, Math.pow(canopy, AB.exp) * AB.chanceMul));
    const y = airburst ? ground + rr(this.rng, AB.height) : ground + 0.15;
    const point = { x: p.x, y, z: p.z };
    const shooter = { name: sh.kind === 'enemyMortar' ? '적 박격포' : SUPPORT_LABELS[sh.kind], isShell: true, faction: sh.faction, kind: sh.kind, position: point };
    let result = null;
    if (this.combat) {
      result = this.combat.explode(point, {
        kind: 'shell', fragments: K.fragments, speed: K.speed, elev: airburst ? AB.elev : [-5, 45], shooter,
        blast: { noise: K.noise, suppression: K.suppression }, faction: sh.faction,
      });
    }
    if (airburst) this.log.airbursts++;
    if (!airburst) {
      const C = S.crater;
      const crater = { x: p.x, z: p.z, r: rr(this.rng, C.radius), kind: sh.kind };
      this.craters.push(crater);
      if (this.craters.length > C.max) this.craters.shift();
    }
    if (sh.kind === 'enemyMortar') this.log.rounds.enemy++;
    this.emit('impact', { shell: sh, point, airburst, crater: !airburst, canopy, result });
    if (sh.spot) {
      const m = sh.mission;
      m.state = 'adjusting';
      m.adjustUntil = now + S.adjustWait;
      m.spotPoint = { x: p.x, z: p.z };
      this._radio(`시험 사격 탄착. 수정 지점을 알려라 (지도에서 다시 지정).`, m);
    } else this._checkDone(sh.mission);
  }

  _checkDone(m) {
    if (!m || m.done) return;
    if (!this.shells.some((s) => s.mission === m)) {
      m.done = true;
      m.state = 'complete';
      this.emit('mission', { mission: m, state: 'complete' });
    }
  }

  /** 헬기 보급: 상자 투하 */
  _drop(m) {
    m.done = true;
    m.state = 'dropped';
    const q = this.query;
    const p = m.aim;
    const crate = { x: p.x, y: q ? q.getSupportHeight(p.x, p.z) : 0, z: p.z, opened: false, mission: m, at: this.time, ...CONFIG.supply.crate };
    this.crates.push(crate);
    // 상자가 떨어지는 소리 + 헬기가 머무는 소리 (적이 몰려옴 — Game/디렉터가 근처 적 분대를 그쪽으로)
    this.noise?.emitNoise({ x: p.x, y: crate.y + 2, z: p.z }, CONFIG.supply.heli.noise, 'explosion', null, { faction: 'none', heli: true });
    this.emit('heli', { state: 'drop', point: { x: p.x, z: p.z }, mission: m });
    this.emit('drop', { crate });
    this._radio('보급 상자 투하 완료. 헬기 복귀한다.', m);
  }

  // =================================================================
  // 적 박격포
  // =================================================================
  /**
   * @param {{x,z}} from  박격포 자리 (야영지)
   * @param {{x,z}} target  적이 아는 플레이어 쪽 위치 (대략)
   */
  enemyBarrage(from, target) {
    const E = CONFIG.support.enemyMortar, now = this.time;
    const n = this.rng.int(E.rounds[0], E.rounds[1]);
    let t = now;
    for (let k = 0; k < n; k++) {
      t += rr(this.rng, E.interval);
      const err = rr(this.rng, E.error), a = this.rng.range(0, Math.PI * 2);
      const flight = rr(this.rng, E.flight);
      const sh = { kind: 'enemyMortar', point: { x: target.x + Math.cos(a) * err, z: target.z + Math.sin(a) * err }, at: t + flight, whistle: rr(this.rng, CONFIG.support.whistle), faction: 'enemy', mission: null, launchAt: t, from };
      this.shells.push(sh);
    }
    return n;
  }

  /** 적 박격포 발사음 (탄착 전 flight 초) — update 에서 */
  _enemyLaunches() {
    const now = this.time;
    for (const sh of this.shells) {
      if (sh.kind !== 'enemyMortar' || sh.launched || now < sh.launchAt) continue;
      sh.launched = true;
      this.emit('enemyLaunch', { from: sh.from, shell: sh });
    }
  }

  _radio(text, mission, kind = 'support') {
    this.emit('radio', { text, kind, mission });
  }

  /** 결과 화면용 요약 */
  summary() {
    const L = this.log;
    return {
      mortar: L.byKind.mortar, artillery: L.byKind.artillery, illum: L.byKind.illum, resupply: L.byKind.resupply,
      rounds: { ...L.rounds }, spot: L.spot, ffe: L.ffe, denied: L.denied, dangerClose: L.dangerClose, airbursts: L.airbursts,
    };
  }
}

