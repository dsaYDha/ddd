// 큰 나무(상층) 형태 변형 — 렌더링과 물리(판근 충돌)가 같은 데이터를 쓴다.
// 크기는 기준값이며 배치마다 scale 로 키운다.
export const BIG_TREE_VARIANTS = [
  {
    height: 30, trunkR: 0.62, crownR: 8.5, crownBase: 0.66,
    fins: [
      { a: 0.2, span: 2.4, h: 2.8 }, { a: 1.45, span: 1.9, h: 2.2 }, { a: 2.7, span: 2.7, h: 3.1 },
      { a: 3.95, span: 2.0, h: 2.3 }, { a: 5.15, span: 2.3, h: 2.7 },
    ],
  },
  {
    height: 34, trunkR: 0.76, crownR: 10, crownBase: 0.7,
    fins: [
      { a: 0.0, span: 2.9, h: 3.4 }, { a: 1.1, span: 2.2, h: 2.6 }, { a: 2.0, span: 2.6, h: 3.0 },
      { a: 3.2, span: 3.0, h: 3.5 }, { a: 4.3, span: 2.1, h: 2.4 }, { a: 5.3, span: 2.5, h: 2.9 },
    ],
  },
  {
    height: 26, trunkR: 0.5, crownR: 7.2, crownBase: 0.62,
    fins: [
      { a: 0.7, span: 1.9, h: 2.2 }, { a: 2.3, span: 2.2, h: 2.5 }, { a: 3.8, span: 1.7, h: 2.0 }, { a: 5.3, span: 2.0, h: 2.3 },
    ],
  },
];
