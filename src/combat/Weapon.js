// =====================================================================
//  Weapon — 총 한 자루의 상태 (순수 로직: three.js·DOM 없음 → Node 헤드리스 시뮬에서도 그대로)
//  탄창마다 남은 탄 수를 따로 관리 (쓰다 만 탄창도 버리지 않고 다시 사용), 약실, 단발/연발,
//  전술·빈 상태 재장전, 탄창 확인(T), 기능 고장(오염도 비례)과 해결(R), 무게(탄을 쓰면 가벼워짐).
//  모든 수치는 무기 데이터(CONFIG.weapons.<키>)에서 호출 시점에 읽는다 → 무기 추가 = config 항목 하나.
//  플레이어 전용이 아니다 — 4단계 적 병사도 Shooter 를 통해 같은 클래스를 쓴다.
//
//  입력:  update(dt, { trigger, triggerPressed, reload, mode, magCheck, canFire })
//         trigger = 누르고 있음, 나머지는 이번 프레임에 눌림(모서리). triggerPressed 가 없으면 trigger 변화로 판단.
//  외부 (3단계 팔 부상 — 사람 상태가 정함, reset 해도 유지): actionTimeMul (재장전·탄창 확인·고장 해결 시간 배율),
//         fireDelay (방아쇠를 누른 뒤 발사까지 s — 누를 때 한 번 예약, 놓아도 나감), setAutoBlocked(on) (연발 불가 → 단발)
//  읽기:  mode, chambered, malfunctioned, fouling, mags[{rounds}], magIndex, magRounds, totalRounds, state, busy,
//         action {kind, t, duration, timeline} (화면 모델 애니메이션), burstIndex, shotsFired, lastShotTime, weightKg
//  이벤트: 'shot' {burstIndex, timeOffset, mode, tracer, shotIndex, time}
//          'dryFire' {reason: 'empty'|'malfunction', timeOffset}   'malfunction' {timeOffset, fouling, chance}
//          'noMags' {reason: 'full'|'none'}
//          'reloadStart' {kind, duration}  'magOut' {rounds}  'magIn' {rounds}
//          'boltPull' {kind}  'boltRelease' {kind, chambered}  'reloadEnd' {magRounds, chambered}
//          'magCheckStart' {duration}  'magCheckResult' {label, fraction}
//          'clearStart' {duration}  'clearEnd' {chambered}
//          'modeChange' {mode}  'stateChange' {state, prev}
//          'noise' {kind: 'weaponMech'|'dryFire', radius, cause} — 기계음 소음 (위치는 받는 쪽이 붙여 NoiseEvents 로)
//          (boltPull/boltRelease 의 kind: 'reloadEmpty' = 재장전 중, 'clear' = 고장 해결 중 → 소리를 고를 때 구분)
//
//  시간 규칙 — update(dt)는 방금 지난 구간 (T-dt, T] 를 처리한다.
//   · 진행 중인 동작의 단계와 연발 사이클은 구간 안의 정확한 시각에 일어난다 → 프레임레이트와 무관.
//   · 이번 입력 표본의 누름은 구간 끝 T 에 적용 → 누른 순간의 첫 발은 timeOffset 0.
//     동작이 구간 중간에 끝났으면 누름은 그 뒤로 본다 (장전이 끝나자마자 누른 클릭을 삼키지 않게).
//   · 'shot'.timeOffset = 그 발이 나간 시각 ~ 구간 끝 (s). 탄도는 그만큼 탄을 미리 전진시킨다.
//
//  경계 상황
//   · 동작 중(busy)이거나 canFire=false 면 방아쇠는 아무 일도 안 한다 (발사도 '딸깍'도 없음). 그때 쥐고 있던
//     방아쇠는 놓았다 다시 눌러야 한다 (단발·연발 모두) — 재장전·달리기가 끝나는 순간 저절로 총이 나가지 않게.
//   · 단발: 누를 때마다 1발. 노리쇠가 아직 돌아오는 중(60/rpm 이내)에 누르면 닫히는 순간 발사 (그때도 쥐고 있으면).
//   · 연발: 누르는 순간 1발, 쥐고 있는 동안 60/rpm 초마다 (시간 누적 — 긴 프레임엔 여러 발, 각자 timeOffset).
//     사격 모드를 바꾸면 연사는 멈추고, 연발로 바꿔도 새로 눌러야 연사가 시작된다.
//   · 빈 약실: 누를 때마다 'dryFire' {reason:'empty'} 한 번 (연발로 쥐고 있었으면 다음 사이클 시각에 한 번만).
//   · 기능 고장: 그 발은 나가지 않고 'malfunction' + 'dryFire'. 이후 누를 때마다 'dryFire' {reason:'malfunction'}.
//     R = 고장 해결 (재장전보다 우선, reload.clear 초): 노리쇠를 당기는 순간 불발탄이 버려지고(무게도 빠짐)
//     고장 표시가 풀리며, 놓을 때 다음 탄이 약실로. malfunctioned 이면 약실의 탄은 항상 불발탄이다.
//   · R: 끼운 탄창보다 탄이 '더 많은' 탄창 중 가장 많은 것 (같으면 앞 번호). 없으면 'noMags'
//     (끼운 탄창이 가득이면 reason 'full', 아니면 'none'). 약실이 비었고 더 나은 탄창은 없지만
//     끼운 탄창에 탄이 있으면 노리쇠만 당긴다 ('clear' 동작) — 정상 흐름에선 생기지 않는 상태의 안전장치.
//   · R·T 는 준비(ready) 상태에서만 → 재장전·탄창 확인·고장 해결 중 R/T 는 무시.
//     B 는 재장전·탄창 확인 중에도 되고, 고장 해결 중(손이 장전 손잡이에 있음)에만 무시.
//   · 한 프레임에 여러 키: B → R → T → 방아쇠 순서 (R 과 클릭이 같이 오면 재장전이 이기고 클릭은 막힌다).
//   · 시작 상태: 탄창을 모두 채우고 첫 탄창을 끼워 노리쇠를 당긴 상태 (탄창 29 + 약실 1, 휴대 탄 = 탄창 수 × 용량).
// =====================================================================
import { CONFIG, SURFACE_KEYS } from '../config.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { RNG } from '../core/rng.js';
import { clamp } from '../core/math.js';

const NO_INPUT = Object.freeze({});
const DEFAULT_MODES = Object.freeze(['semi']);
// 부동소수 오차 허용 (s) — 발사 예정 시각이 프레임 끝과 정확히 겹칠 때 다음 프레임으로 밀리지 않게
const EPS = 1e-9;

// 동작 종류: 상태, 시간 키(data.reload.*), 진행표 키, 진행 단계 (논리 순서 — 탄창을 빼야 끼울 수 있다)
const ACTIONS = Object.freeze({
  reloadTactical: { state: 'reloading', time: 'tactical', timeline: 'tacticalTimeline', steps: ['magOut', 'magIn'] },
  reloadEmpty: { state: 'reloading', time: 'empty', timeline: 'emptyTimeline', steps: ['magOut', 'magIn', 'boltPull', 'boltRelease'] },
  magCheck: { state: 'magCheck', time: 'magCheck', timeline: null, steps: [] },
  clear: { state: 'clearing', time: 'clear', timeline: 'clearTimeline', steps: ['boltPull', 'boltRelease'] },
});

// 한 발 시도 결과
const SHOT = 1, EMPTY = 2, JAM = 3;

export class Weapon extends EventEmitter {
  /**
   * @param {object} data  무기 데이터 (CONFIG.weapons.rifle762 형식)
   * @param {{rng?: RNG}} opts  헤드리스 시뮬은 시드 RNG 를 넘긴다. 없으면 실행마다 다른 시드 (고장 시점이 매번 같지 않게)
   */
  constructor(data = CONFIG.weapons[CONFIG.weapons.default], opts = {}) {
    super();
    this.data = data;
    this.rng = opts.rng || new RNG((Math.random() * 0x100000000) >>> 0);
    this.mags = [];
    this.state = 'ready';
    this.action = null;
    this.actionTimeMul = 1;
    this.fireDelay = 0;
    this.autoBlocked = false;
    this.reset();
  }

  // -----------------------------------------------------------------
  // 읽기
  // -----------------------------------------------------------------
  get busy() { return this.state !== 'ready'; }

  /** 끼운 탄창의 탄 수 (끼운 탄창이 없으면 0) */
  get magRounds() { return this.magIndex >= 0 ? this.mags[this.magIndex].rounds : 0; }

  /** 약실 + 모든 탄창 */
  get totalRounds() {
    let n = this.chambered ? 1 : 0;
    for (const m of this.mags) n += m.rounds;
    return n;
  }

  /** 총 + 휴대 탄창 전부(빈 탄창 무게 + 남은 탄) + 약실의 탄 — 1단계 장비 무게에 더한다 */
  get weightKg() {
    const D = this.data;
    const roundKg = D.roundKg || 0, magKg = D.magEmptyKg || 0;
    let kg = D.weightKg || 0;
    for (const m of this.mags) kg += magKg + m.rounds * roundKg;
    if (this.chambered) kg += roundKg;
    return kg;
  }

  /** 지금 오염도에서 발당 기능 고장 확률 */
  get malfunctionChance() {
    const M = this.data.malfunction;
    if (!M) return 0;
    return M.perShot * (1 + (M.foulingMaxMul - 1) * this.fouling / 100);
  }

  /** 노리쇠 한 사이클 (s) = 연사 간격 */
  get cycleTime() { return 60 / this.data.rpm; }

  /** 탄창 확인 표시 (숫자 없음): 남은 비율이 표의 기준 이상인 첫 항목 */
  static magCheckLabel(fraction, labels = CONFIG.weapons.magCheckLabels) {
    for (const [min, label] of labels) if (fraction >= min - 1e-9) return label;
    return labels[labels.length - 1][1];
  }

  // -----------------------------------------------------------------
  // 갱신
  // -----------------------------------------------------------------
  update(dt, input = NO_INPUT) {
    dt = dt > 0 ? dt : 0;
    const held = !!input.trigger;
    const pressed = !!input.triggerPressed || (held && !this._held);
    const canFire = input.canFire !== false;
    const t0 = this.time;
    this.time = t0 + dt;

    // 1) 진행 중인 동작 (재장전·탄창 확인·고장 해결) — 단계 이벤트를 시각 순서대로
    const wasReady = this.state === 'ready';
    if (!wasReady) this._advanceAction(dt);

    // 2) 구간 안의 연발·대기 발사: 이전 표본과 지금 모두 쥐고 있고 새 누름이 없을 때만 (구간 내내 쥐고 있었다고 본다)
    if (wasReady && (this._armed || this._pending) && held && this._held && !pressed && canFire && !this.malfunctioned) {
      this._fireWithin(t0);
    }
    // 2b) 지연 발사 (부상으로 방아쇠가 굼뜸): 누를 때 예약한 시각이 이 구간 안이면 발사. 막히면 취소
    if (this._delayAt !== null) {
      if (!wasReady || !canFire || this.malfunctioned) this._delayAt = null;
      else if (this._delayAt <= this.time + EPS) {
        const ts = this._delayAt > t0 ? this._delayAt : t0;
        this._delayAt = null;
        this._attempt(ts);
      }
    }

    // 3) 이번 표본의 입력 모서리 — 구간 끝에 적용
    if (input.mode) this._onModeKey();
    if (input.reload) this._onReloadKey();
    if (input.magCheck) this._onMagCheckKey();
    this._onTrigger(held, pressed, canFire);
  }

  /** 연발 불가 (방아쇠 팔 부상) — 켜지면 연발이던 모드를 단발로 */
  setAutoBlocked(on) {
    on = !!on;
    if (on === this.autoBlocked) return;
    this.autoBlocked = on;
    if (on && this.mode === 'auto') {
      const m = this._modes();
      this.setMode(m.includes('semi') ? 'semi' : m[0]);
    }
  }

  /** 사격 모드 직접 지정 (AI·디버그용 — B 키와 달리 상태를 가리지 않는다). 바뀌면 true */
  setMode(mode) {
    if (mode === this.mode || !this._modes().includes(mode)) return false;
    this.mode = mode;
    // 연발 중 단발로 바꾸면 그 자리에서 멈추고, 단발 → 연발도 새로 눌러야 연사 (쥔 채로 갑자기 연사되지 않게)
    this._armed = false;
    this._pending = false;
    this.emit('modeChange', { mode });
    return true;
  }

  // -----------------------------------------------------------------
  // 5단계: 낱발로 탄창 채우기 · 무기 바꿔 들기 (상태 옮기기)
  // -----------------------------------------------------------------
  /** 채울 예비 탄창: 끼우지 않은 탄창 중 덜 찬 것 가운데 가장 적게 남은 것 (같으면 앞 번호). 없으면 -1 */
  refillIndex() {
    const cap = this.data.magCapacity | 0;
    let best = -1, bestN = Infinity;
    for (let i = 0; i < this.mags.length; i++) {
      if (i === this.magIndex) continue;
      const n = this.mags[i].rounds;
      if (n < cap && n < bestN) { best = i; bestN = n; }
    }
    return best;
  }

  /** 탄창 i 에 한 발 (가득이면 false) */
  addRound(i) {
    const m = this.mags[i];
    if (!m || m.rounds >= (this.data.magCapacity | 0)) return false;
    m.rounds++;
    return true;
  }

  /** 들고 있던 상태 (줍기·내려놓기로 옮길 때) */
  snapshot() {
    return {
      mags: this.mags.map((m) => m.rounds), magIndex: this.magIndex, chambered: this.chambered,
      mode: this.mode, fouling: this.fouling, malfunctioned: this.malfunctioned,
    };
  }

  /** snapshot 상태로 (동작 중이던 것은 취소, 준비 상태) */
  restore(st) {
    if (!st) { this.reset(); return; }
    const cap = this.data.magCapacity | 0;
    this.mags.length = 0;
    for (const r of st.mags) this.mags.push({ rounds: Math.max(0, Math.min(cap, r | 0)) });
    this.magIndex = st.magIndex >= 0 && st.magIndex < this.mags.length ? st.magIndex : (this.mags.length ? 0 : -1);
    this.chambered = !!st.chambered;
    this.mode = this._modes().includes(st.mode) ? st.mode : this._modes()[0];
    this.fouling = clamp(st.fouling ?? 0, 0, 100);
    this.malfunctioned = !!st.malfunctioned && this.chambered;
    this._held = false; this._armed = false; this._pending = false; this._delayAt = null;
    this.action = null;
    this._setState('ready');
  }

  addFouling(amount) {
    this.fouling = clamp(this.fouling + (amount || 0), 0, 100);
    return this.fouling;
  }

  /**
   * 몸 상태에 따른 오염도 증가 속도 (/s) — 진흙에서 포복하거나 총이 물에 잠기면 오른다.
   * env: { stance, surface (지면 키 문자열 또는 지면 ID), moving (기어가는 중), waterDepth (m), submerged? (직접 지정) }
   */
  foulingRate(env = {}) {
    const F = this.data.fouling || CONFIG.weapons.fouling;
    if (!F) return 0;
    const surface = typeof env.surface === 'number' ? SURFACE_KEYS[env.surface] : env.surface;
    let rate = 0;
    if (env.stance === 'prone') {
      // 기어갈 때 전부, 엎드려 가만히 있을 때는 일부 (총이 바닥에 닿아 있긴 하다)
      const k = env.moving ? 1 : (F.proneStillMul ?? 0);
      if (F.mudSurfaces && F.mudSurfaces.includes(surface)) rate += F.proneMud * k;
      else if (F.wetSurfaces && F.wetSurfaces.includes(surface)) rate += F.proneWet * k;
    }
    const gunH = F.gunHeight ? F.gunHeight[env.stance] : undefined;
    const submerged = env.submerged ?? (gunH !== undefined && (env.waterDepth || 0) > gunH);
    if (submerged) rate += F.submerged;
    return rate;
  }

  /** foulingRate 를 dt 만큼 적용. 반환: 이번 증가 속도 (/s) */
  updateFouling(dt, env) {
    const rate = this.foulingRate(env);
    if (rate > 0 && dt > 0) this.addFouling(rate * dt);
    return rate;
  }

  /** 처음 상태로 (모든 탄창 가득, 첫 탄창 장전 + 약실 1발, 고장·오염 없음) */
  reset() {
    const D = this.data;
    const n = Math.max(0, D.magsCarried | 0), cap = Math.max(0, D.magCapacity | 0);
    // 탄창 객체는 재사용 — 밖에서 참조를 쥐고 있어도 끊기지 않게
    for (let i = 0; i < n; i++) {
      if (!this.mags[i]) this.mags[i] = { rounds: 0 };
      this.mags[i].rounds = cap;
    }
    this.mags.length = n;
    this.magIndex = n > 0 ? 0 : -1;
    this.chambered = false;
    this._chamberFromMag();
    this.mode = this._modes()[0];
    this.malfunctioned = false;
    this.malfunctions = 0;
    this.fouling = 0;
    this.burstIndex = 0;
    this.shotsFired = 0;
    this.time = 0;                    // 무기 자체 시계 (s)
    this.lastShotTime = -Infinity;
    this._held = false;               // 직전 표본에서 방아쇠를 쥐고 있었나
    this._armed = false;              // 연발: 쥐고 있는 동안 다음 사이클마다 발사
    this._pending = false;            // 노리쇠가 닫히길 기다리는 누름
    this._delayAt = null;             // 지연 발사 예약 시각 (fireDelay)
    this._nextMag = -1;               // 재장전 중 끼울 탄창
    this._steps = [];
    this._stepIndex = 0;
    this.action = null;
    this._setState('ready');
  }

  // -----------------------------------------------------------------
  // 방아쇠
  // -----------------------------------------------------------------
  _onTrigger(held, pressed, canFire) {
    const blocked = this.state !== 'ready' || !canFire;
    if (pressed) {
      // 새 누름 = 그 사이에 한 번 놓았다는 뜻 → 이전 연사·대기 발사는 끝, 연발 순번도 새로
      this.burstIndex = 0;
      this._armed = false;
      this._pending = false;
      if (!blocked) {
        if (this.malfunctioned) {
          this._dryFire('malfunction', 0);
        } else if (this.fireDelay > 0) {
          // 부상으로 굼뜬 방아쇠: 한 발만, fireDelay 뒤 (노리쇠가 돌아오는 중이면 그 뒤) — 연사 없음
          if (this._delayAt === null) this._delayAt = Math.max(this.time + this.fireDelay, this.lastShotTime + this.cycleTime);
        } else if (this.lastShotTime + this.cycleTime > this.time + EPS) {
          // 노리쇠가 아직 돌아오는 중: 닫히는 순간 발사 (그때도 쥐고 있을 때만 — 짧게 톡 친 건 사라진다)
          this._pending = held;
          this._armed = held && this.mode === 'auto';
        } else {
          const r = this._attempt(this.time);
          this._armed = r === SHOT && held && this.mode === 'auto';
        }
      }
    } else if (held && blocked) {
      // 막힌 상태에서 쥐고 있는 방아쇠: 연사·대기 발사 취소 → 놓았다 다시 눌러야 쏜다
      this._armed = false;
      this._pending = false;
    }
    if (!held) {
      this.burstIndex = 0;
      this._armed = false;
      this._pending = false;
    }
    this._held = held;
  }

  /** 구간 (t0, time] 안에서 노리쇠가 닫히는 시각마다 발사 (연발 연사, 단발 대기분) */
  _fireWithin(t0) {
    const cycle = this.cycleTime;
    let ts = Math.max(t0, this.lastShotTime + cycle);
    // 매 발이 탄을 소모하고 빈 약실·고장에서 멈추므로 반복은 항상 끝난다
    while (ts <= this.time + EPS) {
      const r = this._attempt(ts);
      this._pending = false;
      if (r !== SHOT) { this._armed = false; return; }
      if (!this._armed) return;          // 단발 대기분은 한 발로 끝
      ts = this.lastShotTime + cycle;    // 정확히 60/rpm 간격 (프레임 경계와 무관)
    }
  }

  /** 시각 ts 에 한 발 시도: 빈 약실 → '딸깍', 고장 판정, 발사 후 다음 탄 장전 */
  _attempt(ts) {
    const timeOffset = this.time - ts > 0 ? this.time - ts : 0;
    if (!this.chambered) {
      this._dryFire('empty', timeOffset);
      return EMPTY;
    }
    const chance = this.malfunctionChance;
    if (this.rng.chance(chance)) {
      // 불발·급탄 불량: 탄은 약실에 그대로 (해결할 때 버려진다)
      this.malfunctioned = true;
      this.malfunctions++;
      this.emit('malfunction', { timeOffset, fouling: this.fouling, chance });
      this._dryFire('malfunction', timeOffset);
      return JAM;
    }
    const D = this.data;
    this.shotsFired++;
    this.burstIndex++;
    this.lastShotTime = ts;
    const every = D.tracerEvery > 0 ? D.tracerEvery : 1;
    const tracer = !!D.tracer && this.shotsFired % every === 0;
    this.emit('shot', { burstIndex: this.burstIndex, timeOffset, mode: this.mode, tracer, shotIndex: this.shotsFired, time: ts });
    // 노리쇠 순환: 탄피 배출 → 탄창에 탄이 있으면 다음 탄을 약실로 (AK 계열은 마지막 탄 뒤 노리쇠가 열린 채 멈추지 않는다)
    this.chambered = false;
    this._chamberFromMag();
    return SHOT;
  }

  /** '딸깍' (빈 약실·고장) — 소리용 이벤트 + 소음 */
  _dryFire(reason, timeOffset) {
    this.emit('dryFire', { reason, timeOffset });
    this._noise('dryFire', 'dryFire');
  }

  /**
   * 기계음 소음 (4단계 적이 듣는다). 무기는 자기 위치를 모르므로 반경(CONFIG.noise[kind])만 알리고,
   * 위치는 받는 쪽이 붙인다: weapon.on('noise', e => noise.emitNoise(사람 위치, e.radius, e.kind, 주체)).
   * 총성은 여기서 내지 않는다 (CombatSystem.fire 가 낸다 — 중복 방지).
   */
  _noise(kind, cause) {
    const radius = CONFIG.noise[kind];
    if (radius > 0) this.emit('noise', { kind, radius, cause });
  }

  _chamberFromMag() {
    if (this.chambered || this.magIndex < 0) return;
    const m = this.mags[this.magIndex];
    if (m.rounds > 0) {
      m.rounds--;
      this.chambered = true;
    }
  }

  // -----------------------------------------------------------------
  // 키 (B, R, T)
  // -----------------------------------------------------------------
  _onModeKey() {
    if (this.state === 'clearing') return;   // 고장 해결 중엔 손이 장전 손잡이에 있다
    const modes = this._modes();
    if (modes.length < 2) return;
    this.setMode(modes[(modes.indexOf(this.mode) + 1) % modes.length]);
  }

  _onReloadKey() {
    if (this.state !== 'ready') return;      // 재장전·탄창 확인·고장 해결 중 R 무시
    if (this.malfunctioned) { this._startAction('clear'); return; }
    const best = this._bestSpareMag();
    if (best >= 0) {
      this._nextMag = best;
      // 약실에 탄이 있으면 전술 재장전 (약실 유지 → 용량 + 1), 없으면 노리쇠 당기기까지 포함
      this._startAction(this.chambered ? 'reloadTactical' : 'reloadEmpty');
    } else if (!this.chambered && this.magRounds > 0) {
      this._startAction('clear');
    } else {
      this.emit('noMags', { reason: this.magRounds >= this.data.magCapacity ? 'full' : 'none' });
    }
  }

  _onMagCheckKey() {
    if (this.state !== 'ready' || this.magIndex < 0) return;
    this._startAction('magCheck');
  }

  /** 끼운 탄창보다 탄이 많은 탄창 중 가장 많은 것 (같으면 앞 번호), 없으면 -1 */
  _bestSpareMag() {
    let best = -1, most = this.magRounds;
    for (let i = 0; i < this.mags.length; i++) {
      if (i !== this.magIndex && this.mags[i].rounds > most) {
        best = i;
        most = this.mags[i].rounds;
      }
    }
    return best;
  }

  // -----------------------------------------------------------------
  // 동작 (재장전·탄창 확인·고장 해결)
  // -----------------------------------------------------------------
  _startAction(kind) {
    const spec = ACTIONS[kind];
    const R = this.data.reload || {};
    const mul = Number.isFinite(this.actionTimeMul) && this.actionTimeMul > 0 ? this.actionTimeMul : 1;
    const duration = Math.max(0, R[spec.time] || 0) * mul;
    const timeline = spec.timeline ? R[spec.timeline] || null : null;
    // 진행표: config 비율 → 시각. 빠진 값은 동작 끝, 순서가 뒤집힌 값은 앞 단계 시각으로 (빼기 전에 끼우는 일이 없게)
    this._steps = [];
    let prev = 0;
    for (const name of spec.steps) {
      const f = timeline && Number.isFinite(timeline[name]) ? clamp(timeline[name], 0, 1) : 1;
      prev = Math.max(prev, f);
      this._steps.push({ name, at: prev * duration });
    }
    this._stepIndex = 0;
    // 동작마다 새 객체 — 화면 모델이 참조 비교로 '새 동작'을 알아챌 수 있게 (몇 초에 한 번이라 쓰레기 걱정 없음)
    this.action = { kind, t: 0, duration, timeline };
    this._setState(spec.state);
    if (kind === 'magCheck') this.emit('magCheckStart', { duration });
    else if (kind === 'clear') this.emit('clearStart', { duration });
    else this.emit('reloadStart', { kind, duration });
  }

  _advanceAction(dt) {
    const a = this.action;
    if (!a) { this._setState('ready'); return; }
    const tEnd = a.t + dt;
    // 단계·끝 시각도 발사 예정 시각처럼 EPS 허용 — dt 를 누적한 a.t 는 1e-15 쯤 모자라기 쉬워서
    // (60Hz × 138 프레임 = 2.2999…) 없으면 2.3초 재장전이 한 프레임 늦은 2.317초에 끝난다
    while (this._stepIndex < this._steps.length && this._steps[this._stepIndex].at <= tEnd + EPS) {
      const s = this._steps[this._stepIndex++];
      a.t = s.at;                            // 단계 이벤트 처리 중 action.t = 그 단계의 정확한 시각
      this._runStep(s.name, a.kind);
    }
    if (tEnd >= a.duration - EPS) {
      a.t = a.duration;
      this._finishAction(a.kind);
    } else {
      a.t = tEnd;
    }
  }

  _runStep(name, kind) {
    if (name === 'magOut') {
      // 빼낸 탄창은 남은 탄 그대로 탄입대로 (버리지 않는다)
      const rounds = this.magRounds;
      this.magIndex = -1;
      this.emit('magOut', { rounds });
    } else if (name === 'magIn') {
      this.magIndex = this._nextMag;
      this._nextMag = -1;
      this.emit('magIn', { rounds: this.magRounds });
    } else if (name === 'boltPull') {
      // 고장 해결: 약실의 불발탄이 튀어나가 버려진다 → 고장 상태도 이 순간 풀린다
      // ('malfunctioned 이면 약실의 탄 = 불발탄' 이 항상 성립하게. 동작이 끝날 때까진 busy 라 어차피 못 쏜다)
      // 빈 상태 재장전: 약실은 이미 비어 있다
      if (kind === 'clear') {
        this.chambered = false;
        this.malfunctioned = false;
      }
      this.emit('boltPull', { kind });
    } else if (name === 'boltRelease') {
      this._chamberFromMag();
      this.emit('boltRelease', { kind, chambered: this.chambered });
    }
    this._noise('weaponMech', name);   // 탄창 분리·결합, 노리쇠 — 모두 기계음
  }

  _finishAction(kind) {
    this.action = null;
    this._setState('ready');
    if (kind === 'magCheck') {
      // 손으로 무게를 가늠한 결과 — 숫자는 보여주지 않는다 (fraction 은 디버그용)
      const fraction = this.data.magCapacity > 0 ? this.magRounds / this.data.magCapacity : 0;
      this.emit('magCheckResult', { label: Weapon.magCheckLabel(fraction, this.data.magCheckLabels), fraction });
    } else if (kind === 'clear') {
      this.emit('clearEnd', { chambered: this.chambered });
    } else {
      this.emit('reloadEnd', { magRounds: this.magRounds, chambered: this.chambered });
    }
  }

  _setState(state) {
    const prev = this.state;
    if (prev === state) return;
    this.state = state;
    this.emit('stateChange', { state, prev });
  }

  _modes() {
    const m = this.data.modes;
    const list = m && m.length ? m : DEFAULT_MODES;
    if (this.autoBlocked && list.includes('auto')) {
      const f = list.filter((x) => x !== 'auto');
      return f.length ? f : DEFAULT_MODES;
    }
    return list;
  }
}
