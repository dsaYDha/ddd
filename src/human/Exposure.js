// 노출도 (0~1): 자세 · 주변 식생 은폐 · 빛 — 4단계 적 시야 판정용
import { CONFIG } from '../config.js';
import { clamp, lerp, smoothstep } from '../core/math.js';

const SAMPLES = [[0, 0, 2], [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [0.7, 0.7, 1], [-0.7, 0.7, 1], [0.7, -0.7, 1], [-0.7, -0.7, 1]];

/**
 * @param {import('./HumanMotor.js').HumanMotor} motor
 * @param {import('../world/WorldQuery.js').WorldQuery} query
 * @param {{daylight:number, sunOffset:{x:number,z:number}}} light  현재 조명 상태
 */
export function computeExposure(motor, query, light) {
  const E = CONFIG.exposure;
  const S = CONFIG.stance;
  // 자세 (전환 중이면 보간)
  const k = smoothstep(0, 1, motor.stanceProgress);
  const stanceF = lerp(E.stance[motor.stanceFrom], E.stance[motor.stance], k);
  const bodyH = lerp(S.bodyHeight[motor.stanceFrom], S.bodyHeight[motor.stance], k) - motor.sink;

  // 주변 체적형 식생 은폐
  const r = E.coverRadius;
  let conceal = 0, wsum = 0;
  for (const [sx, sz, w] of SAMPLES) {
    conceal += query.coverConcealment(motor.position.x + sx * r * 0.6, motor.position.z + sz * r * 0.6, bodyH) * w;
    wsum += w;
  }
  conceal /= wsum;
  // 바로 옆 큰 줄기·대나무
  const clear = query.clearanceAt(motor.position.x, motor.position.z, motor.position.y + 1);
  if (clear < 0.8) conceal = Math.min(1, conceal + 0.15);

  // 빛: 캐노피 사이 햇빛 + 하늘빛 × 낮 밝기
  const sunCover = query.getCanopyCover(motor.position.x + light.sunOffset.x, motor.position.z + light.sunOffset.z);
  const skyCover = query.getCanopyCover(motor.position.x, motor.position.z);
  const sunLit = 1 - smoothstep(0.28, 0.82, sunCover);
  const lit = clamp((sunLit * 0.6 + (1 - skyCover * 0.7) * 0.4) * light.daylight, 0, 1);
  const lightF = lerp(E.lightMin, 1, lit);

  let exposure = stanceF * (1 - conceal * 0.9) * lightF;
  if (motor.ground.onDike) exposure += E.elevatedBonus;
  exposure += E.movingBonus * clamp(motor.speed / 3, 0, 1);
  return {
    value: clamp(exposure, 0, 1),
    stance: stanceF, concealment: conceal, light: lightF,
  };
}
