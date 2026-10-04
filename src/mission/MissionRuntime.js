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
//   · 6단계: 함정 (임무 계획 m.traps → Game.traps, 적 길찾기에 자기 편 지뢰·구덩이 자리), 달 모양, 밤 임무면 손전등 빛을 장면에.
//   · 7단계: 분대 모드 — 분대원 생성 (def.squad 명단, 플레이어 뒤 일렬), 지원 화력·보급 (Game.support) 무전, 적 박격포 (디렉터 →
//     support.enemyBarrage), 헬기 소리에 근처 적이 몰려옴, 결과: 아군 사상자(이름별)·오인 사격·지원 화력·보급.
//     체크포인트는 살아 있던 분대원 자리·부상·탄을 되돌림 (전사자는 전사로 남음).
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
import { FriendSquad } from '../ai/FriendSquad.js';

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

  generate(type, seed, opts = {}) { return generateMission(type, seed, this.world, opts); }

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
    // 6단계: 함정 · 달 · 밤 손전등 빛
    g.traps.load(def.traps ?? []);
    if (R?.traps) g.traps.restore(R.traps);
    g.nav.setHazards(g.traps.hazards('enemy'));
    g.atmosphere.setMoon(def.moon ?? 'half');
    g.enemies.moon = def.moon ?? 'half';
    g.nightFX.setLightActive(def.tod === 'night' || def.tod === 'dusk');
    // 7단계: 분대 · 지원 화력
    g.enemies.traps = g.traps;
    g.support?.reset();
    this.squadMode = def.mode === 'squad' && !!def.squad;
    this._kia = R?.kia ? R.kia.slice() : [];
    this._ff = { incidents: 0, hits: 0, list: [], last: new Map() };
    this._supply = R?.supply ? { ...R.supply } : { ammoThrown: 0, looted: 0, crate: 0, radioTaken: false };
    if (this.squadMode) {
      const roster = R?.allies ? def.squad.filter((r) => R.allies.some((a) => a.name === r.name)) : def.squad;
      const sq = FriendSquad.spawn(g.enemies, roster, { seed: def.seed, at: g.motor.position, yaw: g.motor.yaw });
      if (R?.allies) this._restoreAllies(sq, R.allies);
    }
    g.onSquadSpawned?.();
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
    this.g.enemies?.friendSquad?.dispose?.();
    this.g.traps?.clear();
    this.g.nav?.setHazards([]);
    this.g.fieldAudio?.stopAll();
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
      // 7단계: 오인 사격 (아군 → 아군·플레이어, 플레이어 → 아군, 우리 편 포탄 → 아군·플레이어)
      this._friendlyFire(e);
      if (e.shooter !== g.playerPerson) return;
      const s = em.soldierOf(e.person);
      if (s && s.faction !== 'friend') s.hitByPlayer = true;
    });
    // 7단계: 적 박격포 (디렉터) · 지원 화력 무전 · 헬기 소리에 몰려오는 적
    on(d, 'enemyMortar', (e) => { g.support?.enemyBarrage(e.from, e.target); });
    if (g.support) {
      on(g.support, 'radio', (e) => this.radio(e.text, e.kind === 'deny' || e.kind === 'danger' ? 'intel' : 'progress'));
      on(g.support, 'heli', (e) => {
        if (e.state === 'approach') g.enemies.attractTo(e.point, CONFIG.supply.heli.attract);
      });
    }
    on(em, 'fall', (e) => { if (e.soldier.hitByPlayer) e.soldier.seenFall = e.soldier.seenFall || this._canSee(e.soldier); });
    on(em, 'death', (e) => {
      const s = e.soldier;
      if (!s.hitByPlayer || this._kills.has(s)) return;
      this._kills.add(s);
      if (s.seenFall || this._canSee(s)) this._stats.confirmed++; else this._stats.estimated++;
    });
  }

  /** 7단계: 오인 사격 집계 — 같은 사수·피해자의 연발(3초 안)은 한 번 */
  _friendlyFire(e) {
    if (!this.squadMode) return;
    const g = this.g, sh = e.shooter;
    if (!sh || sh === e.person) return;
    const vAlly = g.enemies.soldierOf(e.person);
    const victimFriendly = e.person === g.playerPerson || vAlly?.faction === 'friend';
    if (!victimFriendly) return;
    const sAlly = g.enemies.soldierOf(sh);
    const shooterFriendly = sh === g.playerPerson || sAlly?.faction === 'friend' || (sh.isShell && sh.faction === 'friend');
    if (!shooterFriendly) return;
    this._ff.hits++;
    const key = `${sh.name ?? '?'}>${e.person.name ?? '?'}`;
    const now = g.enemies.time;
    if (now - (this._ff.last.get(key) ?? -Infinity) > 3) {
      this._ff.incidents++;
      const who = sh === g.playerPerson ? '플레이어' : sAlly ? sAlly.name : sh.name;
      const whom = e.person === g.playerPerson ? '플레이어' : vAlly?.name ?? e.person.name;
      this._ff.list.push(`${who} → ${whom}`);
      g.onFriendlyFire?.({ shooter: who, victim: whom, wound: e.wound });
    }
    this._ff.last.set(key, now);
  }

  /** 보급 기록 (Game 이 부름): 'ammoThrown' | 'looted' | 'crate' | 'radioTaken' */
  noteSupply(kind) {
    if (!this._supply) return;
    if (kind === 'radioTaken') this._supply.radioTaken = true; else this._supply[kind] = (this._supply[kind] ?? 0) + 1;
  }

  /** 체크포인트: 분대원 자리·부상·탄·의무병 물자 */
  _restoreAllies(sq, list) {
    for (const a of sq.members) {
      const S = list.find((x) => x.name === a.name);
      if (!S) continue;
      a.motor.teleport(S.x, S.z, S.yaw);
      a.injuries.restore(S.injuries);
      a.injuries.apply(a.motor, a.shooter);
      if (S.weapon) a.shooter.weapon.restore(S.weapon);
      if (S.medKit && a.medKit) Object.assign(a.medKit, S.medKit);
      a.hasRadio = !!S.hasRadio;
    }
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
    s.enemyWounded = g.enemies.soldiers.filter((x) => x.hitByPlayer && x.alive && x.faction !== 'friend').length;
    // 7단계
    s.mode = this.squadMode ? 'squad' : 'solo';
    if (this.squadMode) {
      const T = CONFIG.allies.roleLabels;
      const list = g.enemies.friends.map((a) => {
        const w = a.injuries.wounds;
        const status = !a.alive ? '전사' : !w.length ? '무사' : w.some((x) => x.type !== 'graze') ? '부상' : '경상';
        return { name: a.name, role: T[a.job] ?? a.job, status, wounds: w.map((x) => `${x.label}${x.type === 'graze' ? ' (스침)' : x.arterial ? ' (동맥)' : ''}`), friendlyHits: a.friendlyHits };
      });
      for (const k of this._kia) if (!list.some((x) => x.name === k.name)) list.push({ name: k.name, role: T[k.job] ?? k.job, status: '전사', wounds: [], friendlyHits: 0 });
      s.squad = list;
      s.friendlyFire = { incidents: this._ff.incidents, hits: this._ff.hits, list: this._ff.list.slice(0, 8) };
      s.support = g.support ? g.support.summary() : null;
      const fl = g.enemies.friendSquad?.log;
      s.supply = { ammoThrown: this._supply.ammoThrown, looted: this._supply.looted, crate: this._supply.crate, radioTaken: this._supply.radioTaken, trapHalts: fl?.trapHalts ?? 0, reports: fl?.reports ?? 0, orders: fl?.orders ?? 0 };
    } else { s.squad = null; s.friendlyFire = null; s.support = null; s.supply = null; }
    s.weapon = g.shooter.weapon.data.label ?? '';
    const T = g.traps;
    s.traps = { known: T.stats.known, triggered: T.stats.triggered - T.stats.byEnemy, disarmed: T.list.filter((t) => t.state === 'disarmed').length };
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
      traps: g.traps.snapshot(),
      // 7단계: 분대원 (살아 있던 사람만 되살림) · 전사자 · 보급 기록
      allies: this.squadMode ? g.enemies.friends.filter((a) => a.alive).map((a) => ({
        name: a.name, x: a.motor.position.x, z: a.motor.position.z, yaw: a.motor.yaw, injuries: a.injuries.snapshot(),
        weapon: a.shooter.weapon.snapshot(), medKit: a.medKit ? { ...a.medKit } : null, hasRadio: a.hasRadio,
      })) : null,
      kia: this.squadMode ? g.enemies.friends.filter((a) => !a.alive).map((a) => ({ name: a.name, job: a.job })).concat(this._kia) : [],
      supply: { ...this._supply },
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
