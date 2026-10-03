// 월드 데이터 공용 상수 (WorldGen ↔ Flora 순환 참조를 피하려고 분리)
export const NO_WATER = -10000;
// 지면 셀의 식생 종류 — 지피층 렌더링·식물 배치·은폐 판단이 같은 값을 쓴다
export const VEG = Object.freeze({ NONE: 0, COVER: 1, SHRUB: 2, THICKET: 3, GRASS: 4, REED: 5, BANK: 6, LITTER: 7 });
