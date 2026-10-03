// 3단계 부상 로직 헤드리스 검증 (브라우저 없이 Node 로 실행)
//   node scripts/injury-check.mjs   (npm run injury)
// 판정(치명 4곳·저속·스침) · 부위별 이동/사격 제한 · 출혈 시간 · 붕대/지혈대 · 누적 · 실제 탄도 명중 · 사람 개체(F8 표적).
// 평평한 가짜 지형에서 HumanMotor 를 돌린다 (실제 맵은 sim-check 가 검증).
import { CONFIG } from '../src/config.js';
import { RNG } from '../src/core/rng.js';
import { HumanMotor } from '../src/human/HumanMotor.js';
import { SURFACE } from '../src/world/Surfaces.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { createFlatWorld } from '../src/combat/BulletWorld.js';
import { Shooter } from '../src/combat/Shooter.js';
import { Weapon } from '../src/combat/Weapon.js';
import { Injuries, makeTestHit } from '../src/combat/Injuries.js';
import { HumanEntity } from '../src/combat/HumanEntity.js';

const DT = 1 / 60;
let failures = 0, passes = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (ok) passes++; else failures++;
};
const near = (v, t, tol) => Math.abs(v - t) <= tol;
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

/** 평평한 땅 (HumanMotor 가 쓰는 WorldQuery 메서드만) */
function flatQuery(h = 0) {
  return {
    wetness: CONFIG.weather.presets.clear.wetness,
    getGroundInfo(x, z, out = {}) {
      out.terrain = h; out.support = h; out.surface = SURFACE.PACKED_DIRT; out.waterLevel = -1e9; out.waterDepth = 0;
      out.onDike = false; out.obstacle = null;
      return out;
    },
    getSlope(x, z, out = { deg: 0, gx: 0, gz: 0 }) { out.deg = 0; out.gx = 0; out.gz = 0; return out; },
    resolveCircles() { return false; },
    clampToBounds() {},
    getWaterDepth() { return 0; },
    getSupportHeight() { return h; },
    getTerrainHeight() { return h; },
    getSurfaceAt() { return SURFACE.PACKED_DIRT; },
    clearanceAt() { return Infinity; },
    circleGrid: { forEachNear() {} },
  };
}
const query = flatQuery(0);

function motorPose(m) {
  return {
    x: m.position.x, y: m.position.y, z: m.position.z, yaw: m.yaw, stance: m.stance, stanceFrom: m.stanceFrom,
    stanceProgress: m.stanceProgress, lean: m.leanOffset, eyeHeight: m.eyeHeight, arms: 'rifle',
  };
}

/** 사람 한 명 (이동 + 판정 + 부상 + 사수) */
function makeHuman(seed = 1, { stance = 'stand' } = {}) {
  const motor = new HumanMotor(query, { x: 0, z: 0, yaw: 0, name: 't' });
  const combat = new CombatSystem(null, null, { rng: new RNG(seed), world: createFlatWorld(-50) });
  const injuries = new Injuries({ rng: new RNG(seed * 7 + 1), motor });
  const person = combat.addPerson({ name: 't', getPose: () => motorPose(motor), injuries, suppression: null });
  const shooter = new Shooter(combat, person, CONFIG.weapons[CONFIG.weapons.default], { rng: new RNG(seed + 99) });
  if (stance !== 'stand') { motor.forceStance(stance, 0.05); for (let i = 0; i < 10; i++) motor.update(DT); }
  person.refresh();
  return { motor, combat, injuries, person, shooter };
}

function step(h, seconds, input = {}) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    h.motor.input.move.x = input.x ?? 0;
    h.motor.input.move.z = input.z ?? 0;
    h.motor.input.sprint = !!input.sprint;
    if (input.stance) h.motor.requestStance(input.stance);
    h.motor.update(DT);
    h.injuries.update(DT, { speed: Math.hypot(h.motor.velocity.x, h.motor.velocity.z) });
    h.injuries.apply(h.motor, h.shooter);
    h.person.refresh();
    if (h.injuries.dead) break;
  }
}

function hitWith(h, kind, opts = {}) {
  h.person.refresh();
  const hit = makeTestHit(h.person, kind, opts);
  if (!hit) return null;
  return h.injuries.applyHit(hit, opts);
}

// ---------------------------------------------------------------------
console.log('\n[1] 치명 부위 4곳 — 머리·목·심장·척추 (서기·앉기·엎드리기)');
for (const stance of ['stand', 'crouch', 'prone']) {
  for (const kind of ['head', 'neck', 'heart', 'spine']) {
    const h = makeHuman(3, { stance });
    const r = hitWith(h, kind);
    check(r && r.severity === 'lethal' && h.injuries.dead && h.injuries.cause === kind,
      `${stance} ${kind}: ${r ? `${r.severity} / ${h.injuries.causeLabel}` : '명중 생성 실패'}`);
  }
}
{
  // 가슴 상부라도 심장·척추를 비켜 간 폐 명중은 비치명 (가슴 부상)
  const h = makeHuman(4);
  const r = hitWith(h, 'lung');
  check(r && r.severity === 'wound' && r.type === 'chest' && !h.injuries.dead, `폐(가슴 상부 오른쪽): ${r?.severity} ${r?.type}`);
}

// ---------------------------------------------------------------------
console.log('\n[2] 실제 탄도로 쏜 명중 — 정면 30m 가슴 상부 400발 분포, 머리 100% 치명');
{
  const rng = new RNG(77);
  const cnt = { lethal: 0, heart: 0, spine: 0, wound: 0, graze: 0, other: 0, miss: 0 };
  for (let i = 0; i < 400; i++) {
    const h = makeHuman(1000 + i);
    const c = h.person.hitboxes.chest;
    const tx = c.x + rng.range(-0.17, 0.17), ty = c.y + rng.range(-0.12, 0.12);
    const origin = { x: tx, y: ty, z: -30 };
    let res = null;
    h.combat.on('hit', (e) => { res = e; });
    h.combat.fire({ name: 'enemy' }, { origin, dir: { x: 0, y: 0, z: 1 } });
    for (let k = 0; k < 20 && !res; k++) h.combat.update(DT);
    if (!res) { cnt.miss++; continue; }
    const w = res.wound;
    if (res.part !== 'upperChest') cnt.other++;
    if (w.severity === 'lethal') { cnt.lethal++; if (w.zone === 'heart') cnt.heart++; if (w.zone === 'spine') cnt.spine++; }
    else if (w.severity === 'graze') cnt.graze++;
    else cnt.wound++;
  }
  const hits = 400 - cnt.miss;
  console.log(`     명중 ${hits} (다른 부위 ${cnt.other}) · 치명 ${cnt.lethal} (심장 ${cnt.heart}, 척추 ${cnt.spine}) · 부상 ${cnt.wound} · 스침 ${cnt.graze}`);
  check(cnt.heart > hits * 0.05 && cnt.heart < hits * 0.45, `정면 가슴 상부 명중 중 심장 치명 비율 ${(100 * cnt.heart / hits).toFixed(0)}% (5~45%)`);
  check(cnt.wound > cnt.lethal * 0.5, `폐(비치명) 명중이 나옴: ${cnt.wound}`);
  // 머리
  let headKills = 0, headHits = 0;
  for (let i = 0; i < 40; i++) {
    const h = makeHuman(2000 + i);
    const head = h.person.hitboxes.find((x) => x.part === 'head');
    const origin = { x: head.a.x + rng.range(-0.05, 0.05), y: (head.a.y + head.b.y) / 2 + rng.range(-0.05, 0.05), z: -30 };
    let res = null;
    h.combat.on('hit', (e) => { res = e; });
    h.combat.fire({ name: 'enemy' }, { origin, dir: { x: 0, y: 0, z: 1 } });
    for (let k = 0; k < 20 && !res; k++) h.combat.update(DT);
    if (res && res.part === 'head') { headHits++; if (h.injuries.dead && h.injuries.cause === 'head') headKills++; }
  }
  check(headHits > 30 && headKills === headHits, `머리 명중 ${headHits}발 → 치명 ${headKills}발 (스침 판정 깊이 밖은 전부 즉사)`);
  // 등 뒤에서 척추
  let spineKills = 0;
  for (let i = 0; i < 20; i++) {
    const h = makeHuman(3000 + i);
    const a = h.person.hitboxes.spineA, b = h.person.hitboxes.spineB;
    const origin = { x: (a.x + b.x) / 2 + rng.range(-0.02, 0.02), y: (a.y + b.y) / 2 + rng.range(-0.05, 0.05), z: 30 };
    let res = null;
    h.combat.on('hit', (e) => { res = e; });
    h.combat.fire({ name: 'enemy' }, { origin, dir: { x: 0, y: 0, z: -1 } });
    for (let k = 0; k < 20 && !res; k++) h.combat.update(DT);
    if (res && h.injuries.cause === 'spine') spineKills++;
  }
  check(spineKills >= 18, `등 중앙선(목 아래~견갑골 사이) 뒤에서 20발 → 척추 치명 ${spineKills}`);
}

// ---------------------------------------------------------------------
console.log('\n[3] 부위별 이동·사격 제한 (충격 1.5초 뒤)');
{
  const crawl = (h, seconds = 4) => {
    h.motor.requestStance('prone');
    const x0 = h.motor.position.x, z0 = h.motor.position.z;
    step(h, seconds, { z: 1 });
    return Math.hypot(h.motor.position.x - x0, h.motor.position.z - z0) / seconds;
  };
  for (const [kind, label, maxV] of [['lung', '가슴', 0.15], ['abdomen', '복부', 0.15], ['pelvis', '골반', 0.15]]) {
    const h = makeHuman(10);
    hitWith(h, kind);
    const stunned = h.injuries.stunned;
    step(h, 0.1, { z: 1 });
    const stunMove = Math.hypot(h.motor.position.x, h.motor.position.z);
    step(h, 1.6);
    const prone = h.motor.stance === 'prone';
    const stand = h.motor.requestStance('stand'), crouch = h.motor.requestStance('crouch');
    const v = crawl(h);
    const fx = h.injuries.effects();
    check(stunned && stunMove < 0.01 && prone && !stand && !crouch && v <= maxV + 0.01 && v > maxV * 0.6 && near(fx.swayMul, 2, 0.01),
      `${label}: 충격 중 이동 ${f2(stunMove)}m, 강제 엎드림 ${prone}, 서기/앉기 불가, 기기 ${f2(v)}m/s (≤${maxV}), 흔들림 ×${f2(fx.swayMul)}`);
    if (kind === 'lung') {
      step(h, 30);
      check(h.motor.stamina <= 30.01 && fx.cough, `가슴: 스태미나 상한 30 (지금 ${f2(h.motor.stamina)}), 기침`);
    }
  }
  {
    const h = makeHuman(11);
    hitWith(h, 'thighL', { forceArterial: false });
    step(h, 1.6);
    const stand = h.motor.requestStance('stand');
    step(h, 0.1);
    const crouch = h.motor.requestStance('crouch');
    step(h, 1.2);
    const sitting = h.motor.stance === 'crouch';
    const x0 = h.motor.position.z;
    step(h, 4, { z: 1 });
    const vCrouch = Math.abs(h.motor.position.z - x0) / 4;
    const v = crawl(h);
    check(!stand && crouch && sitting && vCrouch <= 0.26 && v <= 0.26 && v > 0.15,
      `대퇴: 서기 불가, 앉기 가능, 끌기 ${f2(vCrouch)}m/s · 기기 ${f2(v)}m/s (≤0.25)`);
  }
  {
    const h = makeHuman(12);
    hitWith(h, 'shinR');
    step(h, 1.6);
    let stumbles = 0;
    h.injuries.on('stumble', () => stumbles++);
    const z0 = h.motor.position.z;
    step(h, 40, { z: 1, sprint: true });
    const v = Math.abs(h.motor.position.z - z0) / 40;
    const crouchOk = h.motor.requestStance('crouch');
    check(h.motor.caps.canSprint === false && h.motor.caps.canJump === false && v <= 0.31 && v > 0.1 && stumbles >= 2 && crouchOk,
      `하퇴: 달리기·점프 불가, 서서 ${f2(v)}m/s (≤0.3), 휘청 ${stumbles}번 / 40초, 앉기 가능`);
  }
  for (const [kind, label, sway, recoil, reload, trig] of [
    ['upperArmR', '오른 상완(방아쇠 팔)', 4, 2.5, 2.5, true], ['upperArmL', '왼 상완(지지 팔)', 4 * 1.3, 2.5, 2.5, false],
    ['forearmR', '오른 하완', 2.5, 2, 2, true], ['forearmL', '왼 하완', 2.5 * 1.3, 2, 2, false],
  ]) {
    const h = makeHuman(13);
    hitWith(h, kind, { forceArterial: false, forceDrop: false });
    step(h, 1.6);
    const ext = h.shooter.aim;
    const w = h.shooter.weapon;
    const s = ext._ext.get('injury');
    check(s && near(s.swayMul, sway, 0.01) && near(s.recoilMul, recoil, 0.01) && near(w.actionTimeMul, reload, 0.01) &&
      (trig ? w.fireDelay === 0.3 && w.autoBlocked && w.mode !== 'auto' : w.fireDelay === 0 && !w.autoBlocked) && h.motor.caps.canStand,
    `${label}: 흔들림 ×${f2(s?.swayMul)} 반동 ×${f2(s?.recoilMul)} 재장전 ×${f2(w.actionTimeMul)} 지연 ${w.fireDelay}s 연발${w.autoBlocked ? ' 불가' : ' 가능'}`);
  }
  {
    // 총 떨어뜨림 30%
    let drops = 0;
    for (let i = 0; i < 400; i++) {
      const h = makeHuman(5000 + i);
      const r = hitWith(h, 'forearmL', { forceArterial: false });
      if (r.dropped) drops++;
    }
    const h = makeHuman(14);
    hitWith(h, 'upperArmR', { forceDrop: true, forceArterial: false });
    step(h, 1.6);
    const blocked = h.shooter.blocked;
    h.injuries.pickUpWeapon();
    step(h, 0.1);
    check(near(drops / 400, 0.3, 0.06) && blocked === 'dropped' && h.shooter.blocked === null,
      `팔 명중 시 총 떨어뜨림 ${(100 * drops / 400).toFixed(0)}% (30%), 떨어뜨리면 사격 막힘 → 주우면 풀림`);
  }
}

// ---------------------------------------------------------------------
console.log('\n[4] 무기: 발사 지연 0.3초 · 연발 불가 · 재장전 ×2.5');
{
  const w = new Weapon(CONFIG.weapons[CONFIG.weapons.default], { rng: new RNG(5) });
  w.fireDelay = 0.3;
  w.setAutoBlocked(true);
  const shots = [];
  w.on('shot', (e) => shots.push(e.time));
  w.setMode('auto');
  w.update(DT, { trigger: true });
  for (let i = 0; i < 5; i++) w.update(DT, { trigger: false });
  for (let i = 0; i < 60; i++) w.update(DT, { trigger: false });
  check(shots.length === 1 && near(shots[0], 0.3 + DT, 0.02) && w.mode !== 'auto', `짧게 누름 → ${shots.length}발, ${f2(shots[0])}s 에 발사 (누른 시각 ${f2(DT)} + 0.3), 연발 전환 불가`);
  shots.length = 0;
  for (let i = 0; i < 120; i++) w.update(DT, { trigger: true });
  check(shots.length === 1, `쥐고 있어도 연사 없음: 2초 동안 ${shots.length}발`);
  const w2 = new Weapon(CONFIG.weapons[CONFIG.weapons.default], { rng: new RNG(6) });
  w2.actionTimeMul = 2.5;
  let dur = 0;
  w2.on('reloadStart', (e) => { dur = e.duration; });
  w2.update(DT, { trigger: true }); w2.update(DT, {});
  w2.update(DT, { reload: true });
  const base = CONFIG.weapons[CONFIG.weapons.default].reload.tactical;
  check(near(dur, base * 2.5, 1e-6), `전술 재장전 ${f2(base)}s → ${f2(dur)}s`);
}

// ---------------------------------------------------------------------
console.log('\n[5] 출혈 시간 (혈액 100 → 40% 미만 사망)');
function bleedOut(kind, opts = {}) {
  const inj = new Injuries({ rng: new RNG(9) });
  const h = makeHuman(20);
  const hit = makeTestHit(h.person, kind, opts);
  hit.person = h.person;
  inj.applyHit(hit, opts);
  for (let k = 0; k < 150; k++) inj.update(DT);   // 충격(조작 불가)이 풀릴 때까지
  if (opts.bandage) { inj.startAid('bandage'); for (let t = 0; t < 30 && inj.aid; t += DT) inj.update(DT); }
  if (opts.tourniquet) { inj.startAid('tourniquet'); for (let t = 0; t < 30 && inj.aid; t += DT) inj.update(DT); }
  let t = 0;
  const stages = {};
  inj.on('stage', (e) => { stages[e.stage] = inj.time; });
  while (!inj.dead && t < 3600) { inj.update(0.05); t += 0.05; }
  return { time: inj.dead ? inj.deathTime : Infinity, cause: inj.cause, stages, inj };
}
{
  const a = bleedOut('thighL', { forceArterial: true });
  check(a.time >= 60 && a.time <= 135 && a.cause === 'bleed', `대퇴 동맥 30%/분: ${f2(a.time / 60)}분 뒤 출혈 사망 (1~2분)`);
  check(a.stages.weak > 0 && a.stages.faint > a.stages.weak, `단계: 80% 미만 ${f2(a.stages.weak)}s, 60% 미만 ${f2(a.stages.faint)}s`);
  const b = bleedOut('upperArmR', { forceArterial: true, forceDrop: false });
  check(b.time >= 60 && b.time <= 150, `상완 동맥 25%/분: ${f2(b.time / 60)}분 (약 2.4분 — 근처면 통과)`);
  const c = bleedOut('lung');
  check(c.time >= 240 && c.time <= 360, `가슴 12%/분: ${f2(c.time / 60)}분 (수 분)`);
  const d = bleedOut('abdomen');
  check(d.time >= 360 && d.time <= 540, `복부 8%/분: ${f2(d.time / 60)}분`);
  const e = bleedOut('thighL', { forceArterial: false });
  check(e.time >= 600, `대퇴 일반 5%/분: ${f2(e.time / 60)}분`);
  const g = bleedOut('graze', { part: 'upperChest' });
  check(g.time > 3000 || g.time === Infinity, `스침 1%/분: ${g.time === Infinity ? '1시간 안에 사망 없음' : f2(g.time / 60) + '분'}`);
  // 붕대·지혈대
  const ba = bleedOut('thighL', { forceArterial: true, bandage: true });
  check(ba.time > a.time * 1.5 && near(ba.inj.wounds[0].bleed * CONFIG.injury.aid.bandageArterialMul, 18, 0.01),
    `동맥에 붕대: 30 → 18%/분 (×0.6까지만), 사망 ${f2(ba.time / 60)}분`);
  const tq = bleedOut('thighL', { forceArterial: true, tourniquet: true });
  check(tq.time === Infinity && tq.inj.bleedRate === 0, `동맥에 지혈대: 출혈 ${tq.inj.bleedRate}%/분 → 사망 없음`);
  const bc = bleedOut('lung', { bandage: true });
  check(near(bc.inj.bleedRate, 12 * 0.15, 0.01), `가슴에 붕대: 12 → ${f2(bc.inj.bleedRate)}%/분 (×0.15)`);
}

// ---------------------------------------------------------------------
console.log('\n[6] 자가 처치 규칙');
{
  const h = makeHuman(30);
  hitWith(h, 'lung');
  step(h, 1.6);
  const refusedT = h.injuries.startAid('tourniquet');
  check(!refusedT.ok && refusedT.reason === 'noLimb', `몸통에 지혈대 불가 (${refusedT.reason})`);
  const s = h.injuries.startAid('bandage');
  check(s.ok && near(s.duration, 7, 1e-6) && h.shooter.blocked === null, `붕대 7초 시작`);
  step(h, 0.1);
  check(h.shooter.blocked === 'aid', `처치 중 사격 불가 (${h.shooter.blocked})`);
  step(h, 1, { z: 1 });
  check(!h.injuries.aid && h.injuries.bandages === 2, `움직이면 취소 (붕대 ${h.injuries.bandages}개 그대로)`);
  h.injuries.startAid('bandage');
  step(h, 3);
  hitWith(h, 'shinL');
  check(!h.injuries.aid && h.injuries.bandages === 2, `맞으면 취소`);
  step(h, 2.1);
  h.injuries.startAid('bandage');
  step(h, 7.1);
  check(h.injuries.bandages === 1 && h.injuries.wounds.filter((w) => w.bandaged).length === 1, `7초 뒤 붕대 1개 사용, 상처 1곳 감음`);
  // 팔 부상 → ×1.5
  const h2 = makeHuman(31);
  hitWith(h2, 'forearmL', { forceDrop: false });
  step(h2, 1.6);
  const s2 = h2.injuries.startAid('tourniquet');
  check(s2.ok && near(s2.duration, 7.5, 1e-6), `팔 부상이면 지혈대 5 → ${f2(s2.duration)}초`);
  step(h2, 7.6);
  check(h2.injuries.tourniquets === 0 && h2.injuries.bleedRate === 0, `지혈대: 팔 출혈 정지 (지혈대 ${h2.injuries.tourniquets}개 남음)`);
  const s3 = h2.injuries.startAid('tourniquet');
  check(!s3.ok && s3.reason === 'none', `지혈대 1개뿐 (${s3.reason})`);
}

// ---------------------------------------------------------------------
console.log('\n[7] 저속 탄 · 스침 예외');
{
  const h = makeHuman(40);
  const r = hitWith(h, 'lowSpeed');
  check(r.severity === 'wound' && r.type === 'chest' && r.lowSpeed && !h.injuries.dead, `심장 경로 + 남은 속도 30% → 치명 대신 가슴 중상 (${r.type})`);
  const h1 = makeHuman(41);
  const r1 = hitWith(h1, 'head', { retained: 0.3 });
  check(r1.severity === 'wound' && r1.type === 'chest' && !h1.injuries.dead, `머리 + 저속 → 가슴 수준 중상 (강제 엎드림 ${h1.motor.stance === 'prone' || h1.motor.transitioning})`);
  const h2 = makeHuman(42);
  const r2 = hitWith(h2, 'thighR', { retained: 0.35 });
  check(r2.severity === 'graze', `대퇴 + 저속 → 스침 (${r2.severity})`);
  const h3 = makeHuman(43);
  const r3 = hitWith(h3, 'graze', { part: 'upperChest' });
  step(h3, 0.5, { z: 1 });
  const stiff = Math.hypot(h3.motor.position.x, h3.motor.position.z) < 0.01;
  step(h3, 1.6);
  const z0 = h3.motor.position.z;
  step(h3, 3, { z: 1 });
  const v = Math.abs(h3.motor.position.z - z0) / 3;
  check(r3.severity === 'graze' && stiff && v > 1.2 && near(h3.injuries.effects().swayMul, 1.3, 0.01) && near(h3.injuries.bleedRate, 1, 1e-6),
    `스침 (깊이 ${f2(r3.depth * 100)}cm): 경직 2초, 그 뒤 걷기 ${f2(v)}m/s (제한 없음), 흔들림 ×1.3, 출혈 1%/분`);
  const h4 = makeHuman(44);
  const r4 = hitWith(h4, 'graze', { part: 'head' });
  check(r4.severity === 'graze' && !h4.injuries.dead, `머리 스침은 치명 아님`);
  // 실제 탄도: 대나무 2번 관통 (남은 속도 < 40%)
  const h5 = makeHuman(45);
  let res = null;
  h5.combat.on('hit', (e) => { res = e; });
  // 가상의 관통 2번: retained 를 직접 낮춘 탄 (BulletWorld 평지에는 대나무가 없음 → 탄의 retained 를 흉내)
  const p = h5.combat.fire({ name: 'enemy' }, { origin: { x: h5.person.hitboxes.heart.x, y: h5.person.hitboxes.heart.y, z: -20 }, dir: { x: 0, y: 0, z: 1 } });
  p.retained = 0.55 * 0.6;
  for (let k = 0; k < 20 && !res; k++) h5.combat.update(DT);
  check(res && res.retained < 0.4 && res.wound.severity !== 'lethal', `관통 2번(남은 속도 ${f2(res?.retained)}) 뒤 심장 명중 → ${res?.wound.severity} ${res?.wound.type}`);
  // 근접 통과 1cm → 스침
  const h6 = makeHuman(46);
  let ne = null;
  h6.combat.on('nearPass', (e) => { ne = e; });
  const head = h6.person.hitboxes.find((x) => x.part === 'head');
  h6.combat.fire({ name: 'enemy' }, { origin: { x: head.a.x + head.r + 0.01, y: (head.a.y + head.b.y) / 2, z: -20 }, dir: { x: 0, y: 0, z: 1 } });
  for (let k = 0; k < 40 && !ne; k++) h6.combat.update(DT);
  check(ne && ne.distance <= 0.02 && ne.graze && ne.graze.severity === 'graze', `머리 옆 ${f2((ne?.distance ?? 0) * 100)}cm 근접 통과 → 스침`);
}

// ---------------------------------------------------------------------
console.log('\n[8] 부상 누적 (가장 심한 제한, 출혈 합)');
{
  const h = makeHuman(50);
  hitWith(h, 'shinL');
  hitWith(h, 'thighR', { forceArterial: false });
  hitWith(h, 'forearmR', { forceDrop: false });
  hitWith(h, 'lung');
  step(h, 1.6);
  const fx = h.injuries.effects();
  check(near(h.injuries.bleedRate, 3 + 5 + 2 + 12, 1e-6), `출혈 합 3+5+2+12 = ${f2(h.injuries.bleedRate)}%/분`);
  check(h.motor.caps.maxSpeed.prone === 0.15 && !h.motor.caps.canStand && !h.motor.caps.canCrouch && h.motor.caps.maxStamina === 30,
    `제한: 기기 최대 ${h.motor.caps.maxSpeed.prone} (가슴 0.15 < 대퇴 0.25), 서기·앉기 불가, 스태미나 ${h.motor.caps.maxStamina}`);
  check(near(fx.swayMul, 2.5, 0.01) && near(fx.recoilMul, 2, 0.01) && h.shooter.weapon.fireDelay === 0.3, `흔들림 ×${f2(fx.swayMul)} (가장 큰 값), 반동 ×${f2(fx.recoilMul)}, 발사 지연 유지`);
  const sway0 = fx.swayMul;
  // 혈액 손실에 따른 흔들림 증가·기는 속도 감소
  h.injuries.blood = 55;
  h.injuries._ver++;
  const fx2 = h.injuries.effects();
  h.injuries.apply(h.motor, h.shooter);
  check(fx2.swayMul > sway0 * 1.25 && h.motor.caps.maxSpeed.prone < 0.15, `혈액 55%: 흔들림 ×${f2(fx2.swayMul)}, 기기 최대 ${f2(h.motor.caps.maxSpeed.prone)}m/s`);
}

// ---------------------------------------------------------------------
console.log('\n[9] 사람 개체 (F8 표적) — 부위별 쓰러짐·기어가기·출혈 사망');
{
  const mk = (seed, opts = {}) => {
    const combat = new CombatSystem(null, null, { rng: new RNG(seed), world: createFlatWorld(-50) });
    const e = new HumanEntity(query, combat, { x: 0, z: 0, yaw: Math.PI, stance: opts.stance ?? 'stand', rng: new RNG(seed), walk: opts.walk ?? null });
    return { combat, e };
  };
  const shoot = ({ combat, e }, kind, opts = {}) => {
    e.person.refresh();
    const hit = makeTestHit(e.person, kind, opts);
    hit.shooter = { name: 'player', position: { x: 0, y: 0, z: -30 } };
    hit.point && e.injuries.applyHit(hit, opts);
    e.onHit(hit);
    return hit;
  };
  const run = ({ e }, seconds) => { for (let t = 0; t < seconds; t += DT) { e.update(DT); if (e.state === 'dead' && e.settled) break; } };
  {
    const T = mk(1);
    shoot(T, 'heart');
    run(T, 3);
    check(T.e.state === 'dead' && T.e.fall && T.e.fall.kind === 'collapse' && T.e.fall.t >= 1, `심장: 즉사 → 맞은 방향으로 쓰러져 누움 (${T.e.fall?.kind})`);
  }
  {
    const T = mk(2);
    shoot(T, 'head');
    run(T, 3);
    check(T.e.state === 'dead' && T.e.injuries.cause === 'head', `머리: 즉사`);
  }
  {
    const T = mk(3);
    shoot(T, 'thighL', { forceArterial: false });
    const p0 = { ...T.e.motor.position };
    run(T, 25);
    const d = Math.hypot(T.e.motor.position.x - p0.x, T.e.motor.position.z - p0.z);
    check(T.e.state !== 'dead' && T.e.motor.stance !== 'stand' && d >= 2.5 && d <= 5.5, `대퇴: 쓰러져 ${T.e.motor.stance}, ${f2(d)}m 기어감 (3~5m)`);
  }
  {
    const T = mk(4);
    shoot(T, 'shinR');
    run(T, 1.0);
    check(T.e.motor.stance !== 'prone' && T.e.state !== 'dead', `하퇴: 주저앉음 (${T.e.motor.stance})`);
  }
  {
    const T = mk(5);
    shoot(T, 'thighR', { forceArterial: true });
    let vocals = 0;
    T.e.on('vocal', () => vocals++);
    run(T, 200);
    check(T.e.state === 'dead' && T.e.injuries.cause === 'bleed' && T.e.injuries.deathTime < 135 && vocals >= 5,
      `대퇴 동맥: ${f2(T.e.injuries.deathTime / 60)}분 뒤 출혈 사망, 신음·거친 숨 ${vocals}번`);
  }
  {
    const T = mk(6);
    shoot(T, 'lung');
    run(T, 3);
    const s = T.e.injuries.summary();
    check(s.alive && s.downed && s.wounds.length === 1 && s.wounds[0].type === 'chest' && T.e.motor.stance === 'prone',
      `가슴: 엎드러짐, 상태 읽기 summary() — ${s.wounds[0].label} ${f2(s.bleedRate)}%/분 혈액 ${f2(s.blood)}%`);
  }
  {
    const T = mk(7, { walk: { axis: { x: 1, z: 0 }, min: 4, max: 4, speed: 1.4 } });
    run(T, 3);
    const moved = Math.abs(T.e.motor.position.x) > 1;
    shoot(T, 'abdomen');
    run(T, 2);
    check(moved && T.e.motor.stance === 'prone' && !T.e.walk, `걷던 표적이 복부 명중 → 걷기 멈추고 쓰러짐`);
  }
}

console.log(`\n${failures ? `실패 ${failures}개` : '모두 통과'} (통과 ${passes})`);
process.exit(failures ? 1 : 0);
