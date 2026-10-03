// 전투에 참여하는 '사람' (플레이어·F8 표적·4단계 적 병사) — 순수 로직.
//  Person: 자세를 알려주는 getPose() 하나만 있으면 된다. refresh() 때 부위별 캡슐(Hitboxes)과 경계 구를 다시 만든다.
//  제압(Suppression)은 사람마다 하나씩 붙는 공용 컴포넌트 — 플레이어와 적이 같은 규칙으로 겁을 먹는다.
//  People: 목록 + 근처 사람 찾기 (근처 착탄 제압 판정용: 거리 = 머리·몸통 캡슐 '표면'까지).
import { EventEmitter } from '../core/EventEmitter.js';
import { buildHitboxes, hitboxBounds } from './Hitboxes.js';
import { Suppression } from './Suppression.js';

let nextId = 1;

export class Person extends EventEmitter {
  /**
   * @param {{ name?: string, isPlayer?: boolean, getPose: () => object|null, suppression?: Suppression|null,
   *           noiseSource?: object, data?: object }} opts
   *  getPose: Hitboxes 의 pose ({x,y,z,yaw,stance,stanceFrom,stanceProgress,lean,arms,...}) — null 이면 판정 없음
   *  suppression: 생략하면 new Suppression(this), null 이면 제압 없음
   *  noiseSource: 소음 이벤트의 발생 주체 (플레이어는 HumanMotor) — 없으면 Person 자신
   */
  constructor({ name, isPlayer = false, getPose, suppression, noiseSource = null, data = {} } = {}) {
    super();
    this.id = nextId++;
    this.name = name ?? `사람${this.id}`;
    this.isPlayer = isPlayer;
    this.getPose = getPose;
    this.suppression = suppression === undefined ? new Suppression(this) : suppression;
    this.noiseSource = noiseSource;
    this.data = data;
    this.hitboxes = [];
    this.bounds = { center: { x: 0, y: 0, z: 0 }, radius: -1 };
    this.pose = null;
    this._pos = { x: 0, y: 0, z: 0 };
    if (getPose) this.refresh();
  }

  /** 현재 자세로 캡슐·경계 구 갱신 (CombatSystem.update 가 매 프레임 탄도 계산 전에 부름) */
  refresh() {
    const pose = this.getPose ? this.getPose() : null;
    this.pose = pose;
    if (!pose) {
      this.hitboxes.length = 0;
      this.bounds.radius = -1;   // 판정에서 빠짐
      return;
    }
    buildHitboxes(pose, this.hitboxes);
    hitboxBounds(this.hitboxes, this.bounds);
    this._pos.x = pose.x; this._pos.y = pose.y; this._pos.z = pose.z;
  }

  /** 발 위치 (마지막 refresh 기준) */
  get position() { return this._pos; }
  /** 월드 눈 위치 (마지막 refresh 기준, 없으면 null) */
  get eye() { return this.pose ? this.hitboxes.eye : null; }
  /** 가슴 상부 중심 (조준·시야 판정용) */
  get chest() { return this.pose ? this.hitboxes.chest : null; }
}

export class People {
  constructor() {
    this.list = [];
  }

  add(p) {
    if (!this.list.includes(p)) this.list.push(p);
    return p;
  }

  remove(p) {
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
  }

  refresh() {
    for (let i = 0; i < this.list.length; i++) this.list[i].refresh();
  }

  /**
   * 점에서 r 안에 있는 사람들. distance = 머리·몸통(NEAR_PARTS) 캡슐 표면까지 최단 거리 (안이면 0).
   * @returns {Array<{person: Person, distance: number}>} 가까운 순
   */
  within(point, r) {
    const out = [];
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i];
      const d = nearDistance(p, point, r);
      if (d <= r) out.push({ person: p, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }
}

/** 사람의 머리·몸통 캡슐 표면까지 거리 (경계 구로 먼저 걸러 limit 보다 멀면 Infinity) */
export function nearDistance(person, point, limit = Infinity) {
  const b = person.bounds;
  if (b.radius < 0) return Infinity;
  const c = b.center;
  const dc = Math.hypot(point.x - c.x, point.y - c.y, point.z - c.z);
  if (dc - b.radius > limit) return Infinity;
  let best = Infinity;
  const caps = person.hitboxes;
  for (let k = 0; k < caps.length; k++) {
    const cap = caps[k];
    if (!cap.near) continue;
    const { a, b: q } = cap;
    const abx = q.x - a.x, aby = q.y - a.y, abz = q.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 0 ? ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(a.x + abx * t - point.x, a.y + aby * t - point.y, a.z + abz * t - point.z) - cap.r;
    if (d < best) best = d;
  }
  return best < 0 ? 0 : best;
}
