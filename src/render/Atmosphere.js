// 대기: 하늘, 해(그림자), 반구광, 높이 안개, 시간대·날씨 전환, 비, 캐노피 사이로 새는 빛줄기
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { shared } from './Materials.js';
import { clamp, lerp } from '../core/math.js';

const DEG = Math.PI / 180;

function presetState(tod, weather) {
  const T = CONFIG.timeOfDay.presets[tod];
  const W = CONFIG.weather.presets[weather];
  const gray = W.skyGray;
  const toGray = (c, k, g = 0.5) => {
    const l = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
    return c.map((v) => lerp(v, l * g / 0.5 * 0.9, k));
  };
  return {
    sunElevation: T.sunElevation, sunAzimuth: T.sunAzimuth,
    sunColor: T.sunColor.slice(), sunIntensity: T.sunIntensity * W.sunMul,
    skyColor: toGray(T.skyColor, gray * 0.7), groundColor: T.groundColor.slice(),
    hemiIntensity: T.hemiIntensity * (1 - gray * 0.35),
    fogColor: toGray(T.fogColor, gray * 0.6, 0.45), fogDensity: T.fogDensity + W.fogAdd, mist: T.mist * (1 + gray * 0.5),
    skyTop: toGray(T.skyTop, gray * 0.9, 0.4), skyHorizon: toGray(T.skyHorizon, gray * 0.85, 0.45),
    exposure: T.exposure, overcast: gray, rain: W.rain,
    wind: 0.25 + W.rain * 0.75,
    shafts: (tod === 'dawn' ? 0.55 : tod === 'noon' ? 0.22 : 0.4) * (1 - gray),
  };
}

function lerpState(a, b, t) {
  const out = {};
  for (const k of Object.keys(b)) {
    if (Array.isArray(b[k])) out[k] = b[k].map((v, i) => lerp(a[k][i], v, t));
    else out[k] = lerp(a[k], b[k], t);
  }
  // 방위각은 짧은 쪽으로
  let da = b.sunAzimuth - a.sunAzimuth;
  if (da > 180) da -= 360; if (da < -180) da += 360;
  out.sunAzimuth = a.sunAzimuth + da * t;
  return out;
}

export class Atmosphere {
  constructor(scene, renderer, data, query) {
    this.scene = scene;
    this.renderer = renderer;
    this.data = data;
    this.query = query;
    this.tod = CONFIG.defaults.timeOfDay;
    this.weather = CONFIG.defaults.weather;
    this.state = presetState(this.tod, this.weather);
    this.target = this.state;
    this.wetness = CONFIG.weather.presets[this.weather].wetness;
    this.rainIntensity = this.state.rain;
    this.sunDir = new THREE.Vector3();
    this.settings = null;
    this._envDirty = true;
    this._envTimer = 0;

    // 하늘 돔
    this.skyUniforms = {
      topColor: { value: new THREE.Color() }, horizonColor: { value: new THREE.Color() },
      fogColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() },
      sunColor: { value: new THREE.Color() }, overcast: { value: 0 }, haze: { value: 0 },
    };
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize( position );
          vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 topColor, horizonColor, fogColor, sunColor, sunDir;
        uniform float overcast, haze;
        varying vec3 vDir;
        void main() {
          float h = clamp( vDir.y, -0.2, 1.0 );
          vec3 col = mix( horizonColor, topColor, pow( max( h, 0.0 ), 0.55 ) );
          float sd = max( dot( vDir, sunDir ), 0.0 );
          col += sunColor * ( pow( sd, 900.0 ) * 6.0 * ( 1.0 - overcast ) + pow( sd, 12.0 ) * 0.35 * ( 1.0 - overcast * 0.6 ) );
          // 지평선 근처는 안개 색으로
          col = mix( col, fogColor, clamp( haze * ( 1.0 - smoothstep( -0.05, 0.35, h ) ), 0.0, 1.0 ) );
          col = mix( col, fogColor, smoothstep( 0.02, -0.2, h ) );
          gl_FragColor = vec4( col, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(380, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // 빛
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x333322, 1);
    scene.add(this.hemi);

    scene.fog = new THREE.Fog(0x999999, 0.02, 0.0); // near=밀도, far=저지대 안개량 (Materials.js 참고)

    this._buildRain();
    this._buildShafts();
    this._applyState();
  }

  setSettings(settings) {
    this.settings = settings;
    const s = this.sun.shadow;
    this.sun.castShadow = settings.shadows;
    if (settings.shadows) {
      if (s.mapSize.x !== settings.shadowMapSize) {
        s.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
        if (s.map) { s.map.dispose(); s.map = null; }
      }
      const r = settings.shadowRadius;
      Object.assign(s.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 260 });
      s.camera.updateProjectionMatrix();
    }
    this.rain.geometry.setDrawRange(0, settings.rainDrops * 2);
    this.shafts.visible = settings.lightShafts;
    this.scene.fog.far = this.state.mist;
  }

  setTimeOfDay(key, instant = false) {
    this.tod = key;
    this._retarget(instant);
  }

  setWeather(key, instant = false) {
    this.weather = key;
    if (instant) this.wetness = CONFIG.weather.presets[key].wetness;
    this._retarget(instant);
  }

  _retarget(instant) {
    this.target = presetState(this.tod, this.weather);
    this._from = { ...this.state };
    this._t = instant ? 1 : 0;
    if (instant) { this.state = this.target; this.rainIntensity = this.target.rain; }
    this._envDirty = true;
    this._applyState();
  }

  /** 맑음 기준 0, 폭우 1 */
  get wetFactor() {
    const base = CONFIG.weather.presets.clear.wetness;
    return clamp((this.wetness - base) / (1 - base), 0, 1);
  }

  update(dt, focus, camera) {
    // 전환
    if (this._t < 1) {
      this._t = Math.min(1, this._t + dt / 4);
      const k = this._t * this._t * (3 - 2 * this._t);
      this.state = lerpState(this._from, this.target, k);
      if (this._t >= 1) this._envDirty = true;
    }
    // 비 강도 (조금 더 천천히)
    this.rainIntensity += (this.target.rain - this.rainIntensity) * (1 - Math.exp(-CONFIG.weather.transitionRate * dt));
    // 젖음도: 비가 오면 오르고, 그치면 천천히 마름
    const wTarget = CONFIG.weather.presets[this.weather].wetness;
    if (this.wetness < wTarget) this.wetness = Math.min(wTarget, this.wetness + CONFIG.weather.wettingRate * (0.4 + this.rainIntensity) * dt);
    else this.wetness = Math.max(wTarget, this.wetness - CONFIG.weather.dryingRate * dt);

    this.query.wetness = this.wetness;
    this.query.rainIntensity = this.rainIntensity;
    shared.uWetness.value = this.wetFactor * 0.85 + 0.1;
    shared.uRain.value = this.rainIntensity;
    shared.uTime.value += dt;
    this._applyState();

    // 하늘 돔·그림자 카메라는 플레이어를 따라감
    this.sky.position.copy(camera.position);
    const r = this.settings ? this.settings.shadowRadius : 30;
    const texel = (2 * r) / (this.settings ? this.settings.shadowMapSize : 1024);
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 120, focus.y + this.sunDir.y * 120, fz + this.sunDir.z * 120);

    // 비
    const ru = this.rain.material.uniforms;
    ru.uCam.value.copy(camera.position);
    ru.uTime.value = shared.uTime.value;
    ru.uIntensity.value = this.rainIntensity;
    this.rain.visible = this.rainIntensity > 0.01;

    // 빛줄기
    if (this.shafts.visible) this._updateShafts(focus);

    // 환경맵 (물 반사) — 전환이 끝나면 다시 굽기
    if (this._envDirty) {
      this._envTimer -= dt;
      if (this._envTimer <= 0) { this._bakeEnv(); this._envDirty = false; this._envTimer = 0.5; }
    }
  }

  _applyState() {
    const s = this.state;
    const el = s.sunElevation * DEG, az = s.sunAzimuth * DEG;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    this.sun.color.setRGB(...s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.setRGB(...s.skyColor);
    this.hemi.groundColor.setRGB(...s.groundColor);
    this.hemi.intensity = s.hemiIntensity;
    this.scene.fog.color.setRGB(...s.fogColor);
    this.scene.fog.near = s.fogDensity;
    this.scene.fog.far = s.mist;
    this.renderer.toneMappingExposure = s.exposure;
    const su = this.skyUniforms;
    su.topColor.value.setRGB(...s.skyTop);
    su.horizonColor.value.setRGB(...s.skyHorizon);
    su.fogColor.value.setRGB(...s.fogColor);
    su.sunDir.value.copy(this.sunDir);
    su.sunColor.value.setRGB(...s.sunColor);
    su.overcast.value = s.overcast;
    su.haze.value = clamp(s.fogDensity * 40, 0, 1);
    shared.uWind.value = s.wind;
    // 캐노피 햇빛 투영 오프셋
    const sy = Math.max(0.12, this.sunDir.y);
    let ox = (this.sunDir.x / sy) * 20, oz = (this.sunDir.z / sy) * 20;
    const ol = Math.hypot(ox, oz);
    if (ol > 60) { ox *= 60 / ol; oz *= 60 / ol; }
    shared.uCanopyInfo.value.z = ox;
    shared.uCanopyInfo.value.w = oz;
    shared.uSunLow.value = 1 - this.sunDir.y;
    if (this.shaftMat) {
      this.shaftMat.uniforms.uColor.value.setRGB(...s.sunColor);
      this.shaftMat.uniforms.uIntensity.value = s.shafts;
    }
  }

  _bakeEnv() {
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(this.sky.geometry, this.skyMat);
    envScene.add(sky);
    const rt = this._pmrem.fromScene(envScene, 0, 0.1, 500);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.onEnvMap?.(rt.texture);
  }

  // -------------------------------------------------------------
  // 비 (GPU에서 카메라 주변으로 순환하는 빗줄기)
  // -------------------------------------------------------------
  _buildRain() {
    const max = Math.max(...Object.values(CONFIG.graphics).map((g) => g.rainDrops));
    const offs = new Float32Array(max * 2 * 4);
    const ends = new Float32Array(max * 2);
    const rand = mulberry(99);
    for (let i = 0; i < max; i++) {
      const x = rand(), y = rand(), z = rand(), w = rand();
      for (let k = 0; k < 2; k++) {
        offs.set([x, y, z, w], (i * 2 + k) * 4);
        ends[i * 2 + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3));
    g.setAttribute('aOff', new THREE.BufferAttribute(offs, 4));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uIntensity: { value: 0 },
        uCanopyTex: shared.uCanopyTex, uCanopyInfo: shared.uCanopyInfo,
      },
      vertexShader: /* glsl */`
        attribute vec4 aOff;
        attribute float aEnd;
        uniform vec3 uCam;
        uniform float uTime, uIntensity;
        uniform sampler2D uCanopyTex;
        uniform vec4 uCanopyInfo;
        varying float vAlpha;
        const float AREA = 44.0;
        const float HEIGHT = 22.0;
        void main() {
          vec3 p;
          p.x = uCam.x + ( fract( aOff.x - uCam.x / AREA ) - 0.5 ) * AREA;
          p.z = uCam.z + ( fract( aOff.z - uCam.z / AREA ) - 0.5 ) * AREA;
          float speed = 9.0 + aOff.w * 3.0;
          p.y = uCam.y - HEIGHT * 0.4 + fract( aOff.y - uTime * speed / HEIGHT ) * HEIGHT;
          vec3 v = normalize( vec3( 0.18, -1.0, 0.08 ) );
          p -= v * aEnd * ( 0.45 + 0.35 * uIntensity );
          float cover = texture2D( uCanopyTex, ( p.xz + uCanopyInfo.x ) / uCanopyInfo.y ).r;
          float shown = step( aOff.w, uIntensity );
          vAlpha = shown * ( 0.42 - 0.3 * cover ) * ( 0.6 + 0.4 * uIntensity );
          gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        varying float vAlpha;
        void main() {
          if ( vAlpha <= 0.001 ) discard;
          gl_FragColor = vec4( 0.72, 0.75, 0.78, vAlpha );
        }`,
      transparent: true, depthWrite: false, fog: false,
    });
    this.rain = new THREE.LineSegments(g, mat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    this.scene.add(this.rain);
  }

  // -------------------------------------------------------------
  // 캐노피 틈으로 새는 빛줄기
  // -------------------------------------------------------------
  _buildShafts() {
    const d = this.data;
    const cN = d.cN, half = d.half;
    const cover = (x, z) => {
      const i = Math.max(0, Math.min(cN - 1, Math.floor(x + half))), j = Math.max(0, Math.min(cN - 1, Math.floor(z + half)));
      return d.canopy[j * cN + i];
    };
    const gaps = [];
    for (let z = -half + 10; z < half - 10; z += 3) {
      for (let x = -half + 10; x < half - 10; x += 3) {
        if (cover(x, z) > 0.3) continue;
        let ring = 0, n = 0;
        for (let a = 0; a < 6.28; a += 0.8) { ring += cover(x + Math.cos(a) * 6, z + Math.sin(a) * 6); n++; }
        if (ring / n < 0.62) continue;
        gaps.push({ x, z, y: this.query.getTerrainHeight(x, z) + 22, r: 0.45 + (1 - cover(x, z)) * 0.8 });
      }
    }
    this.gaps = gaps;
    const geo = new THREE.CylinderGeometry(1, 1.25, 1, 10, 1, true);
    geo.translate(0, -0.5, 0);
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uIntensity: { value: 0.4 } },
      vertexShader: /* glsl */`
        varying float vT;
        varying float vEdge;
        varying float vDist;
        void main() {
          vT = -position.y;
          vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
          vec3 n = normalize( mat3( modelMatrix * instanceMatrix ) * normal );
          vec3 viewDir = normalize( cameraPosition - wp.xyz );
          vEdge = abs( dot( n, viewDir ) );
          vDist = length( cameraPosition - wp.xyz );
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vT;
        varying float vEdge;
        varying float vDist;
        void main() {
          float a = pow( vEdge, 3.0 ) * smoothstep( 0.0, 0.3, vT ) * ( 1.0 - smoothstep( 0.45, 1.0, vT ) );
          a *= smoothstep( 6.0, 22.0, vDist ) * ( 1.0 - smoothstep( 40.0, 70.0, vDist ) );
          gl_FragColor = vec4( uColor * a * uIntensity * 0.045, 1.0 );
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.shafts = new THREE.InstancedMesh(geo, this.shaftMat, 80);
    this.shafts.count = 0;
    this.shafts.frustumCulled = false;
    this.shafts.renderOrder = 6;
    this.scene.add(this.shafts);
    this._shaftFocus = new THREE.Vector3(1e9, 0, 0);
    this._shaftSun = new THREE.Vector3();
  }

  _updateShafts(focus) {
    if (this._shaftFocus.distanceTo(focus) < 5 && this.sunDir.distanceTo(this._shaftSun) < 0.01) return;
    this._shaftFocus.copy(focus);
    this._shaftSun.copy(this.sunDir);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.sunDir);
    const sy = Math.max(0.15, this.sunDir.y);
    let n = 0;
    for (const g of this.gaps) {
      if (n >= 80) break;
      if (Math.hypot(g.x - focus.x, g.z - focus.z) > 70) continue;
      const len = Math.min(70, 24 / sy);
      m.compose(new THREE.Vector3(g.x, g.y, g.z), q, new THREE.Vector3(g.r, len, g.r));
      this.shafts.setMatrixAt(n++, m);
    }
    this.shafts.count = n;
    this.shafts.instanceMatrix.needsUpdate = true;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
