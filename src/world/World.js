// 월드 렌더링 조립 + 물리 질의(WorldQuery) 보관
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { WorldQuery } from './WorldQuery.js';
import { createTerrainMaterial, buildTerrain, buildOuterTerrain, outerHeight } from './TerrainMesh.js';
import { createWaterMaterial, buildWater, buildDikes } from './WaterMesh.js';
import { InstancedSystem, trsMatrix, capsuleMatrix } from './Vegetation.js';
import { BIG_TREE_VARIANTS } from './TreeVariants.js';
import * as VG from '../render/VegetationGeometry.js';
import * as TX from '../render/Textures.js';
import { patchCanopy, patchWind, patchWetness, shared } from '../render/Materials.js';
import { hashFloat } from '../core/rng.js';

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {object} data  generateWorld() 결과
   */
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.query = new WorldQuery(data);

    // ---- 텍스처
    const tex = {
      litter: TX.makeLeafLitterTexture(), dirt: TX.makeDirtTexture(), mud: TX.makeMudTexture(),
      grass: TX.makeGrassGroundTexture(), rock: TX.makeRockTexture(), bark: TX.makeBarkTexture(),
      noise: TX.makeNoiseTexture(), atlas: TX.makeLeafAtlas(),
    };
    this.textures = tex;

    // ---- 캐노피 맵 텍스처 (셰이더 조명용)
    const cN = data.cN;
    const cdata = new Uint8Array(cN * cN);
    for (let i = 0; i < cN * cN; i++) cdata[i] = Math.min(255, Math.round(data.canopy[i] * 255));
    const ctex = new THREE.DataTexture(cdata, cN, cN, THREE.RedFormat, THREE.UnsignedByteType);
    ctex.magFilter = THREE.LinearFilter;
    ctex.minFilter = THREE.LinearFilter;
    ctex.wrapS = ctex.wrapT = THREE.ClampToEdgeWrapping;
    ctex.needsUpdate = true;
    shared.uCanopyTex.value = ctex;
    shared.uCanopyInfo.value.set(data.half, data.size, 0, 0);

    // ---- 지형
    const terrainMat = createTerrainMaterial({
      splatData: data.splat, splatSize: data.sN,
      litter: tex.litter, dirt: tex.dirt, mud: tex.mud, grass: tex.grass, rock: tex.rock, noise: tex.noise,
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
    const M = this.materials = this._createMaterials(tex);

    // ---- 인스턴싱 (식생·장애물)
    const inst = this.instanced = new InstancedSystem(scene, { half: data.half + 80, chunkSize: CONFIG.world.chunkSize });
    const P = data.placements;
    const tint = (it, lo, hi, salt = 0) => {
      const k = lo + (hi - lo) * hashFloat(Math.round(it.x * 10), Math.round(it.z * 10), salt);
      return [k, k, k];
    };
    const tintGreen = (it, salt) => {
      const h = hashFloat(Math.round(it.x * 10), Math.round(it.z * 10), salt);
      const k = 0.82 + 0.3 * h;
      return [k * (0.95 + 0.12 * (1 - h)), k, k * (0.9 + 0.1 * h)];
    };

    // 큰 나무 (변형별)
    BIG_TREE_VARIANTS.forEach((V, v) => {
      const hi = VG.buildBigTree(v, 0), lo = VG.buildBigTree(v, 1);
      inst.addKind(`bigTree${v}`, P.bigTree.filter((t) => t.variant === v), [
        { maxDist: 'nearLodDistance', parts: [
          { geometry: hi.bark, material: M.bark, castShadow: true, receiveShadow: true },
          { geometry: hi.crown, material: M.crown },
          { geometry: hi.crownCards, material: M.crownCards },
        ] },
        { maxDist: 'viewDistance', parts: [
          { geometry: lo.bark, material: M.bark, castShadow: true, shadowQuality: 'high' },
          { geometry: lo.crown, material: M.crown },
          { geometry: lo.crownCards, material: M.crownCards },
        ] },
      ], {
        transform: (t, mm) => trsMatrix(mm, t.x, t.y, t.z, t.rot, t.scale),
        color: (t) => tint(t, 0.82, 1.12, 1), height: (t) => t.height,
      });
    });
    // 맵 바깥 지평선 나무
    const outer = this._outerTrees();
    const farTree = VG.buildBigTree(1, 1);
    inst.addKind('outerTrees', outer, [{ maxDist: 'viewDistance', parts: [
      { geometry: farTree.bark, material: M.bark }, { geometry: farTree.crown, material: M.crown },
    ] }], { transform: (t, mm) => trsMatrix(mm, t.x, t.y, t.z, t.rot, t.scale), color: (t) => tint(t, 0.75, 1.05, 2), height: () => 40 });

    // 야자수
    for (let v = 0; v < 2; v++) {
      const hi = VG.buildPalm(v, 0), lo = VG.buildPalm(v, 1);
      inst.addKind(`palm${v}`, P.palm.filter((p) => p.variant === v), [
        { maxDist: 'nearLodDistance', parts: [
          { geometry: hi.bark, material: M.bark, castShadow: true },
          { geometry: hi.palmLeaf, material: M.palmLeaf, castShadow: true },
        ] },
        { maxDist: 'smallDistance', parts: [
          { geometry: lo.bark, material: M.bark }, { geometry: lo.palmLeaf, material: M.palmLeaf },
        ] },
      ], { transform: (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, p.height / 8), color: (p) => tintGreen(p, 3), density: 'veg', height: (p) => p.height + 2 });
    }
    // 바나나
    for (let v = 0; v < 2; v++) {
      const hi = VG.buildBanana(v, 0), lo = VG.buildBanana(v, 1);
      inst.addKind(`banana${v}`, P.banana.filter((p) => p.variant === v), [
        { maxDist: 'nearLodDistance', parts: [
          { geometry: hi.stem, material: M.stem, castShadow: true },
          { geometry: hi.bananaLeaf, material: M.bananaLeaf, castShadow: true },
        ] },
        { maxDist: 'smallDistance', parts: [
          { geometry: lo.stem, material: M.stem }, { geometry: lo.bananaLeaf, material: M.bananaLeaf },
        ] },
      ], { transform: (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, p.height / 2.6), color: (p) => tintGreen(p, 4), density: 'veg', height: (p) => p.height + 1 });
    }
    // 대나무 (군락 + 동쪽 밀집 띠)
    for (let v = 0; v < 2; v++) {
      const hi = VG.buildBamboo(v, 0), lo = VG.buildBamboo(v, 1);
      const lods = [
        { maxDist: 'nearLodDistance', parts: [
          { geometry: hi.stem, material: M.bambooStem, castShadow: true },
          { geometry: hi.bambooLeaf, material: M.bambooLeaf, castShadow: true },
        ] },
        { maxDist: 'viewDistance', parts: [
          { geometry: lo.stem, material: M.bambooStem }, { geometry: lo.bambooLeaf, material: M.bambooLeaf },
        ] },
      ];
      const tf = (b, mm) => trsMatrix(mm, b.x, b.y, b.z, b.rot, b.radius, b.height / 12, b.radius);
      inst.addKind(`bamboo${v}`, P.bamboo.filter((b) => b.variant === v), lods, { transform: tf, color: (b) => tintGreen(b, 5), height: (b) => b.height });
      inst.addKind(`bambooDense${v}`, P.bambooDense.filter((b) => b.variant === v), lods, { transform: tf, color: (b) => tintGreen(b, 6), height: (b) => b.height });
    }
    // 어린 나무 (중하층)
    for (let v = 0; v < 3; v++) {
      const hi = VG.buildSapling(v, 0), lo = VG.buildSapling(v, 1);
      inst.addKind(`sapling${v}`, P.sapling.filter((p) => p.variant === v), [
        { maxDist: 'nearLodDistance', parts: [
          { geometry: hi.bark, material: M.bark, castShadow: true },
          { geometry: hi.saplingLeaf, material: M.saplingLeaf, castShadow: true, shadowQuality: 'high', receiveShadow: true },
        ] },
        { maxDist: 'smallDistance', parts: [
          { geometry: lo.bark, material: M.bark }, { geometry: lo.saplingLeaf, material: M.saplingLeaf },
        ] },
      ], { transform: (p, mm) => trsMatrix(mm, p.x, p.y, p.z, p.rot, p.height / 5), color: (p) => tintGreen(p, 15), density: 'veg', height: (p) => p.height });
    }
    // 고사리
    for (let v = 0; v < 3; v++) {
      const g = VG.buildFern(v);
      inst.addKind(`fern${v}`, P.fern.filter((f) => f.variant === v), [
        { maxDist: 'fernDistance', parts: [{ geometry: g.fernLeaf, material: M.fernLeaf, receiveShadow: true }] },
      ], { transform: (f, mm) => trsMatrix(mm, f.x, f.y, f.z, f.rot, f.height), color: (f) => tintGreen(f, 7), density: 'veg', height: () => 1.2 });
    }
    // 코끼리풀
    for (let v = 0; v < 3; v++) {
      const hi = VG.buildElephantGrass(v, 0), lo = VG.buildElephantGrass(v, 1);
      inst.addKind(`grass${v}`, P.grass.filter((g) => g.variant === v), [
        { maxDist: 'grassNear', parts: [{ geometry: hi.grass, material: M.grass, receiveShadow: true }] },
        { maxDist: 'grassDistance', parts: [{ geometry: lo.grassCard, material: M.grassCard }] },
      ], {
        transform: (g, mm) => trsMatrix(mm, g.x, g.y, g.z, g.rot, g.height / 1.75),
        color: (g) => tintGreen(g, 8), density: 'grass', height: (g) => g.height,
      });
    }
    // 덩굴·덤불
    for (let v = 0; v < 3; v++) {
      const g = VG.buildShrub(v);
      inst.addKind(`shrub${v}`, P.shrub.filter((s) => s.variant === v), [
        { maxDist: 'smallDistance', parts: [{ geometry: g.shrubLeaf, material: M.shrubLeaf, receiveShadow: true }] },
      ], { transform: (s, mm) => trsMatrix(mm, s.x, s.y, s.z, s.rot, s.height / 1.4), color: (s) => tintGreen(s, 9), density: 'grass', height: (s) => s.height });
    }
    // 모
    {
      const g = VG.buildRice();
      inst.addKind('rice', P.rice, [{ maxDist: 'grassDistance', parts: [{ geometry: g.rice, material: M.rice }] }], {
        transform: (r, mm) => trsMatrix(mm, r.x, r.y, r.z, r.rot, r.height / 0.5), color: (r) => tintGreen(r, 10), density: 'grass', height: () => 0.7,
      });
    }
    // 바위
    for (const r of P.rock) { r.x = r.cx; r.z = r.cz; r.y = r.cy; }
    for (let v = 0; v < 4; v++) {
      const hi = VG.buildRock(v, 0), lo = VG.buildRock(v, 1);
      inst.addKind(`rock${v}`, P.rock.filter((r) => r.variant === v), [
        { maxDist: 'nearLodDistance', parts: [{ geometry: hi, material: M.rock, castShadow: true, receiveShadow: true }] },
        { maxDist: 'smallDistance', parts: [{ geometry: lo, material: M.rock }] },
      ], { transform: (r, mm) => trsMatrix(mm, r.cx, r.cy, r.cz, -r.yaw, r.rx, r.ry, r.rz), color: (r) => tint(r, 0.8, 1.1, 11), height: (r) => r.ry * 2 });
    }
    // 통나무·뿌리
    for (const list of [P.log, P.root]) for (const s of list) { s.x = (s.ax + s.bx) / 2; s.z = (s.az + s.bz) / 2; s.y = (s.ay + s.by) / 2; s.rot ??= hashFloat(Math.round(s.x * 10), Math.round(s.z * 10), 12) * 6.28; }
    for (let v = 0; v < 2; v++) {
      const hi = VG.buildLog(v, 0), lo = VG.buildLog(v, 1);
      inst.addKind(`log${v}`, P.log.filter((l) => l.variant === v), [
        { maxDist: 'nearLodDistance', parts: [{ geometry: hi, material: M.log, castShadow: true, receiveShadow: true }] },
        { maxDist: 'smallDistance', parts: [{ geometry: lo, material: M.log }] },
      ], { transform: (s, mm) => capsuleMatrix(mm, s), color: (s) => tint(s, 0.8, 1.05, 13), height: () => 2 });
    }
    {
      const hi = VG.buildLog(2, 1);
      inst.addKind('root', P.root, [{ maxDist: 'smallDistance', parts: [{ geometry: hi, material: M.root, castShadow: true }] }], {
        transform: (s, mm) => capsuleMatrix(mm, s), color: (s) => tint(s, 0.75, 1.0, 14), height: () => 1,
      });
    }
  }

  _createMaterials(tex) {
    const M = {};
    M.bark = new THREE.MeshStandardMaterial({ map: tex.bark, vertexColors: true, roughness: 0.95 });
    patchCanopy(M.bark, { sun: 1, sky: 0.65 });
    patchWetness(M.bark, 0.8);
    M.crown = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchWind(M.crown, 0.35, 30, 0.5);
    const foliage = (amp, refH, freq, opts = {}) => {
      // 약한 자체발광 = 잎을 투과하는 빛 (역광에서 잎이 완전히 검게 죽지 않게)
      const mat = new THREE.MeshLambertMaterial({ map: tex.atlas, vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, emissive: 0x0b1206, ...opts });
      patchCanopy(mat, { sun: 1, sky: 0.6 });
      patchWind(mat, amp, refH, freq);
      return mat;
    };
    M.crownCards = foliage(0.35, 30, 0.5);
    M.palmLeaf = foliage(0.32, 8, 1.1);
    M.bananaLeaf = foliage(0.12, 2.6, 1.4);
    M.bambooLeaf = foliage(0.45, 12, 0.9);
    M.fernLeaf = foliage(0.05, 1, 1.8);
    M.saplingLeaf = foliage(0.14, 5, 1.2);
    M.shrubLeaf = foliage(0.06, 1.4, 1.6);
    M.grassCard = foliage(0.15, 2, 1.7);
    M.stem = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCanopy(M.stem, { sun: 1, sky: 0.6 });
    patchWind(M.stem, 0.03, 2.6, 1.4);
    M.bambooStem = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchCanopy(M.bambooStem, { sun: 1, sky: 0.6 });
    patchWind(M.bambooStem, 0.45, 12, 0.9);
    M.grass = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patchCanopy(M.grass, { sun: 1, sky: 0.55 });
    patchWind(M.grass, 0.16, 2, 1.7);
    M.rice = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patchCanopy(M.rice, { sun: 1, sky: 0.5 });
    patchWind(M.rice, 0.04, 0.5, 2.2);
    M.rock = new THREE.MeshStandardMaterial({ map: tex.rock, vertexColors: true, roughness: 0.85 });
    patchCanopy(M.rock, { sun: 1, sky: 0.7 });
    patchWetness(M.rock, 1);
    M.log = new THREE.MeshStandardMaterial({ map: tex.bark, vertexColors: true, roughness: 0.9 });
    patchCanopy(M.log, { sun: 1, sky: 0.7 });
    patchWetness(M.log, 1);
    M.root = new THREE.MeshStandardMaterial({ map: tex.bark, color: 0x8a7a66, vertexColors: true, roughness: 0.9 });
    patchCanopy(M.root, { sun: 1, sky: 0.7 });
    patchWetness(M.root, 1);
    return M;
  }

  _outerTrees() {
    const out = [];
    const half = this.data.half;
    for (let z = -half - 70; z <= half + 70; z += 13) {
      for (let x = -half - 70; x <= half + 70; x += 13) {
        const jx = x + (hashFloat(x, z, 21) - 0.5) * 10, jz = z + (hashFloat(x, z, 22) - 0.5) * 10;
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
    const s = { ...settings, grassNear: settings.grassDistance * 0.45 };
    this.instanced.setSettings(s);
  }

  setEnvMap(tex) {
    // 물과 젖은 지면(진흙 번들거림)이 하늘을 반사
    for (const [mat, k] of [[this.waterMaterial, 0.4], [this.terrainMaterial, 0.45]]) {
      mat.envMap = tex;
      mat.envMapIntensity = k;
      mat.needsUpdate = true;
    }
  }

  update(camera, force = false) {
    this.instanced.update(camera, force);
  }
}
