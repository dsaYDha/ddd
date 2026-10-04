// 전투 조정자 (순수 로직) — 사람 목록 · 탄도 · 제압 · 소음 · 통계를 묶는다.
//  사수(플레이어 Shooter, F7 가상 사수, 4단계 적)는 fire() 로 쏘고, 화면 효과·소리·UI 는 이 객체의 이벤트만 듣는다.
//  라우팅:
//   · 'nearPass'  → 그 사람의 suppression.addNearPass(거리)  (payload 에 gain 을 덧붙여 다시 보냄)
//   · 'impact'    → 착탄점 nearImpactRadius 안의 사람(사수 제외) suppression.addNearImpact + 착탄 소음
//   · 'partial'   → 착탄 소음 (대나무·덩굴을 맞히는 소리도 적이 듣는다)
//   · 'hit'       → 사수 명중 통계 + person.injuries.applyHit(e) (결과를 e.wound 에) + person.emit('hit', e)
//   · 'nearPass'  가 머리·몸통 표면 바깥 injury.grazeDepth 안 → person.injuries.applyNearGraze (결과를 e.graze 에)
//   Ballistics 이벤트('hit','impact','partial','foliage','nearPass','flyby','end')는 같은 이름·payload 로 다시 보낸다.
//  6단계 explode(point, opts): 함정 폭발 — 소음 · 거리별 제압 (Suppression.add 'blast') · 파편 (실제 투사체, projectile.fragment,
//   남은 속도 비율 traps.fragment.retained → 맞으면 3단계 저속 탄 규칙). 파편의 착탄·부분 관통은 소음을 내지 않는다 (폭음이 덮음).
//   'explosion' {point, kind, fragments, trap, victim} 을 보낸다.
//  게임 루프 순서: update(dt) 를 먼저(탄 이동·제압 감소) → 그다음 사수 갱신(발사). 발사된 탄은 fire 시점에
//  timeOffset 만큼 미리 진행해 이번 프레임 끝 위치에 있다.
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { Ballistics } from './Ballistics.js';
import { BulletWorld, createFlatWorld } from './BulletWorld.js';
import { People, Person } from './People.js';

/** [[x, y], …] 표 선형 보간 (첫 x 이하 = 첫 y, 마지막 x 초과 = 0) */
function tableLerp(table, x) {
  if (!table?.length || !(x >= 0)) return table?.[0]?.[1] ?? 0;
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
    }
  }
  return 0;
}

export class CombatSystem extends EventEmitter {
  /**
   * @param {import('../world/WorldQuery.js').WorldQuery|null} query
   * @param {import('../core/NoiseEvents.js').NoiseEvents|null} noise
   * @param {{ rng?: RNG, world?: object }} opts  world: BulletWorld 또는 createFlatWorld() (없으면 query 로 만듦)
   */
  constructor(query, noise, opts = {}) {
    super();
    this.query = query ?? null;
    this.noise = noise ?? null;
    this.rng = opts.rng ?? new RNG((Math.random() * 4294967296) >>> 0);
    this.world = opts.world ?? (this.query ? new BulletWorld(this.query) : createFlatWorld(0));
    this.people = new People();
    this.ballistics = new Ballistics(this.world, this.people, { rng: this.rng });
    this._stats = new Map();   // 사수 → { shots, hits }

    const B = this.ballistics;
    B.on('hit', (e) => this._onHit(e));
    B.on('impact', (e) => this._onImpact(e));
    B.on('partial', (e) => this._onPartial(e));
    B.on('nearPass', (e) => this._onNearPass(e));
    B.on('foliage', (e) => this.emit('foliage', e));
    B.on('flyby', (e) => this.emit('flyby', e));
    B.on('end', (e) => this.emit('end', e));
  }

  /** 사람 추가 (Person 생성자 옵션 또는 Person) */
  addPerson(opts) {
    const p = opts instanceof Person ? opts : new Person(opts);
    this.people.add(p);
    return p;
  }

  removePerson(p) {
    this.people.remove(p);
  }

  /**
   * 발사. 사수별 발사 수를 세고, 총성 소음을 내고, 'shot' 을 보낸 뒤 탄을 timeOffset 만큼 진행시킨다.
   * @param {object} shooter  Person 또는 {name, position} 같은 가상 사수
   * @param {{ origin, dir, speed?, weapon?, tracer?, collideWorldFrom?, noHit?, timeOffset? }} opts
   */
  fire(shooter, opts) {
    this._statsOf(shooter).shots++;
    const src = shooter?.noiseSource ?? shooter;
    if (this.noise) this.noise.emitNoise(opts.origin, CONFIG.noise.gunshot, 'gunshot', src, { shooter, family: opts.weapon?.family ?? null });
    return this.ballistics.fire({ ...opts, shooter }, (p) => {
      const s = p.speed || 1;
      this.emit('shot', { shooter, origin: { ...p.origin }, dir: { x: p.vel.x / s, y: p.vel.y / s, z: p.vel.z / s }, weapon: p.weapon, projectile: p });
    });
  }

  /**
   * 6단계: 폭발. opts: { fragments, speed: [lo, hi] m/s, elev: [lo, hi]° (지평 기준 고도각 — 사이를 입체각 균일하게),
   *   noHit: Set (파편이 맞지 않을 사람), kind, trap, source (소음 주체 — 걸린 사람 motor), victim }
   * @returns {{ fragments: number, point }}
   */
  explode(point, opts = {}) {
    const T = CONFIG.traps, B = T.blast;
    if (this.noise) this.noise.emitNoise(point, B.noise, 'explosion', opts.source ?? null, { blastKind: opts.kind ?? 'explosion', trap: opts.trap ?? null });
    // 거리별 제압 (몸 중심까지 거리)
    const list = this.people.list;
    for (let i = 0; i < list.length; i++) {
      const person = list[i];
      const sup = person.suppression;
      if (!sup || person.bounds.radius < 0) continue;
      const c = person.bounds.center;
      const d = Math.hypot(c.x - point.x, c.y - point.y, c.z - point.z);
      const gain = tableLerp(B.suppression, d);
      if (gain > 0) sup.add(gain, 'blast', { point: { ...point }, distance: d, kind: opts.kind });
    }
    // 파편
    const n = Math.max(0, Math.round(opts.fragments ?? 0));
    const w = CONFIG.weapons.fragment;
    const sp = opts.speed ?? [600, 1000], el = opts.elev ?? [-5, 40];
    const s0 = Math.sin(el[0] * Math.PI / 180), s1 = Math.sin(el[1] * Math.PI / 180);
    const shooter = { name: '파편', isTrap: true, position: { x: point.x, y: point.y, z: point.z }, trap: opts.trap ?? null };
    const origin = { x: point.x, y: point.y, z: point.z };
    for (let i = 0; i < n; i++) {
      const az = this.rng.range(0, Math.PI * 2);
      const sy = this.rng.range(s0, s1), ch = Math.sqrt(Math.max(0, 1 - sy * sy));
      const p = this.ballistics.fire({ origin, dir: { x: ch * Math.cos(az), y: sy, z: ch * Math.sin(az) }, speed: this.rng.range(sp[0], sp[1]), shooter, weapon: w, noHit: opts.noHit ?? null });
      p.fragment = true;
      p.retained = T.fragment.retained;
    }
    const e = { point: { ...point }, kind: opts.kind ?? 'explosion', fragments: n, trap: opts.trap ?? null, victim: opts.victim ?? null, shooter };
    this.emit('explosion', e);
    return e;
  }

  /** 자세 갱신 → 탄 이동 → 제압 감소 */
  update(dt) {
    this.people.refresh();
    this.ballistics.update(dt);
    const list = this.people.list;
    for (let i = 0; i < list.length; i++) list[i].suppression?.update(dt);
  }

  /** 사수 통계 { shots, hits } — hits = 이 사수의 탄이 다른 사람을 맞힌 수 */
  stats(person) {
    return this._statsOf(person);
  }

  /** 탄·통계 초기화 (사람은 그대로) */
  reset() {
    this.ballistics.clear();
    this._stats.clear();
  }

  // ---------------------------------------------------------------
  _statsOf(shooter) {
    let s = this._stats.get(shooter);
    if (!s) { s = { shots: 0, hits: 0 }; this._stats.set(shooter, s); }
    return s;
  }

  _onHit(e) {
    if (e.person !== e.shooter) this._statsOf(e.shooter).hits++;
    const inj = e.person.injuries;
    e.wound = inj ? inj.applyHit(e) : null;
    e.person.emit('hit', e);
    this.emit('hit', e);
  }

  _onNearPass(e) {
    const sup = e.person.suppression;
    // 4단계: 무기별 제압 배율 (경기관총·양각대 거치 사격은 더 강하게)
    const w = e.projectile?.weapon;
    let mul = (w?.suppressionMul ?? 1) * (e.projectile?.bipod ? (w?.bipodSuppressionMul ?? 1) : 1);
    // 같은 편 탄 (뒤에서 동료가 쏨)은 덜 무섭다
    if (e.person.faction && e.person.faction === e.shooter?.faction) mul *= 0.25;
    e.gain = sup ? sup.addNearPass(e.distance, e, mul) : 0;
    const inj = e.person.injuries;
    e.graze = inj && e.distance <= CONFIG.injury.grazeDepth ? inj.applyNearGraze(e) : null;
    this.emit('nearPass', e);
  }

  _onImpact(e) {
    // 물속 바닥 착탄은 보이지도 들리지도 않음 (수면 물보라가 이미 'impact') · 6단계: 파편 착탄은 폭음이 덮음 (제압·소음 없음)
    if (!e.underwater && !e.projectile?.fragment) {
      const B = CONFIG.ballistics;
      const near = this.people.within(e.point, B.nearImpactRadius);
      for (let i = 0; i < near.length; i++) {
        const { person, distance } = near[i];
        if (person === e.shooter || !person.suppression) continue;
        person.suppression.addNearImpact(distance, e);
      }
      this._impactNoise(e);
    }
    this.emit('impact', e);
  }

  _onPartial(e) {
    if (!e.projectile?.fragment) this._impactNoise(e);
    this.emit('partial', e);
  }

  _impactNoise(e) {
    if (!this.noise) return;
    const src = e.shooter?.noiseSource ?? e.shooter;
    this.noise.emitNoise(e.point, CONFIG.noise.impact, 'impact', src, { material: e.material, shooter: e.shooter });
  }
}
