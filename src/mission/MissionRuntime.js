// =====================================================================
//  MissionRuntime — 5단계 임무 진행 (게임 쪽 연결: 화면·소리·월드). 순수 로직(MissionGen·Director·Mission·Weather·Clock)을
//   Game 의 월드·적·전투·HUD·소리에 잇는다.
//   · 시작: 이전 임무 개활지 되돌리기 → 새 개활지 깎기(야영지·모래톱) → 소품(오두막·모닥불·흔적) → 플레이어 투입 →
//     시계·날씨 → 지도 그림 → 디렉터 시작 (적 배치는 디렉터가 시야 밖·150m 밖에서만).
//   · 매 프레임: 시계 4배 → 대기 (시간대 섞기 + 날씨 흐름: 비·안개·젖음도·하늘), 천둥(번개 → 거리/음속 뒤 소리, 총성 가림),
//     발자국 시간 경과(비가 오면 빨리), 디렉터(생성·먼 총성·무전), 임무(목표·회수·제한 시간), 지형 잔향(골짜기/숲),
//     적 시야 안개, 결과 집계(이동 거리·사상자 확인/추정).
//   · 끝: 회수 지점 60초 → 헬기 소리가 다가오고 화면이 검게 → 결과 / 사망·시간 초과·포기·행렬 놓침 → 결과.
//   · 체크포인트 (설정, 1회): 첫 중간 목표 때 저장 → 결과 화면에서 그 순간부터 다시.
//  이벤트: 'result' {summary} (Game 이 결과 화면을 띄움)
// =====================================================================
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { generateMission, MISSION_LABELS } from './MissionGen.js';
import { Director } from './Director.js';
import { Mission } from './Mission.js';
import { WeatherCycle } from './Weather.js';
import { GameClock } from './Clock.js';
import { buildMapData } from './MapData.js';
import { carveAreas, restoreCarve } from '../world/Carve.js';
import { FootprintMesh } from '../render/FootprintMesh.js';
import { MissionProps } from '../render/MissionProps.js';
import { WeaponAudio } from '../audio/WeaponAudio.js';

const ARM_PARTS = { L: ['upperArmL', 'forearmL'], R: ['upperArmR', 'forearmR'] };

export class MissionRuntime extends EventEmitter {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    super();
    this.g = game;
    this.world = { data: game.data, query: game.query, nav: game.nav };
    this.printMesh = new FootprintMesh(game.scene, game.footprints, game.query);
    this.props = new MissionProps(game.scene, game.world);
    this.mapData = null;
    this.def = null;
    this.mission = null;
    this.director = null;
    this.clock = null;
    this.weather = null;
    this.active = false;
    this.ending = null;           // { t, fade, done } 화면이 검게
    this.checkpoint = null;       // 저장된 상태 (1회)
    this.checkpointUsed = false;
    this._carve = null;
    this._offs = [];
    this._shotQ = [];
    this._atmT = 0;
    this._envT = 0;
    this._last = null;
  }

  generate(type, seed) { return generateMission(type, seed, this.world); }

  /** 지도 데이터 (맵 하나에 한 번) */
  map() {
    if (!this.mapData) this.mapData = buildMapData(this.g.data, this.g.query);
    return this.mapData;
  }

  // -----------------------------------------------------------------
  // 시작 · 끝
  // -----------------------------------------------------------------
  /**
   * @param {object} def  generateMission 결과 (브리핑에서 본 것)
   * @param {{ checkpoint?: boolean, restore?: object }} opts
   */
  start(def, opts = {}) {
    const g = this.g;
    this.stop();
    this.def = def;
    // 월드: 이전 개활지를 되돌리고 새로 깎기 → 소품 (오두막이 문서 위치를 고칠 수 있음)
    if (this._carve) { restoreCarve(g.world, g.nav, this._carve); this._carve = null; }
    this._carve = def.carve?.length ? carveAreas(g.world, g.nav, def.carve) : null;
    this.props.build(def, g.nav);
    // 플레이어
    const R = opts.restore;
    g.resetForMission(R ? R.player.x : def.start.x, R ? R.player.z : def.start.z, R ? R.player.yaw : def.start.yaw);
    if (R) g.restorePlayer(R.player);
    // 시계·날씨
    this.clock = new GameClock(def.startHour);
    this.weather = new WeatherCycle(def.weatherPlan, new RNG((def.seed * 17 + 5) >>> 0));
    if (R) { this.clock.update(R.clock); this._fastWeather(R.weatherT); }
    g.atmosphere.setDynamic(this.clock.todBlend(), this.weather.params, true);
    // 임무·디렉터
    this.mission = new Mission(def, { checkpoint: !!opts.checkpoint && !R });
    this.director = new Director({ mission: def, enemies: g.enemies, world: this.world, footprints: g.footprints });
    this._wire();
    this.active = true;
    this.ending = null;
    this._stats = { distance: 0, shots0: 0, hits0: 0, confirmed: 0, estimated: 0, enemyWounded: 0 };
    this._kills = new Set();
    this._last = { x: g.motor.position.x, z: g.motor.position.z };
    this._shotQ.length = 0;
    if (R) this._applyRestore(R);
    else this.checkpoint = null;
    this.checkpointUsed = !!R;
    // 지도 (연필 표시)
    g.paperMap.draw(this.map(), def.marks, `${MISSION_LABELS[def.type]} · 작전 #${String(def.seed).slice(-4).padStart(4, '0')}`);
    if (!R) this.director.start(this._ctx());
    this.update(0);
  }

  /** 끝내기 (결과 화면으로 가거나 다른 임무로) — 소리·구독 정리 */
  stop() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.director?.dispose();
    this.g.missionAudio?.heliStop(1);
    this.active = false;
  }

  _wire() {
    const g = this.g, d = this.director, m = this.mission, w = this.weather;
    const on = (em, ev, fn) => { this._offs.push(em.on(ev, fn)); };
    on(d, 'radio', (e) => this.radio(e.text, e.kind));
    on(d, 'distantFire', (e) => {
      const now = g.enemies.time;
      // 연발 간격대로 (소리가 오는 시간 거리/음속은 WeaponAudio 가 더함)
      for (const s of e.shots) this._shotQ.push({ at: now + s.t, x: e.x, z: e.z, weapon: s.weapon, distance: e.distance });
    });
    on(d, 'reinforce', (e) => { if (e.state === 'spawned' && g.debug.visible) g.hud.toast('(디버그) 증원 생성', 1.5); });
    on(m, 'objective', (e) => {
      const o = e.o;
      if (o.kind === 'observe') this.radio(`확인 지점 ${e.index + 1} — ${o.label}. 확인했다.`, 'progress');
      else if (o.kind === 'documents') this.radio('문서 확보 확인. 회수 지점으로 이동하라.', 'progress');
      else if (o.kind === 'ambush') { /* 디렉터가 무전 */ }
    });
    on(m, 'extract', () => {
      if (this.def.type !== 'ambush') this.radio(`모든 목표 완료. 회수 지점 — ${this.def.extraction.label} — 으로 이동하라.`, 'progress', 3);
    });
    on(m, 'zone', (e) => {
      if (e.inside) {
        if (!g.missionAudio.heli) { g.missionAudio.heliStart(CONFIG.mission.extraction.hold * 0.9); this.radio('회수 지점 도착 확인. 헬기 접근 중 — 1분만 버텨라.', 'progress'); }
        else this.radio('좋다, 거기서 기다려라.', 'progress');
      } else this.radio('회수 지점을 벗어났다 — 헬기가 내릴 수 없다.', 'progress');
    });
    on(m, 'warn', (e) => this.radio(`남은 시간 약 ${e.min}분. ${m.phase === 'extract' ? '회수 지점으로 서둘러라.' : '서둘러라.'}`, 'progress'));
    on(m, 'checkpoint', () => { this.checkpoint = this._snapshot(); g.hud.toast('체크포인트', 1.6); });
    on(m, 'complete', () => { this.ending = { t: 0, fade: CONFIG.mission.extraction.fade, success: true }; });
    on(m, 'failed', (e) => {
      if (e.reason === 'dead') { this.ending = { t: 0, fade: 0, success: false, waitDeath: true }; return; }
      const msg = { time: '제한 시간이 지났다. 작전 중지 — 철수하라.', missed: '행렬이 지나갔다. 매복 실패 — 철수하라.', abort: '작전 중지.' }[e.reason];
      if (msg && e.reason !== 'abort') this.radio(msg, 'progress');
      this.ending = { t: 0, fade: e.reason === 'abort' ? 0.01 : 3, success: false };
    });
    on(w, 'flash', (e) => g.atmosphere.flash(Math.min(1, e.intensity * (e.distance < 1500 ? 1 : 0.55))));
    on(w, 'thunder', (e) => g.missionAudio.thunder(e.distance, e.intensity));
    // 적 사상자: 내 탄에 맞은 적 표시 → 쓰러지는 걸 봤나 / 죽을 때 보였나
    const em = g.enemies;
    on(g.combat, 'hit', (e) => {
      if (e.shooter !== g.playerPerson) return;
      const s = em.soldiers.find((x) => x.person === e.person);
      if (s) s.hitByPlayer = true;
    });
    on(em, 'fall', (e) => { if (e.soldier.hitByPlayer) e.soldier.seenFall = e.soldier.seenFall || this._canSee(e.soldier); });
    on(em, 'death', (e) => {
      const s = e.soldier;
      if (!s.hitByPlayer || this._kills.has(s)) return;
      this._kills.add(s);
      if (s.seenFall || this._canSee(s)) this._stats.confirmed++; else this._stats.estimated++;
    });
  }

  /** 무전: 잡음 + 자막 (kind 'intel' 은 더 거칠게) */
  radio(text, kind = 'progress', extra = 0) {
    const g = this.g;
    const dur = Math.min(7.5, 2.2 + text.length * 0.055) + extra;
    g.hud.radio(text, dur);
    g.missionAudio.radio(Math.min(2.6, 0.9 + text.length * 0.02), kind);
  }

  // -----------------------------------------------------------------
  // 매 프레임
  // -----------------------------------------------------------------
  update(dt) {
    if (!this.active) return;
    const g = this.g, m = g.motor;
    // 시계·날씨 → 대기 (0.25초마다 목표 갱신 — 둘 다 천천히 변함)
    this.clock.update(dt);
    const P = this.weather.update(dt);
    g.noise.thunderMask = this.weather.thunderMask;
    this._atmT -= dt;
    if (this._atmT <= 0) { this._atmT = 0.25; g.atmosphere.setDynamic(this.clock.todBlend(), P); }
    // 발자국 (비가 오면 빨리 사라짐) · 소품 (모닥불)
    g.footprints.update(dt, g.atmosphere.rainIntensity);
    this.printMesh.update(dt, g.camera);
    this.props.update(dt, g.camera);
    // 적 시야 안개 (지면 가까운 물안개 포함)
    const st = g.atmosphere.state;
    g.enemies.fogDensity = st.fogDensity + st.mist * 0.8;
    // 지형 잔향 (1초마다): 둘레가 높으면 골짜기
    this._envT -= dt;
    if (this._envT <= 0) { this._envT = 1; g.audio.setReverbMix(this._valley()); }
    // 먼 총성 (거리/음속 늦게)
    if (this._shotQ.length) {
      const now = g.enemies.time;
      for (let i = this._shotQ.length - 1; i >= 0; i--) {
        const q = this._shotQ[i];
        if (now < q.at) continue;
        this._shotQ.splice(i, 1);
        const pos = { x: q.x, y: g.camera.position.y + 2, z: q.z };
        const sp = WeaponAudio.spatial(g.camera.position, g.controller.yaw, pos, {});
        g.weaponAudio.shot({ own: false, distance: q.distance, pan: sp.pan, behind: sp.behind, profile: CONFIG.weapons[q.weapon].sound, veg: 0.8, gain: 0.9, pos });
      }
    }
    // 이동 거리
    const dx = m.position.x - this._last.x, dz = m.position.z - this._last.z, dl = Math.hypot(dx, dz);
    if (dl < 5) this._stats.distance += dl;
    this._last.x = m.position.x; this._last.z = m.position.z;
    // 디렉터 · 임무
    if (dt > 0 && !this.ending?.done) {
      this.director.update(dt, this._ctx());
      this.mission.update(dt, { pos: m.position, fwd: { x: -Math.sin(g.controller.yaw), z: -Math.cos(g.controller.yaw) }, alive: !g.injuries.dead, ambush: this.director.ambush.state });
    }
    // 끝: 검게 꺼짐 → 결과
    const E = this.ending;
    if (E && !E.done) {
      if (E.waitDeath) return;     // 사망: Game 이 사망 화면 뒤 Enter 로 result() 를 부름
      E.t += dt;
      if (E.fade > 0.02) g.hud.setBlackout(Math.min(1, E.t / E.fade));
      if (E.t >= E.fade + (E.success ? 1.2 : 0.4)) { E.done = true; this.emit('result', { summary: this.summary() }); }
    }
  }

  /** 사망 화면에서 Enter */
  resultAfterDeath() {
    if (!this.ending || this.ending.done) return;
    this.ending.done = true;
    this.emit('result', { summary: this.summary() });
  }

  abort() { if (this.active && !this.mission.done) this.mission.fail('abort'); }

  _ctx() {
    const g = this.g, m = g.motor, cp = g.camera.position;
    return {
      pos: m.position, eye: { x: cp.x, y: cp.y, z: cp.z }, fwd: { x: -Math.sin(g.controller.yaw), z: -Math.cos(g.controller.yaw) },
      alive: !g.injuries.dead, shots: g.combat.stats(g.playerPerson).shots,
    };
  }

  /** 지금 화면에서 그 병사가 보이나 (쓰러지는 걸 봄 = 확인 사살) */
  _canSee(s) {
    const g = this.g, cp = g.camera.position, p = s.motor.position;
    const tx = p.x, ty = p.y + (s.motor.stance === 'prone' || s.injuries.downed ? 0.35 : 1.0), tz = p.z;
    const dx = tx - cp.x, dy = ty - cp.y, dz = tz - cp.z, d = Math.hypot(dx, dy, dz);
    if (d > 260) return false;
    const fx = -Math.sin(g.controller.yaw), fz = -Math.cos(g.controller.yaw);
    const cosA = (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1);
    if (cosA < Math.cos((g.camera.fov * 0.5 + 12) * Math.PI / 180 * Math.max(1, g.camera.aspect * 0.75))) return false;
    const r = g.query.raycastWorld(cp, { x: dx, y: dy, z: dz }, Math.max(0.1, d - 0.4), 'vision');
    return !r.hit && r.transmittance > 0.12;
  }

  _valley() {
    const g = this.g, q = g.query, p = g.motor.position, MX = CONFIG.audio.mix;
    const h0 = q.getTerrainHeight(p.x, p.z);
    let sum = 0, n = 0;
    for (const r of MX.valleyRing) for (let a = 0; a < 8; a++) { sum += q.getTerrainHeight(p.x + Math.cos(a * 0.785) * r, p.z + Math.sin(a * 0.785) * r); n++; }
    return Math.max(0, Math.min(1, (sum / n - h0 + 1) / MX.valleyDepth));
  }

  /** 결과 집계 */
  summary() {
    const g = this.g, s = this.mission.stats, cs = g.combat.stats(g.playerPerson);
    s.distance = this._stats.distance;
    s.shots = cs.shots; s.hits = cs.hits;
    s.roundsLeft = g.shooter.weapon.totalRounds;
    s.looseLeft = g.pouch.loose;
    s.loaded = g.pouch.loaded;
    s.wounds = g.injuries.wounds.map((w) => `${w.label}${w.type === 'graze' ? ' (스침)' : w.arterial ? ' (동맥)' : ''}`);
    s.confirmed = this._stats.confirmed;
    s.estimated = this._stats.estimated;
    s.enemyWounded = g.enemies.soldiers.filter((x) => x.hitByPlayer && x.alive).length;
    s.weapon = g.shooter.weapon.data.label ?? '';
    return this.mission.summary();
  }

  /** 팔 부상 (탄창 채우기): 다친 팔 수 0~2 (스침 제외) */
  armsWounded() {
    const W = this.g.injuries.wounds;
    let n = 0;
    for (const side of ['L', 'R']) if (W.some((w) => ARM_PARTS[side].includes(w.part) && w.type !== 'graze')) n++;
    return n;
  }

  // -----------------------------------------------------------------
  // 체크포인트 (1회)
  // -----------------------------------------------------------------
  _snapshot() {
    const g = this.g, d = this.director, m = this.mission;
    const squads = g.enemies.squads.map((sq) => {
      const alive = sq.members.filter((s) => s.alive && !s.injuries.downed);
      if (!alive.length) return null;
      return {
        type: sq.type, kind: sq.directorKind ?? null, state: sq.state, oneWay: !!sq.oneWay, convoy: !!sq.convoy, reinforce: sq.reinforce ?? null,
        paceMul: sq.paceMul ?? 1, viaS: sq.viaS ?? null, passed: !!sq.passed, gone: !!sq.gone, campSquad: d.campSquads.includes(sq),
        route: sq.route ? sq.route.pts.filter((_, i) => sq.route.s[i] >= sq.pointS - 2).map((p) => ({ x: p.x, z: p.z })) : null,
        killZone: sq.killZone ?? sq.ambush?.killZone ?? null,
        members: alive.map((s) => ({
          x: s.motor.position.x, z: s.motor.position.z, yaw: s.motor.yaw, role: s.baseRole ?? s.role, weapon: s.weaponData.bipod ? 'lmg762' : 'rifle556',
          post: s.post ?? null, postRole: s.postRole ?? null, weaponState: s.shooter?.weapon?.snapshot?.() ?? null,
        })),
      };
    }).filter(Boolean);
    return {
      t: m.t, objectives: m.objectives.map((o) => ({ done: o.done, progress: o.progress, doneAt: o.doneAt })), phase: m.phase, hold: m.hold,
      warned: [...m._warned], stats: { ...this._stats }, kills: this._kills.size,
      clock: this.clock.elapsed, weatherT: this.weather.t,
      player: g.snapshotPlayer(),
      combatStats: { ...g.combat.stats(g.playerPerson) },
      director: {
        t: d.t, pending: d.pending.map((p) => ({ ...p })), reinforcements: d.reinforcements, reinforceAt: d.reinforceAt,
        ambush: { state: d.ambush.state, startCount: d.ambush.startCount, engagedAt: d.ambush.engagedAt }, bigFight: d.bigFight,
        firstContact: d.firstContact, nextDistant: d.nextDistant, shots0: d._shots0,
      },
      squads, docsTaken: !this.props.docs?.visible,
    };
  }

  /** 결과 화면 → 체크포인트에서 다시 */
  restoreCheckpoint() {
    if (!this.checkpoint || this.checkpointUsed) return false;
    const R = this.checkpoint;
    this.start(this.def, { restore: R });
    return true;
  }

  _fastWeather(t) {
    // 날씨 흐름을 저장 시각까지 (천둥 등 사건은 버림)
    const w = this.weather;
    const offs = [w.on('flash', () => {}), w.on('thunder', () => {})];
    for (let k = 0; k < t; k += 1) w.update(Math.min(1, t - k));
    w._pending.length = 0;
    w.thunderMask = 0;
    for (const o of offs) o?.();
  }

  _applyRestore(R) {
    const g = this.g, m = this.mission, d = this.director;
    m.t = R.t; m.phase = R.phase; m.hold = R.hold; m.checkpointDone = true;
    R.objectives.forEach((o, i) => Object.assign(m.objectives[i], o));
    for (const w of R.warned) m._warned.add(w);
    Object.assign(this._stats, R.stats);
    if (R.docsTaken) this.props.takeDocs();
    const cs = g.combat.stats(g.playerPerson);
    cs.shots = R.combatStats.shots; cs.hits = R.combatStats.hits;
    // 디렉터 상태 + 적 (살아 있던 분대를 그 자리에, 진정된 상태로 — 교전 중이던 분대는 저장 지점 근처를 수색)
    const D = R.director;
    d.t = D.t; d.pending = D.pending.map((p) => ({ ...p })); d.reinforcements = D.reinforcements; d.reinforceAt = D.reinforceAt;
    d.ambush.state = D.ambush.state; d.ambush.startCount = D.ambush.startCount; d.ambush.engagedAt = D.ambush.engagedAt;
    d.bigFight = D.bigFight; d.firstContact = D.firstContact; d.nextDistant = D.nextDistant; d._shots0 = D.shots0;
    d._offs.push(g.enemies.on('death', (e) => d._onDeath(e)), g.enemies.on('squadState', (e) => d._onSquadState(e)), g.enemies.on('routeEnd', (e) => d._onRouteEnd(e)));
    const em = g.enemies;
    for (const S of R.squads) {
      let sq = null;
      const n = S.members.length;
      const mg = S.members.some((x) => x.weapon === 'lmg762');
      if (S.type === 'camp') {
        sq = em.spawnCamp({ center: this.def.enemies.camp?.center ?? S.members[0], sentries: S.members.filter((x) => x.postRole === 'sentry').length, rest: S.members.filter((x) => x.postRole !== 'sentry').length, mg });
        if (sq) sq.members.forEach((s, i) => { const M = S.members[i]; if (M) { s.motor.teleport(M.x, M.z, M.yaw); if (M.post) { s.post = M.post; s.postRole = M.postRole; } } });
      } else if (S.type === 'ambush' && S.state === 'ambush' && S.killZone) {
        sq = em.spawnAmbush({ near: S.killZone, yaw: Math.atan2(-(S.killZone.dir?.x ?? 0), -(S.killZone.dir?.z ?? 1)), distance: 0, size: n, mg, killZone: S.killZone });
      } else {
        const route = S.route && S.route.length >= 2 ? S.route : [S.members[0], g.nav.nearestOpen(S.members[0].x + 20, S.members[0].z, 6) ?? S.members[0]];
        sq = em.spawnPatrol({ near: route[route.length - 1], start: { x: S.members[0].x, z: S.members[0].z }, route, size: n, mg });
        if (sq) {
          sq.members.forEach((s, i) => { const M = S.members[i]; if (M) s.motor.teleport(M.x, M.z, M.yaw); });
          sq.oneWay = S.oneWay; sq.convoy = S.convoy; sq.reinforce = S.reinforce; sq.paceMul = S.paceMul; sq.viaS = S.viaS; sq.passed = S.passed; sq.gone = S.gone;
          if (['engaged', 'alert', 'search', 'suspicious'].includes(S.state)) {
            const p = R.player;
            sq.contact = { x: p.x, y: 0, z: p.z, time: em.time, uncertainty: 18 };
            sq.threat = sq.contact;
            sq.setState('search');
          }
        }
      }
      if (!sq) continue;
      sq.directorKind = S.kind;
      if (S.convoy) d.ambush.convoy.push(sq);
      if (S.campSquad) d.campSquads.push(sq);
      d.spawned.push({ squad: sq, kind: S.kind });
    }
  }
}
