// F2 AI 디버그 시각화 — 병사마다 상태·역할·발견 수치·제압·사기 글자표 + 3D 선 (깊이 무시, 숲 너머로도 보임)
//  · 시야 부채꼴: 120° 시야 가장자리 (반경 14m), 중앙 60° 는 더 길게 (밝은 선)
//  · 추정 플레이어 위치 (기억): 십자 + 불확실성 원, 병사 → 추정 위치 선 (오래될수록 흐림)
//  · 경로: 남은 길 (A* 경로 점), 엄폐물: 숨는 점에 세운 막대
//  · 색: 순찰 초록 · 의심 노랑 · 경계 주황 · 교전 빨강 · 수색 하늘 · 매복 보라 · 후퇴/도주 회색
//  · 7단계 아군: 이름·역할·분대 상태 (평상 청록 / 교전 분홍), 따르는 명령 (이동·사격·대형·받고 기다리는 명령 수), 제압 60 이상이면 '명령 거부',
//    의무병 처치·업기·피로·갈증
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const STATE_COLOR = {
  patrol: [0.35, 0.85, 0.35], suspicious: [0.95, 0.85, 0.25], alert: [1.0, 0.55, 0.15], engaged: [1.0, 0.22, 0.18],
  search: [0.35, 0.75, 1.0], ambush: [0.75, 0.4, 1.0], retreat: [0.6, 0.6, 0.6], rout: [0.45, 0.45, 0.45],
};
const STATE_LABEL = {
  patrol: '순찰', suspicious: '의심', alert: '경계', engaged: '교전', search: '수색', ambush: '매복', retreat: '후퇴', rout: '도주',
};
const ROLE_LABEL = { leader: '분대장', rifleman: '소총수', mg: '기관총', flank: '기동조', point: '첨병' };
const ALLY_COLOR = { calm: [0.35, 0.9, 0.95], contact: [1.0, 0.45, 0.8] };
const JOB_LABEL = CONFIG.allies?.roleLabels ?? {};
const MOVE_LABEL = { follow: '따라옴', halt: '정지', hold: '대기', moveTo: '이동', retreat: '후퇴' };
const FIRE_LABEL = { free: '자유', hold: '금지', onMyShot: '내가 쏘면', suppress: '제압' };
const FORM_LABEL = { auto: '대형 자동', file: '일렬', wedge: '쐐기', spread: '산개' };
const MAX_VERTS = 22 * 220;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class AIDebug {
  constructor(scene, uiEl) {
    this.scene = scene;
    this.visible = false;
    const g = new THREE.BufferGeometry();
    this._pos = new Float32Array(MAX_VERTS * 3);
    this._col = new Float32Array(MAX_VERTS * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this._col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 30;
    this.lines.visible = false;
    scene.add(this.lines);
    uiEl.insertAdjacentHTML('beforeend', '<div id="aidebug"></div>');
    this.labelsEl = uiEl.querySelector('#aidebug');
    this._labels = new Map();   // 병사 → div
    this._v = new THREE.Vector3();
    this._n = 0;
  }

  toggle(v = !this.visible) {
    this.visible = v;
    this.lines.visible = v;
    this.labelsEl.style.display = v ? 'block' : 'none';
    return v;
  }

  /** @param {Array} soldiers  EnemyManager.soldiers  @param {THREE.Camera} camera */
  update(soldiers, camera, now) {
    if (!this.visible) return;
    this._n = 0;
    const seen = new Set();
    const W = window.innerWidth, H = window.innerHeight;
    for (const s of soldiers) {
      const st = s.squad?.state ?? 'patrol';
      const friend = s.faction === 'friend';
      const col = !s.alive ? [0.3, 0.3, 0.3] : friend ? (ALLY_COLOR[st] ?? ALLY_COLOR.calm) : (STATE_COLOR[st] ?? [1, 1, 1]);
      const e = s.eye, p = s.motor.position;
      if (s.alive) this._soldierLines(s, e, p, col, now);
      // 글자표
      seen.add(s);
      let el = this._labels.get(s);
      if (!el) { el = document.createElement('div'); el.className = 'ai-label'; this.labelsEl.appendChild(el); this._labels.set(s, el); }
      const dist = Math.hypot(e.x - camera.position.x, e.y - camera.position.y, e.z - camera.position.z);
      const v = this._v.set(e.x, e.y + 0.55, e.z).project(camera);
      if (v.z > 1 || v.z < -1 || dist > 160) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.transform = `translate(${((v.x + 1) / 2 * W).toFixed(0)}px, ${((1 - v.y) / 2 * H).toFixed(0)}px) translate(-50%, -100%)`;
      const c = `rgb(${col.map((k) => Math.round(k * 255)).join(',')})`;
      const role = ROLE_LABEL[s.isPoint && s.role === 'rifleman' ? 'point' : s.role] ?? s.role;
      const html = friend ? this._allyHtml(s, c, dist) : s.alive
        ? `<b style="color:${c}">#${s.id} ${esc(role)} · ${STATE_LABEL[st] ?? st}</b> <span class="m">${esc(s.mode)}${s.fire?.mode && s.fire.mode !== 'none' ? ' · 사격:' + s.fire.mode : ''}</span><br>`
          + `발견 ${s.perception.meter.toFixed(2)} · 제압 ${Math.round(s.suppression)} · 사기 ${Math.round(s.squad?.morale ?? 0)}`
          + ` · 탄 ${s.shooter.weapon.totalRounds}${s.injuries.wounds.length ? ' · 부상 ' + s.injuries.wounds.length : ''} · ${dist.toFixed(0)}m`
        : `<span style="color:#888">#${s.id} 사망</span>`;
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }
    for (const [s, el] of this._labels) if (!seen.has(s)) { el.remove(); this._labels.delete(s); }
    const g = this.lines.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, this._n);
  }

  /** 7단계 아군 글자표 */
  _allyHtml(s, c, dist) {
    if (!s.alive) return `<span style="color:#888">${esc(s.name)} 전사</span>`;
    const o = s.ord ?? {}, sup = Math.round(s.suppression);
    const st = s.squad?.state === 'contact' ? '교전' : '평상';
    const extra = [];
    if (s.pendingOrders?.length) extra.push(`받은 명령 ${s.pendingOrders.length}`);
    if (s.treat) extra.push(`처치 → ${esc(s.treat.patient?.name ?? '플레이어')}${s.treat.active ? ` ${(s.treat.t / Math.max(0.1, s.treat.duration) * 100).toFixed(0)}%` : ''}`);
    if (s.carry) extra.push(`업기 ${s.carry.phase}`);
    if (s.carriedBy) extra.push('업혀 감');
    if (s.give) extra.push('탄창 주러');
    if (s.hasRadio) extra.push('무전기');
    return `<b style="color:${c}">${esc(s.name)} ${esc(JOB_LABEL[s.job] ?? s.job)} · ${st}</b> <span class="m">${esc(s.mode)}${s.fire?.mode && s.fire.mode !== 'none' ? ' · 사격:' + s.fire.mode : ''}</span><br>`
      + `명령 ${MOVE_LABEL[o.move] ?? o.move}${o.prone ? '·엎드림' : ''} / 사격 ${FIRE_LABEL[o.fire] ?? o.fire} / ${FORM_LABEL[o.formation] ?? o.formation}`
      + ` · 제압 ${sup}${sup >= (CONFIG.ai.suppression?.pinned ?? 60) ? ' (명령 거부)' : ''}<br>`
      + `발견 ${s.perception.meter.toFixed(2)} · 탄 ${s.shooter.weapon.totalRounds}${s.injuries.wounds.length ? ' · 부상 ' + s.injuries.wounds.length + ' · 혈액 ' + Math.round(s.injuries.blood) : ''}`
      + ` · 피로 ${Math.round(s.endurance?.fatigue ?? 0)} · 갈증 ${Math.round(s.endurance?.thirst ?? 0)} · ${dist.toFixed(0)}m`
      + (extra.length ? `<br>${extra.join(' · ')}` : '');
  }

  clear() {
    for (const el of this._labels.values()) el.remove();
    this._labels.clear();
    this.lines.geometry.setDrawRange(0, 0);
  }

  // -------------------------------------------------------------
  _seg(ax, ay, az, bx, by, bz, c, k = 1) {
    if (this._n + 2 > MAX_VERTS) return;
    const P = this._pos, C = this._col;
    let i = this._n * 3;
    P[i] = ax; P[i + 1] = ay; P[i + 2] = az; C[i] = c[0] * k; C[i + 1] = c[1] * k; C[i + 2] = c[2] * k;
    i += 3;
    P[i] = bx; P[i + 1] = by; P[i + 2] = bz; C[i] = c[0] * k; C[i + 1] = c[1] * k; C[i + 2] = c[2] * k;
    this._n += 2;
  }

  _soldierLines(s, e, p, col, now) {
    const V = CONFIG.ai.vision;
    const y = e.y;
    // 시야 부채꼴
    const yaw = s.look.yaw;
    const half = (V.fovDeg / 2) * Math.PI / 180, cen = (V.centralDeg / 2) * Math.PI / 180;
    const R = 14, Rc = 22;
    const at = (a, r) => [e.x - Math.sin(yaw + a) * r, e.z - Math.cos(yaw + a) * r];
    for (const a of [-half, half]) { const [x, z] = at(a, R); this._seg(e.x, y, e.z, x, y, z, col, 0.55); }
    for (const a of [-cen, cen]) { const [x, z] = at(a, Rc); this._seg(e.x, y, e.z, x, y, z, col, 0.9); }
    const N = 10;
    for (let k = 0; k < N; k++) {
      const a0 = -half + (2 * half * k) / N, a1 = -half + (2 * half * (k + 1)) / N;
      const [x0, z0] = at(a0, R), [x1, z1] = at(a1, R);
      this._seg(x0, y, z0, x1, y, z1, col, 0.45);
    }
    // 발견 수치 막대 (머리 위, 0~1)
    const m = Math.min(1.5, s.perception.meter);
    if (m > 0.01) this._seg(e.x, y + 0.35, e.z, e.x, y + 0.35 + m * 0.8, e.z, m >= 1 ? [1, 0.2, 0.2] : [1, 0.9, 0.3]);
    // 기억 (추정 플레이어 위치)
    const mem = s.memory;
    if (mem?.valid) {
      const age = now - mem.time;
      const k = Math.max(0.25, 1 - age / 30);
      const my = p.y + 1;
      this._seg(e.x, y, e.z, mem.x, my, mem.z, [1, 0.3, 0.9], 0.6 * k);
      this._seg(mem.x - 0.6, my, mem.z, mem.x + 0.6, my, mem.z, [1, 0.3, 0.9], k);
      this._seg(mem.x, my, mem.z - 0.6, mem.x, my, mem.z + 0.6, [1, 0.3, 0.9], k);
      const u = Math.min(30, mem.uncertainty || 0);
      if (u > 0.5) {
        for (let i = 0; i < 16; i++) {
          const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 1) / 16) * Math.PI * 2;
          this._seg(mem.x + Math.cos(a0) * u, my, mem.z + Math.sin(a0) * u, mem.x + Math.cos(a1) * u, my, mem.z + Math.sin(a1) * u, [1, 0.3, 0.9], 0.45 * k);
        }
      }
    }
    // 경로
    const path = s.path;
    if (path && path.length) {
      let px = p.x, pz = p.z;
      for (let i = Math.max(0, s.pathIdx ?? 0); i < path.length; i++) {
        const q = path[i];
        this._seg(px, p.y + 0.15, pz, q.x, p.y + 0.15, q.z, [0.9, 0.9, 0.9], 0.6);
        px = q.x; pz = q.z;
      }
    } else if (s.goal && !s.goal.done) {
      this._seg(p.x, p.y + 0.15, p.z, s.goal.x, p.y + 0.15, s.goal.z, [0.9, 0.9, 0.9], 0.4);
    }
    // 엄폐물
    const c = s.cover;
    if (c && Number.isFinite(c.hideX)) this._seg(c.hideX, p.y, c.hideZ, c.hideX, p.y + 1.6, c.hideZ, c.kind === 'hard' ? [0.4, 1, 0.6] : [0.6, 0.8, 0.4]);
  }
}
