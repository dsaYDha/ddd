// =====================================================================
//  거치 감지 — 조준 중 총몸(손잡이 덮개) 바로 아래에 받칠 곳(통나무·바위·뿌리·판근·논둑·흙둔덕)이 있거나,
//  바로 옆에 나무 줄기·대나무·야자 같은 단단한 기둥이 닿아 있으면 '거치'. 아이콘 없이 총이 살짝 내려앉는 것으로만 보인다.
//  순수 로직 (three.js·DOM 없음). WorldQuery 를 읽기만 한다 (getSupportHeight, circleGrid).
//  판정은 이번 프레임의 순간값 — 들어가고 나오는 지연(hysteresis)은 AimModel 이 rest.enterTime/exitTime 으로 처리한다.
//
//  손잡이 덮개 아랫면 점 H = 눈 + 시선 × forward − (0, below, 0)
//   a) 받침: H 와 그보다 probeAhead 앞 점에서 query.getSupportHeight(지형·논둑·지지형 장애물 중 가장 높은 윗면)가
//            [H.y − maxGap − reach[자세], H.y − minGap] 안 — 총을 그 위에 얹을 수 있는 높이 (minGap < 0 → 살짝 눌러 얹은 것도 허용)
//            reach: 자세를 조금 더 낮춰(서기 → 무릎 굽힘, 앉기 → 더 낮게 앉음) 아래 받침에 총을 얹을 수 있는 거리.
//            고정된 자세별 눈높이(1.65 / 1.05 / 0.32m)만으로는 높이 0.4~0.8m 통나무에 앉아서 얹을 수가 없어서다.
//            reach 를 쓴 만큼은 out.drop (m) — 화면(카메라·총)을 그만큼 내리면 보이는 것과 맞는다. reach 0 = 계약의 원래 규칙.
//            엎드리기는 위로 올릴 수 없다 (총을 올리면 눈도 올라가야 하는데 엎드린 눈높이는 고정 — 시선이 받침에 막힘).
//            kind: 장애물·논둑이면 'support', 맨땅(경사·둔덕)이면 'terrain'
//   b) 옆 기둥: 이동을 막는 원기둥 충돌체(반경 ≥ minTrunkR)가 H 높이에 걸쳐 있고, 그 표면이 H 에서 수평으로 sideGap 이내 → 'trunk'
//  움직이는 중(speed > maxSpeed)이면 거치하지 않는다.
// =====================================================================
import { CONFIG } from '../config.js';

const SUP = { obstacle: null, onDike: false };
// 기둥 검사 상태 (forEachNear 콜백을 매 프레임 새로 만들지 않으려고 모듈에 둔다)
const TR = { x: 0, y: 0, z: 0, gap: 0, minR: 0, best: null, bestD: Infinity };

function visitTrunk(c) {
  if (!c.tags || !c.tags.blocksMovement || !(c.r >= TR.minR)) return;
  if (TR.y < c.y0 || TR.y > c.y1) return;
  const d = Math.hypot(TR.x - c.x, TR.z - c.z) - c.r;   // 줄기 표면까지 (안쪽이면 음수 — 눌러 댄 것)
  if (d <= TR.gap && d < TR.bestD) { TR.bestD = d; TR.best = c; }
}

/**
 * @param {import('../world/WorldQuery.js').WorldQuery} query
 * @param {{x,y,z}} eye    눈 (조준선 시작점)
 * @param {{x,y,z}} dir    조준 방향 (단위 벡터)
 * @param {string} stance  'stand'|'crouch'|'prone' — 자세를 낮춰 닿을 수 있는 거리(rest.reach)를 고른다
 * @param {number} speed   수평 이동 속도 (m/s)
 * @param {object} out     재사용 객체
 * @returns {{rested:boolean, kind:'support'|'terrain'|'trunk'|null, object:string|null, gap:number, drop:number}}
 *          object = 받친 것의 종류 ('log','rock','root','buttress','dike','terrain', 줄기는 'bigTree','bamboo' …),
 *          gap = 받침 윗면까지 수직 간격 또는 줄기 표면까지 수평 거리 (m, 디버그용),
 *          drop = 받침에 닿으려고 자세를 더 낮춘 거리 (m, 0 이면 그대로 얹음)
 */
export function detectRest(query, eye, dir, stance, speed, out = {}) {
  const R = CONFIG.aim.rest;
  out.rested = false;
  out.kind = null;
  out.object = null;
  out.gap = NaN;
  out.drop = 0;
  if (!query || !eye || !dir) return out;
  if (speed > R.maxSpeed) return out;

  // 손잡이 덮개 아랫면
  const hx = eye.x + dir.x * R.forward;
  const hy = eye.y + dir.y * R.forward - R.below;
  const hz = eye.z + dir.z * R.forward;

  // a) 아래 받침 — 손잡이 덮개에는 길이가 있으므로 조금 앞쪽도 본다 (그 점은 총열을 따라 높이도 바뀐다).
  //    두 점 중 자세를 덜 낮춰도 되는 쪽을 고른다
  if (query.getSupportHeight) {
    const reach = Math.max(0, (R.reach && R.reach[stance]) || 0);
    const ahead = R.probeAhead ?? 0;
    let bestGap = Infinity, bestKind = null, bestObj = null;
    for (let k = 0; k < 2; k++) {
      const t = k ? ahead : 0;
      if (k && !(t > 0)) break;
      const px = hx + dir.x * t, py = hy + dir.y * t, pz = hz + dir.z * t;
      SUP.obstacle = null; SUP.onDike = false;
      const top = query.getSupportHeight(px, pz, SUP);
      const gap = py - top;
      if (gap >= R.minGap && gap <= R.maxGap + reach && gap < bestGap) {
        bestGap = gap;
        bestKind = SUP.obstacle || SUP.onDike ? 'support' : 'terrain';
        bestObj = SUP.obstacle ? SUP.obstacle.type : SUP.onDike ? 'dike' : 'terrain';
      }
    }
    SUP.obstacle = null;   // 월드 객체 참조를 붙잡고 있지 않게
    if (bestKind) {
      out.rested = true;
      out.kind = bestKind;
      out.object = bestObj;
      out.gap = bestGap;
      out.drop = Math.max(0, bestGap - R.maxGap);
      // 자세를 낮추지 않고 그대로 얹을 수 있으면 끝. 낮춰야 한다면 바로 옆 기둥(낮출 필요 없음)이 있는지 더 본다
      if (out.drop === 0) return out;
    }
  }

  // b) 옆 기둥 — 원기둥은 몸 반경만큼 넓혀 격자에 들어 있으므로 sideGap 범위의 칸만 보면 된다
  const grid = query.circleGrid;
  if (grid && grid.forEachNear) {
    TR.x = hx; TR.y = hy; TR.z = hz;
    TR.gap = R.sideGap;
    TR.minR = R.minTrunkR ?? 0.05;
    TR.best = null; TR.bestD = Infinity;
    grid.forEachNear(hx, hz, Math.max(0.01, R.sideGap), visitTrunk);
    if (TR.best) {
      out.rested = true;
      out.kind = 'trunk';
      out.object = TR.best.type ?? 'trunk';
      out.gap = TR.bestD;
      out.drop = 0;
      TR.best = null;
    }
  }
  return out;
}
