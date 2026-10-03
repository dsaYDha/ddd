// 전투 조정자 (순수 로직) — 사람 목록 · 탄도 · 제압 · 소음 · 통계를 묶는다.
//  사수(플레이어 Shooter, F7 가상 사수, 4단계 적)는 fire() 로 쏘고, 화면 효과·소리·UI 는 이 객체의 이벤트만 듣는다.
//  라우팅:
//   · 'nearPass'  → 그 사람의 suppression.addNearPass(거리)  (payload 에 gain 을 덧붙여 다시 보냄)
//   · 'impact'    → 착탄점 nearImpactRadius 안의 사람(사수 제외) suppression.addNearImpact + 착탄 소음
//   · 'partial'   → 착탄 소음 (대나무·덩굴을 맞히는 소리도 적이 듣는다)
//   · 'hit'       → 사수 명중 통계 + person.emit('hit', e)
//   Ballistics 이벤트('hit','impact','partial','foliage','nearPass','flyby','end')는 같은 이름·payload 로 다시 보낸다.
//  게임 루프 순서: update(dt) 를 먼저(탄 이동·제압 감소) → 그다음 사수 갱신(발사). 발사된 탄은 fire 시점에
//  timeOffset 만큼 미리 진행해 이번 프레임 끝 위치에 있다.
import { CONFIG } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { Ballistics } from './Ballistics.js';
import { BulletWorld, createFlatWorld } from './BulletWorld.js';
import { People, Person } from './People.js';

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
    if (this.noise) this.noise.emitNoise(opts.origin, CONFIG.noise.gunshot, 'gunshot', src, { shooter });
    return this.ballistics.fire({ ...opts, shooter }, (p) => {
      const s = p.speed || 1;
      this.emit('shot', { shooter, origin: { ...p.origin }, dir: { x: p.vel.x / s, y: p.vel.y / s, z: p.vel.z / s }, weapon: p.weapon, projectile: p });
    });
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
    e.person.emit('hit', e);
    this.emit('hit', e);
  }

  _onNearPass(e) {
    const sup = e.person.suppression;
    e.gain = sup ? sup.addNearPass(e.distance, e) : 0;
    this.emit('nearPass', e);
  }

  _onImpact(e) {
    // 물속 바닥 착탄은 보이지도 들리지도 않음 (수면 물보라가 이미 'impact')
    if (!e.underwater) {
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
    this._impactNoise(e);
    this.emit('partial', e);
  }

  _impactNoise(e) {
    if (!this.noise) return;
    const src = e.shooter?.noiseSource ?? e.shooter;
    this.noise.emitNoise(e.point, CONFIG.noise.impact, 'impact', src, { material: e.material, shooter: e.shooter });
  }
}
