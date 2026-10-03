// 월드 렌더링 조립 + 물리 질의(WorldQuery) 보관
//  층: 교목(판근 큰 나무) / 아교목(야자·대나무·나무고사리·어린 나무) / 관목(덤불·토란·바나나·등나무·코끼리풀)
//      / 지피(플레이어 주변 동적) + 리아나·덩굴 벽·통나무·바위·뿌리
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { WorldQuery } from './WorldQuery.js';
import { createTerrainMaterial, buildTerrain, buildOuterTerrain, outerHeight, updateTerrainLod } from './TerrainMesh.js';
import { createWaterMaterial, buildWater, buildDikes } from './WaterMesh.js';
import { InstancedSystem, trsMatrix, capsuleMatrix } from './Vegetation.js';
import { GroundCover } from './GroundCover.js';
import { buildBigTree } from '../render/TreeBuilder.js';
import * as PG from '../render/PlantGeometry.js';
import { buildLog, buildLogDetails, buildRock } from '../render/ObstacleGeometry.js';
import * as TX from '../render/Textures.js';
import { patchCanopy, patchFoliage, patchMoss, patchWetness, addPatch, createFoliageMaterial, shared } from '../render/Materials.js';
import { hashFloat } from '../core/rng.js';

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {object} data  generateWorld() 결과
   * @param {{antialias?: boolean, onProgress?: Function}} opts
   */
  constructor(scene, data, opts = {}) {
    this.scene = scene;
    this.data = data;
    this.query = new WorldQuery(data);
    const progress = opts.onProgress || (() => {});

    // ---- 텍스처
    progress(0, '텍스처 그리는 중…');
    const bark = TX.makeBarkTextures(), rock = TX.makeRockTextures();
    const tex = {
      litter: TX.makeLeafLitterTexture(), dirt: TX.makeDirtTexture(), mud: TX.makeMudTexture(),
      cover: TX.makeGroundCoverTexture(), soil: TX.makeSoilTexture(), detailNormal: TX.makeGroundDetailNormal(),
      rock: rock.map, rockNormal: rock.normalMap, bark: bark.map, barkNormal: bark.normalMap, wood: TX.makeWoodTexture(),
      noise: TX.makeNoiseTexture(), atlas: TX.makeLeafAtlas(), fleck: TX.makeSunfleckTexture(),
    };
    this.textures = tex;
    shared.uNoiseTex.value = tex.noise;
    shared.uFleckTex.value = tex.fleck;

    // ---- 캐노피·차폐 텍스처 (0.5m): R 캐노피 덮임, G 바닥 차폐, B 캐노피 꼭대기 높이
    {
      const { sN, cN } = data;
      const buf = new Uint8Array(sN * sN * 4);
      for (let j = 0; j < sN; j++) {
        for (let i = 0; i < sN; i++) {
          const k = j * sN + i, c = (j >> 1) * cN + (i >> 1);
          buf[k * 4] = Math.min(255, Math.round(data.canopy[c] * 255));
          buf[k * 4 + 1] = data.ao[k];
          const top = data.canopyHigh[c];
          buf[k * 4 + 2] = top < -100 ? 0 : Math.max(1, Math.min(255, Math.round(((top + 20) / 100) * 255)));
          buf[k * 4 + 3] = 255;
        }
      }
      const ctex = new THREE.DataTexture(buf, sN, sN, THREE.RGBAFormat, THREE.UnsignedByteType);
      ctex.magFilter = THREE.LinearFilter;
      ctex.minFilter = THREE.LinearFilter;
      ctex.wrapS = ctex.wrapT = THREE.ClampToEdgeWrapping;
      ctex.needsUpdate = true;
      shared.uCanopyTex.value = ctex;
      shared.uCanopyInfo.value.set(data.half, data.size, 0, 0);
    }

    // ---- 지형
    progress(0.25, '지형 메시…');
    const terrainMat = createTerrainMaterial({
      splatData: data.splat, splatSize: data.sN,
      litter: tex.litter, dirt: tex.dirt, mud: tex.mud, cover: tex.cover, soil: tex.soil, rock: tex.rock,
      noise: tex.noise, detailNormal: tex.detailNormal,
    });
    this.terrainMaterial = terrainMat;
    this.terrain = buildTerrain(data, terrainMat);
    scene.add(this.terrain);
    this.outerTerrain = buildOuterTerrain(data, terrainMat);
    scene.add(this.outerTerrain);

    // ---- 물·논둑
    this.waterMaterial = createWaterMaterial(tex.noise);
    this.water = buildWater(data, this.waterMaterial);
    scene.add(this.water);
    this.dikes = buildDikes(data, tex);
    scene.add(this.dikes);

    // ---- 머티리얼
    const M = this.materials = this._createMaterials(tex, !!opts.antialias);

    // ---- 인스턴싱 (식생·장애물)
    progress(0.4, '나무·식물 만드는 중…');
    const inst = this.instanced = new InstancedSystem(scene, { half: data.half + 80, chunkSize: CONFIG.world.chunkSize });
    const P = data.placements;
    const tint = (it, lo, hi, salt = 0) => {
      const k = lo + (hi - lo) * hashFloat(Math.round(it.x * 10), Math.round(it.z * 10), salt);
      return [k, k, k];
    };
    const tintGreen = (it, salt) => {
      const h = hashFloat(Math.round(it.x * 10), Math.round(it.z * 10), salt);
      const k = 0.84 + 0.28 * h;
      return [k * (0.96 + 0.12 * (1 - h)), k, k * (0.9 + 0.1 * h)];
    };
    const byVariant = (list, v) => list.filter((p) => p.variant === v);
    const part = (geometry, material, o = {}) => (geometry ? { geometry, material, ...o } : null);
    const lodOf = (maxDist, ...parts) => ({ maxDist, parts: parts.filter(Boolean) });

    // 큰 나무 (변형별 3단계 LOD) — 수관 잎은 그림자를 드리우지 않음 (햇빛 얼룩이 대신함)
    for (let v = 0; v < 5; v++) {
      const g0 = buildBigTree(v, 0), g1 = buildBigTree(v, 1), g2 = buildBigTree(v, 2);
      inst.addKind(`bigTree${v}`, byVariant(P.bigTree, v), [
        lodOf('treeNear', part(g0.bark, M.bark, { castShadow: true, receiveShadow: true }), part(g0.leaves, M.leaves, { receiveShadow: true })),
        lodOf('treeMid', part(g1.bark, M.bark, { castShadow: true, shadowQuality: 'high' }), part(g1.leaves, M.leaves)),
        lodOf('viewDistance', part(g2.bark, M.bark), part(g2.leaves, M.leaves)),
      ], {
        transform: (t, mm) => trsMatrix(mm, t.x, t.y, t.z, t.rot, t.scale, t.scale, t.scale, t.tilt[0], t.tilt[1]),
        color: (t) => tint(t, 0.82, 1.12, 1), height: (t) => t.height,
      });
      if (v === 1) this._farTree = g2;
    }
    // 중층 나무 (같은 변형을 작게 — 가까이도 중간 단계 지오메트리로 충분)
    for (let v = 0; v < 5; v++) {
      const g1 = buildBigTree(v, 1), g2 = buildBigTree(v, 2);
      inst.addKind(`midTree${v}`, byVariant(P.midTree, v), [
        lodOf('smallDistance', part(g1.bark, M.bark, { castShadow: true, receiveShadow: true }), part(g1.leaves, M.leaves, { receiveShadow: true })),
        lodOf('viewDistance', part(g2.bark, M.bark), part(g2.leaves, M.leaves)),
      ], {
        transform: (t, mm) => trsMatrix(mm, t.x, t.y, t.z, t.rot, t.scale, t.scale, t.scale, t.tilt[0], t.tilt[1]),
        color: (t) => tint(t, 0.85, 1.12, 26), height: (t) => t.height,
      });
    }
    // 맵 바깥 지평선 나무
    inst.addKind('outerTrees', this._outerTrees(), [lodOf('outerDistance', part(this._farTree.bark, M.bark), part(this._farTree.leaves, M.leaves))],
      { transform: (t, mm) => trsMatrix(mm, t.x, t.y, t.z, t.rot, t.scale), color: (t) => tint(t, 0.75, 1.05, 2), height: () => 40 });

    progress(0.55, '하층 식물…');
    const twoLod = (name, list, variants, build, near, far, tf, o = {}) => {
      for (let v = 0; v < variants; v++) {
        const g0 = build(v, 0), g1 = build(v, 1);
        const p0 = [], p1 = [];
        for (const [key, mat] of [['bark', M.bark], ['leaves', M.leaves], ['stem', M.stem]]) {
          if (g0[key]) p0.push(part(g0[key], mat, { castShadow: !!o.shadow, shadowQuality: o.shadowQuality, receiveShadow: key !== 'bark' || !!o.shadow }));
          if (g1[key]) p1.push(part(g1[key], mat));
        }
        inst.addKind(`${name}${v}`, byVariant(list, v), [lodOf(near, ...p0), lodOf(far, ...p1)], {
          transform: tf, color: (p) => tintGreen(p, o.salt ?? v), density: o.density, height: o.height || ((p) => p.height),
        });
      }
    };
    const scaled = (base) => (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, p.height / base);
    twoLod('palm', P.palm, 2, PG.buildPalm, 'nearLodDistance', 'treeMid', scaled(8), { shadow: true, density: 'veg', salt: 3, height: (p) => p.height + 2 });
    twoLod('banana', P.banana, 2, PG.buildBanana, 'nearLodDistance', 'smallDistance', scaled(2.6), { shadow: true, density: 'veg', salt: 4, height: (p) => p.height + 1 });
    const bambooTf = (b, mm) => trsMatrix(mm, b.x, b.y, b.z, b.rot, b.radius, b.height / 12, b.radius);
    twoLod('bamboo', P.bamboo, 2, PG.buildBamboo, 'nearLodDistance', 'viewDistance', bambooTf, { shadow: true, salt: 5 });
    // 동쪽 밀집 대나무 띠: 멀리서는 아주 단순한 단계 (안개 속 벽)
    for (let v = 0; v < 2; v++) {
      const g0 = PG.buildBamboo(v, 0), g1 = PG.buildBamboo(v, 1), g2 = PG.buildBamboo(v, 2);
      inst.addKind(`bambooDense${v}`, byVariant(P.bambooDense, v), [
        lodOf('nearLodDistance', part(g0.stem, M.stem), part(g0.leaves, M.leaves)),
        lodOf('smallDistance', part(g1.stem, M.stem), part(g1.leaves, M.leaves)),
        lodOf('viewDistance', part(g2.stem, M.stem), part(g2.leaves, M.leaves)),
      ], { transform: bambooTf, color: (p) => tintGreen(p, 6), height: (b) => b.height });
    }
    twoLod('sapling', P.sapling, 3, PG.buildSapling, 'nearLodDistance', 'smallDistance', scaled(5), { shadow: true, shadowQuality: 'high', density: 'veg', salt: 15 });
    twoLod('treeFern', P.treeFern, 2, PG.buildTreeFern, 'nearLodDistance', 'smallDistance', scaled(4), { shadow: true, density: 'veg', salt: 16, height: (p) => p.height + 0.6 });
    twoLod('shrub', P.shrub, 3, PG.buildShrub, 'shrubNear', 'shrubDistance', scaled(1.4), { density: 'grass', salt: 9 });
    twoLod('taro', P.taro, 2, PG.buildTaro, 'shrubNear', 'shrubDistance', scaled(1.3), { density: 'grass', salt: 17 });
    twoLod('rattan', P.rattan, 2, PG.buildRattan, 'shrubNear', 'shrubDistance', scaled(2.6), { density: 'grass', salt: 18 });
    twoLod('grass', P.grass, 3, PG.buildElephantGrass, 'grassNear', 'grassDistance', scaled(1.75), { density: 'grass', salt: 8 });
    twoLod('reed', P.reed, 2, PG.buildReed, 'grassNear', 'grassDistance', scaled(1.8), { density: 'grass', salt: 19 });
    twoLod('vineWall', P.vineWall, 2, PG.buildVineWall, 'nearLodDistance', 'smallDistance',
      (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, 1, p.height / 4, 1), { salt: 20 });
    for (let v = 0; v < 2; v++) {
      const g = PG.buildWaterPlant(v);
      inst.addKind(`waterPlant${v}`, byVariant(P.waterPlant, v), [lodOf('grassDistance', part(g.leaves, M.leaves))],
        { transform: (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, p.height), color: (p) => tintGreen(p, 21), density: 'grass', height: () => 0.8 });
    }
    {
      const g0 = PG.buildRice(0), g1 = PG.buildRice(1);
      inst.addKind('rice', P.rice, [lodOf('grassNear', part(g0.stem, M.stem)), lodOf('grassDistance', part(g1.leaves, M.leaves))], {
        transform: (r, mm) => trsMatrix(mm, r.x, r.y, r.z, r.rot, r.height / 0.5), color: (r) => tintGreen(r, 10), density: 'grass', height: () => 0.7,
      });
    }

    progress(0.75, '통나무·바위·덩굴…');
    // 바위
    for (const r of P.rock) { r.x = r.cx; r.z = r.cz; r.y = r.cy; }
    for (let v = 0; v < 4; v++) {
      const hi = buildRock(v, 0), lo = buildRock(v, 1);
      inst.addKind(`rock${v}`, byVariant(P.rock, v), [
        lodOf('nearLodDistance', part(hi, M.rock, { castShadow: true, receiveShadow: true })),
        lodOf('smallDistance', part(lo, M.rock, { receiveShadow: true })),
      ], { transform: (r, mm) => trsMatrix(mm, r.cx, r.cy, r.cz, -r.yaw, r.rx, r.ry, r.rz), color: (r) => tint(r, 0.8, 1.1, 11), height: (r) => r.ry * 2 });
    }
    // 통나무·뿌리
    for (const list of [P.log, P.root]) for (const s of list) { s.x = (s.ax + s.bx) / 2; s.z = (s.az + s.bz) / 2; s.y = (s.ay + s.by) / 2; s.rot ??= hashFloat(Math.round(s.x * 10), Math.round(s.z * 10), 12) * 6.28; }
    for (let v = 0; v < 3; v++) {
      const hi = buildLog(v, 0), lo = buildLog(v, 1);
      inst.addKind(`log${v}`, byVariant(P.log, v), [
        lodOf('nearLodDistance', part(hi, M.log, { castShadow: true, receiveShadow: true })),
        lodOf('smallDistance', part(lo, M.log, { receiveShadow: true })),
      ], { transform: (s, mm) => capsuleMatrix(mm, s), color: (s) => tint(s, 0.8, 1.05, 13), height: () => 2 });
    }
    {
      const g = buildLog(3, 0);
      inst.addKind('root', P.root, [lodOf('smallDistance', part(g, M.bark, { castShadow: true, receiveShadow: true }))], {
        transform: (s, mm) => capsuleMatrix(mm, s), color: (s) => tint(s, 0.7, 0.95, 14), height: () => 1,
      });
    }
    // 통나무의 버섯 (월드 좌표로 합친 메시)
    const fungi = buildLogDetails(P.log);
    if (fungi) {
      this.logDetails = new THREE.Mesh(fungi, M.log);
      this.logDetails.receiveShadow = true;
      this.logDetails.name = 'logDetails';
      scene.add(this.logDetails);
    }
    // 리아나 (100m 청크로 합친 메시)
    this.lianaChunks = [];
    {
      const groups = new Map();
      for (const l of P.liana) {
        const key = `${Math.floor((l.x + data.half) / 100)}_${Math.floor((l.z + data.half) / 100)}`;
        (groups.get(key) || groups.set(key, []).get(key)).push(l);
      }
      let seed = 1;
      for (const list of groups.values()) {
        const g = PG.buildLianas(list, 77 + seed++);
        const group = new THREE.Group();
        if (g.bark) { const m = new THREE.Mesh(g.bark, M.bark); m.castShadow = true; m.receiveShadow = true; group.add(m); }
        if (g.leaves) { const m = new THREE.Mesh(g.leaves, M.leaves); m.customDepthMaterial = M.leaves.userData.depthMaterial; group.add(m); }
        const cx = list.reduce((a, l) => a + l.x, 0) / list.length, cz = list.reduce((a, l) => a + l.z, 0) / list.length;
        group.userData.center = new THREE.Vector2(cx, cz);
        group.name = 'lianas';
        scene.add(group);
        this.lianaChunks.push(group);
      }
    }

    // ---- 지피층 (동적)
    progress(0.9, '지피식물…');
    this.groundCover = new GroundCover(scene, data, this.query, M.groundCover, PG.buildGroundCoverSpecies());
  }

  _createMaterials(tex, antialias) {
    const M = {};
    M.bark = new THREE.MeshStandardMaterial({
      map: tex.bark, normalMap: tex.barkNormal, normalScale: new THREE.Vector2(1.1, 1.1), vertexColors: true, roughness: 0.93,
    });
    patchCanopy(M.bark, { sun: 1, sky: 0.65 });
    patchMoss(M.bark, { top: 0.35 });
    patchWetness(M.bark, 0.8);
    M.leaves = createFoliageMaterial(tex.atlas, { alphaToCoverage: antialias, translucency: 1, sky: 0.6 });
    M.groundCover = createFoliageMaterial(tex.atlas, { alphaToCoverage: antialias, translucency: 0.8, sky: 0.6 });
    M.stem = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patchCanopy(M.stem, { sun: 1, sky: 0.6 });
    patchFoliage(M.stem, { translucency: 0.6 });
    // 풀잎·줄기: 가운데 잎맥이 밝고 가장자리가 어두운 결 (UV 기준, 텍스처 없이)
    addPatch(M.stem, 'stemShade', (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vStemUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vStemUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vStemUv;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float across = abs( fract( vStemUv.x ) - 0.5 ) * 2.0;
    float rib = 1.0 - smoothstep( 0.0, 0.18, across );
    float streak = 0.92 + 0.08 * sin( vStemUv.x * 37.0 + vStemUv.y * 3.0 );
    diffuseColor.rgb *= ( 0.8 + 0.22 * ( 1.0 - across ) + 0.12 * rib ) * streak;
  }`);
    });
    const stemDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patchFoliage(stemDepth, { depthOnly: true });
    M.stem.userData.depthMaterial = stemDepth;
    // 바위: 월드 좌표 삼면 투영 (늘어난 배치에서도 무늬가 늘어나지 않음)
    M.rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
    addPatch(M.rock, 'rockTri', (shader) => {
      shader.uniforms.uRockMap = { value: tex.rock };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uRockMap;')
        .replace('#include <map_fragment>', `
  {
    vec3 rn = normalize( vPatchNormalW );
    vec3 rw = pow( abs( rn ), vec3( 4.0 ) ); rw /= rw.x + rw.y + rw.z;
    vec3 rp = vPatchWorld * 0.42;
    vec3 rc = texture2D( uRockMap, rp.zy ).rgb * rw.x + texture2D( uRockMap, rp.xz ).rgb * rw.y + texture2D( uRockMap, rp.xy ).rgb * rw.z;
    diffuseColor.rgb *= rc;
  }`);
    });
    patchCanopy(M.rock, { sun: 1, sky: 0.7 });
    patchMoss(M.rock, { top: 0.8 });
    patchWetness(M.rock, 1);
    M.log = new THREE.MeshStandardMaterial({ map: tex.bark, normalMap: tex.barkNormal, vertexColors: true, roughness: 0.9 });
    patchCanopy(M.log, { sun: 1, sky: 0.7 });
    patchMoss(M.log, { top: 1.0, log: true, wood: tex.wood });
    patchWetness(M.log, 1);
    return M;
  }

  _outerTrees() {
    const out = [];
    const half = this.data.half;
    for (let z = -half - 70; z <= half + 70; z += 13) {
      for (let x = -half - 70; x <= half + 70; x += 13) {
        const jx = x + (hashFloat(x, z, 21) - 0.5) * 9, jz = z + (hashFloat(x, z, 22) - 0.5) * 9;
        const out2 = Math.max(Math.abs(jx) - half, Math.abs(jz) - half);
        if (out2 < 6) continue;
        const y = outerHeight(this.data, jx, jz);
        if (y < 0) continue; // 강
        out.push({ x: jx, z: jz, y: y - 0.5, rot: hashFloat(x, z, 23) * 6.28, scale: 0.8 + 0.4 * hashFloat(x, z, 24), rank: hashFloat(x, z, 25) });
      }
    }
    return out;
  }

  setQuality(settings) {
    const s = {
      ...settings,
      shrubNear: settings.shrubDistance * 0.42,
      grassNear: settings.grassDistance * 0.42,
      outerDistance: settings.viewDistance + 120,
    };
    this.settings = s;
    this.instanced.setSettings(s);
    this.groundCover.setSettings(s);
  }

  setEnvMap(tex) {
    // 물과 젖은 지면(진흙 번들거림)이 하늘을 반사
    for (const [mat, k] of [[this.waterMaterial, 0.4], [this.terrainMaterial, 0.45]]) {
      mat.envMap = tex;
      mat.envMapIntensity = k;
      mat.needsUpdate = true;
    }
  }

  /** 화면 통계 (디버그 오버레이) */
  get stats() {
    const v = this.instanced.stats;
    return { drawn: v.drawn, instances: v.instances, groundCover: this.groundCover.stats.instances };
  }

  update(camera, force = false) {
    this.instanced.update(camera, force);
    this.groundCover.update(camera.position, force);
    if (this.settings) updateTerrainLod(this.terrain, camera.position, this.settings.terrainNear ?? 60, this.settings.viewDistance + 80);
    if (this.settings) {
      const far = this.settings.viewDistance + 60;
      for (const g of this.lianaChunks) g.visible = g.userData.center.distanceTo({ x: camera.position.x, y: camera.position.z }) < far;
    }
  }
}
