// 대기: 하늘, 해(그림자), 반구광, 높이 안개, 시간대·날씨 전환, 비, 캐노피 사이로 새는 빛줄기
// 6단계 밤: '해' 프리셋이 moon 이면 방향광 = 달빛 (세기 × 달 모양 setMoon), 하늘에 달(모양대로)·별 (캐노피 틈으로만 보임).
//  조명탄 setFlare(f): 가장 밝은 조명탄 쪽으로 방향광을 돌려 (그림자가 흔들리며 크게 움직이고 깜빡임) 세기·색을 덮어씀
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { shared } from './Materials.js';
import { clamp, lerp } from '../core/math.js';

const DEG = Math.PI / 180;

function presetState(tod, weather, moon = 1) {
  return stateFrom(tod, CONFIG.weather.presets[weather], moon);
}

/** 시간대 프리셋 키 + 날씨 값 (프리셋 또는 5단계 WeatherCycle.params — 섞인 값) → 대기 상태. moon: 달빛 배율 (6단계 밤 프리셋) */
function stateFrom(tod, W, moon = 1) {
  const T = CONFIG.timeOfDay.presets[tod];
  const mk = T.moon ? moon : 1;
  const gray = W.skyGray;
  const toGray = (c, k, g = 0.5) => {
    const l = c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;
    return c.map((v) => lerp(v, l * g / 0.5 * 0.9, k));
  };
  return {
    sunElevation: T.sunElevation, sunAzimuth: T.sunAzimuth,
    sunColor: T.sunColor.slice(), sunIntensity: T.sunIntensity * W.sunMul * mk,
    skyColor: toGray(T.skyColor, gray * 0.7), groundColor: T.groundColor.slice(),
    hemiIntensity: T.hemiIntensity * (1 - gray * 0.35) * (T.moon ? 0.3 + 0.7 * moon : 1),
    night: T.moon ? 1 : 0, moonGlow: T.moon ? moon * (1 - gray * 0.9) : 0,
    fogColor: toGray(T.fogColor, gray * 0.6, 0.45), fogDensity: T.fogDensity + W.fogAdd, mist: T.mist * (1 + gray * 0.5) * (W.mistMul ?? 1),
    skyTop: toGray(T.skyTop, gray * 0.9, 0.4), skyHorizon: toGray(T.skyHorizon, gray * 0.85, 0.45),
    exposure: T.exposure, overcast: gray, rain: W.rain,
    wind: 0.25 + W.rain * 0.75,
    shafts: (tod === 'dawn' ? 0.55 : tod === 'noon' ? 0.22 : tod === 'dusk' ? 0.4 : 0) * (1 - gray),
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
    this.state = presetState(this.tod, this.weather, this._moonK());
    this.target = this.state;
    this.wetness = CONFIG.weather.presets[this.weather].wetness;
    this.wetTarget = this.wetness;
    this.rainIntensity = this.state.rain;
    this.dynamic = false;          // 5단계 임무: 시계·날씨 흐름이 매 프레임 목표를 정함 (setDynamic)
    this.lightning = 0;            // 번개 밝기 0~1 (빠르게 사라짐)
    this.moon = 'half';            // 6단계: 달 모양 (임무마다) — 밤 프리셋 방향광·하늘빛 배율
    this._flare = null;            // 6단계: 가장 밝게 비추는 조명탄 { x, y, z, k }
    this._focus = new THREE.Vector3();
    this.sunDir = new THREE.Vector3();
    this.settings = null;
    this._envDirty = true;
    this._envTimer = 0;

    // 하늘 돔
    this.skyUniforms = {
      topColor: { value: new THREE.Color() }, horizonColor: { value: new THREE.Color() },
      fogColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() },
      sunColor: { value: new THREE.Color() }, overcast: { value: 0 }, haze: { value: 0 }, flash: { value: 0 },
      uNight: { value: 0 }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonGlow: { value: 0 }, uMoonPhase: { value: 1 }, uSkyTime: { value: 0 },
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
        uniform vec3 topColor, horizonColor, fogColor, sunColor, sunDir, uMoonDir;
        uniform float overcast, haze, flash, uNight, uMoonGlow, uMoonPhase, uSkyTime;
        varying vec3 vDir;
        float starHash( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
        void main() {
          float h = clamp( vDir.y, -0.2, 1.0 );
          vec3 col = mix( horizonColor, topColor, pow( max( h, 0.0 ), 0.55 ) );
          vec3 nd = normalize( vDir );
          float sd = max( dot( vDir, sunDir ), 0.0 );
          col += sunColor * ( pow( sd, 900.0 ) * 6.0 * ( 1.0 - overcast ) + pow( sd, 12.0 ) * 0.35 * ( 1.0 - overcast * 0.6 ) ) * ( 1.0 - uNight );
          // 6단계 밤: 별 (방향 격자 칸마다 하나 — 밝은 것만, 반짝임) · 달 (모양대로 밝은 쪽 + 어두운 쪽 희미하게)
          if ( uNight > 0.01 ) {
            vec3 g = nd * 150.0;
            vec3 cell = floor( g );
            float hs = starHash( cell );
            vec3 jit = vec3( fract( hs * 7.13 ), fract( hs * 3.71 ), fract( hs * 5.27 ) );
            float dd = length( g - ( cell + jit ) );
            float tw = 0.75 + 0.25 * sin( uSkyTime * ( 2.0 + hs * 5.0 ) + hs * 40.0 );
            float star = step( 0.972, hs ) * smoothstep( 0.42, 0.0, dd ) * ( 0.35 + 3.0 * pow( fract( hs * 91.7 ), 6.0 ) ) * tw;
            col += vec3( 0.85, 0.9, 1.0 ) * star * uNight * ( 1.0 - overcast ) * smoothstep( 0.02, 0.25, h );
            if ( uMoonGlow > 0.001 ) {
              float md = dot( nd, uMoonDir );
              vec3 mr = normalize( cross( uMoonDir, vec3( 0.0, 1.0, 0.0 ) ) );
              vec3 mu = cross( mr, uMoonDir );
              vec2 lc = vec2( dot( nd - uMoonDir, mr ), dot( nd - uMoonDir, mu ) ) / 0.022;
              float disc = 1.0 - smoothstep( 0.92, 1.0, length( lc ) );
              float lit = smoothstep( -0.06, 0.06, lc.x + uMoonPhase * sqrt( max( 0.0, 1.0 - lc.y * lc.y ) ) );
              col += vec3( 0.92, 0.93, 0.98 ) * disc * mix( 0.035, 1.6, lit ) * uMoonGlow * uNight;
              col += vec3( 0.25, 0.3, 0.42 ) * pow( max( md, 0.0 ), 600.0 ) * uMoonGlow * uNight * 0.6;
            }
          }
          // 지평선 근처는 안개 색으로
          col = mix( col, fogColor, clamp( haze * ( 1.0 - smoothstep( -0.05, 0.35, h ) ), 0.0, 1.0 ) );
          col = mix( col, fogColor, smoothstep( 0.02, -0.2, h ) );
          col += vec3( 0.72, 0.78, 0.95 ) * flash * ( 0.6 + 0.4 * max( h, 0.0 ) );   // 번개
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
    this.shaftsEnabled = settings.lightShafts && settings.shafts > 0;
    this.shafts.visible = false;
    this._shaftFocus.set(1e9, 0, 0);
    this.scene.fog.far = this.state.mist;
  }

  setTimeOfDay(key, instant = false) {
    this.dynamic = false;
    this.tod = key;
    this._retarget(instant);
  }

  setWeather(key, instant = false) {
    this.dynamic = false;
    this.weather = key;
    this.wetTarget = CONFIG.weather.presets[key].wetness;
    if (instant) this.wetness = this.wetTarget;
    this._retarget(instant);
  }

  /**
   * 5단계 임무: 시계의 시간대 섞기 (GameClock.todBlend — 두 프리셋 a·b, 비율 k) + 날씨 흐름 값 (WeatherCycle.params).
   * 둘 다 이미 연속으로 변하므로 목표를 바로 상태로 쓴다. 비 강도·젖음도는 update 가 천천히 따라간다.
   * instant: 임무 시작 (젖음도·비도 바로)
   */
  setDynamic(blend, W, instant = false) {
    const mk = this._moonK();
    const a = stateFrom(blend.a, W, mk);
    const st = blend.b === blend.a || blend.k <= 0 ? a : lerpState(a, stateFrom(blend.b, W, mk), blend.k);
    this.dynamic = true;
    this.tod = blend.k > 0.5 ? blend.b : blend.a;
    this.weather = W.kind ?? this.weather;
    this.target = st;
    this.state = st;
    this._t = 1;
    this.wetTarget = W.wetness;
    if (instant) { this.wetness = W.wetness; this.rainIntensity = st.rain; this._envDirty = true; this._envTimer = 0; }
    // 하늘 반사(환경맵)는 천천히 바뀌므로 20초마다 다시 굽는다
    this._dynEnv = (this._dynEnv ?? 0) + 1;
    this._applyState();
  }

  /** 6단계: 달 모양 ('full'|'half'|'new') */
  setMoon(key) {
    this.moon = key || 'half';
    if (!this.dynamic) this._retarget(true);
  }

  _moonK() { return CONFIG.night.moon[this.moon]?.light ?? CONFIG.night.moon.half.light; }

  /** 6단계: 조명탄 (null 이면 끔) — f: { x, y, z, k (땅에 닿는 빛 0~1) } */
  setFlare(f) { this._flare = f && f.k > 0.01 ? f : null; }

  /** 번개: 하늘·반구광이 잠깐 번쩍임 (0~1) */
  flash(intensity) { this.lightning = Math.max(this.lightning, Math.min(1, intensity)); }

  _retarget(instant) {
    this.target = presetState(this.tod, this.weather, this._moonK());
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
    const wTarget = this.wetTarget;
    if (this.wetness < wTarget) this.wetness = Math.min(wTarget, this.wetness + CONFIG.weather.wettingRate * (0.4 + this.rainIntensity) * dt);
    else this.wetness = Math.max(wTarget, this.wetness - CONFIG.weather.dryingRate * dt);

    this.query.wetness = this.wetness;
    this.query.rainIntensity = this.rainIntensity;
    // 번개 (빠르게 사라지며 한 번 더 깜빡)
    if (this.lightning > 0) {
      this._lt = (this._lt ?? 0) + dt;
      this.lightning = Math.max(0, this.lightning - dt * 2.6);
      if (this.lightning <= 0) this._lt = 0;
    }
    this.skyUniforms.flash.value = this.lightning * (0.75 + 0.25 * Math.sin((this._lt ?? 0) * 40)) * 1.6;
    this.skyUniforms.uSkyTime.value += dt;
    this._focus.copy(focus);
    if (this.dynamic) {
      this._envClock = (this._envClock ?? 0) + dt;
      if (this._envClock > 20) { this._envClock = 0; this._envDirty = true; }
    }
    shared.uWetness.value = this.wetFactor * 0.85 + 0.1;
    shared.uRain.value = this.rainIntensity;
    shared.uTime.value += dt;
    this._applyState();
    // 숲속 안개: 카메라 위 캐노피가 짙을수록 녹회색·어둡게
    const camCover = this.query.getCanopyCover(camera.position.x, camera.position.z);
    this._camCover = this._camCover === undefined ? camCover : this._camCover + (camCover - this._camCover) * Math.min(1, dt * 1.5);
    const F = CONFIG.fog;
    shared.uFogCanopy.value.set(0.56, 0.68, 0.54, Math.min(1, (0.25 + this._camCover) * F.underCanopyDim));
    // 햇빛 얼룩이 바람에 살짝 일렁임
    const t = shared.uTime.value, w = this.state.wind;
    shared.uFleckInfo.value.z = Math.sin(t * 0.83) * 0.004 * w + Math.sin(t * 2.1) * 0.0015 * w;
    shared.uFleckInfo.value.w = Math.cos(t * 0.71) * 0.004 * w;

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
    if (this.shaftsEnabled) this._updateShafts(focus);

    // 환경맵 (물 반사) — 전환이 끝나면 다시 굽기
    if (this._envDirty) {
      this._envTimer -= dt;
      if (this._envTimer <= 0) { this._bakeEnv(); this._envDirty = false; this._envTimer = 0.5; }
    }
  }

  _applyState() {
    const s = this.state;
    // 해가 지평선 아래 (5단계 동트기 전·어스름) 여도 빛은 땅 위에서 비추게 (세기가 아주 작음)
    const el = Math.max(3, s.sunElevation) * DEG, az = s.sunAzimuth * DEG;
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
    su.sunColor.value.setRGB(...s.sunColor).multiplyScalar(Math.min(1, s.sunIntensity / 1.5));
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
    shared.uSunDir.value.copy(this.sunDir);
    shared.uSunColor.value.setRGB(...s.sunColor).multiplyScalar(s.sunIntensity / 4.2);
    const L = CONFIG.lighting;
    shared.uTranslucency.value = L.translucency;
    shared.uCanopyTint.value.setRGB(...L.canopyTint);
    shared.uFleckInfo.value.x = 1 / L.sunfleckTile;
    shared.uFleckInfo.value.y = L.sunfleckStrength * (1 - s.overcast * 0.85);
    // 해가 낮을수록 얼룩이 해 방위 쪽으로 길쭉해짐: 해 방위 축 좌표를 sin(고도) 만큼 줄임
    {
      const az = Math.atan2(this.sunDir.z, this.sunDir.x);
      const k = Math.max(0.3, this.sunDir.y);
      const c = Math.cos(az), sn = Math.sin(az);
      shared.uFleckMat.value.set(c * k, sn * k, -sn, c);
    }
    shared.uWindDir.value.set(...CONFIG.wind.direction).normalize();
    shared.uPushStrength.value = CONFIG.interaction.pushStrength;
    shared.uFogSun.value.set(this.sunDir.x, this.sunDir.y, this.sunDir.z, CONFIG.fog.sunScatter * (1 - s.overcast * 0.8) * Math.min(1, s.sunIntensity / 2));
    shared.uFogSunColor.value.setRGB(...s.sunColor).multiplyScalar(0.45);
    if (this.shaftMat) {
      this.shaftMat.uniforms.uColor.value.setRGB(...s.sunColor);
      this.shaftMat.uniforms.uIntensity.value = s.shafts;
    }
    // 6단계: 밤 하늘 (별·달) — 달은 밤 프리셋의 '해' 방향
    su.uNight.value = s.night ?? 0;
    su.uMoonGlow.value = s.moonGlow ?? 0;
    su.uMoonDir.value.copy(this.sunDir);
    su.uMoonPhase.value = this.moon === 'full' ? 1 : this.moon === 'half' ? 0 : -1;
    // 6단계: 조명탄 — 방향광을 조명탄 쪽으로 (그림자·캐노피 얼룩이 조명탄 흔들림을 따라 움직임), 세기·색 덮어씀
    const f = this._flare;
    if (f) {
      const F = this._focus;
      const dir = this._fdir || (this._fdir = new THREE.Vector3());
      dir.set(f.x - F.x, Math.max(8, f.y - F.y), f.z - F.z).normalize();
      const k = Math.min(1, f.k);
      const mix = Math.min(1, k * 3);
      this.sunDir.lerp(dir, mix).normalize();
      const fc = [1.0, 0.93, 0.8];
      this.sun.color.setRGB(lerp(s.sunColor[0], fc[0], mix), lerp(s.sunColor[1], fc[1], mix), lerp(s.sunColor[2], fc[2], mix));
      this.sun.intensity = Math.max(s.sunIntensity, 3.0 * k);
      this.hemi.intensity = s.hemiIntensity + 0.35 * k;
      this.hemi.color.setRGB(lerp(s.skyColor[0], 0.75, mix * 0.6), lerp(s.skyColor[1], 0.74, mix * 0.6), lerp(s.skyColor[2], 0.66, mix * 0.6));
      const sy2 = Math.max(0.12, this.sunDir.y);
      let ox2 = (this.sunDir.x / sy2) * 20, oz2 = (this.sunDir.z / sy2) * 20;
      const ol2 = Math.hypot(ox2, oz2);
      if (ol2 > 60) { ox2 *= 60 / ol2; oz2 *= 60 / ol2; }
      shared.uCanopyInfo.value.z = ox2;
      shared.uCanopyInfo.value.w = oz2;
      shared.uSunLow.value = 1 - this.sunDir.y;
      shared.uSunDir.value.copy(this.sunDir);
      shared.uSunColor.value.setRGB(...fc).multiplyScalar(this.sun.intensity / 4.2);
      shared.uFleckInfo.value.y = CONFIG.lighting.sunfleckStrength;
      {
        const az = Math.atan2(this.sunDir.z, this.sunDir.x);
        const kk = Math.max(0.3, this.sunDir.y);
        const c = Math.cos(az), sn = Math.sin(az);
        shared.uFleckMat.value.set(c * kk, sn * kk, -sn, c);
      }
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
  // 캐노피 틈으로 새는 빛줄기 — 햇빛 방향 축으로 늘인 카드가 카메라 쪽을 향함 (가산 혼합)
  // -------------------------------------------------------------
  _buildShafts() {
    const d = this.data;
    const cN = d.cN, half = d.half;
    const cover = (x, z) => {
      const i = Math.max(0, Math.min(cN - 1, Math.floor(x + half))), j = Math.max(0, Math.min(cN - 1, Math.floor(z + half)));
      return d.canopy[j * cN + i];
    };
    const gaps = [];
    for (let z = -half + 10; z < half - 10; z += 2.5) {
      for (let x = -half + 10; x < half - 10; x += 2.5) {
        if (cover(x, z) > 0.42) continue;
        let ring = 0, n = 0;
        for (let a = 0; a < 6.28; a += 0.8) { ring += cover(x + Math.cos(a) * 5, z + Math.sin(a) * 5); n++; }
        if (ring / n < 0.6) continue;
        const top = d.canopyHigh[Math.max(0, Math.min(cN - 1, Math.floor(z + half))) * cN + Math.max(0, Math.min(cN - 1, Math.floor(x + half)))];
        const gy = this.query.getTerrainHeight(x, z);
        gaps.push({ x, z, y: Math.max(gy + 14, Math.min(gy + 34, top > -100 ? top - 4 : gy + 22)), w: 0.6 + (1 - cover(x, z)) * 1.6, seed: (x * 13.1 + z * 7.7) % 1 });
      }
    }
    this.gaps = gaps;
    const geo = new THREE.PlaneGeometry(1, 1, 1, 6);
    geo.translate(0, -0.5, 0);   // y: 0(꼭대기) → -1(바닥 쪽)
    this.shaftMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uIntensity: { value: 0.4 }, uSunDir: shared.uSunDir, uTime: shared.uTime,
      },
      vertexShader: /* glsl */`
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying float vDist;
        varying float vFade;
        void main() {
          vec3 top = ( modelMatrix * instanceMatrix[ 3 ] ).xyz;
          float width = length( instanceMatrix[ 0 ].xyz );
          float len = length( instanceMatrix[ 1 ].xyz );
          vec3 axis = -normalize( uSunDir );
          vec3 toCam = normalize( cameraPosition - top );
          vec3 side = normalize( cross( axis, toCam ) );
          vec3 wp = top + side * position.x * width - axis * position.y * len;
          vUv = vec2( position.x + 0.5, -position.y );
          vDist = length( cameraPosition - wp );
          // 축을 정면으로 볼수록(빛줄기 안을 들여다볼수록) 옅게
          float al = abs( dot( axis, normalize( cameraPosition - wp ) ) );
          vFade = ( 1.0 - al ) * ( 1.0 - al );
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        varying float vFade;
        void main() {
          float across = 1.0 - abs( vUv.x * 2.0 - 1.0 );
          float a = across * across * smoothstep( 0.0, 0.18, vUv.y ) * ( 1.0 - smoothstep( 0.55, 1.0, vUv.y ) );
          a *= 0.75 + 0.25 * sin( vUv.y * 9.0 + uTime * 0.6 + vUv.x * 3.0 );
          a *= smoothstep( 7.0, 22.0, vDist ) * ( 1.0 - smoothstep( 45.0, 75.0, vDist ) ) * vFade;
          gl_FragColor = vec4( uColor * a * uIntensity * 0.11, 1.0 );
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    });
    this.shafts = new THREE.InstancedMesh(geo, this.shaftMat, 64);
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
    const max = Math.min(64, this.settings ? this.settings.shafts : 28);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const sy = Math.max(0.15, this.sunDir.y);
    const near = this.gaps
      .map((g) => ({ g, d: Math.hypot(g.x - focus.x, g.z - focus.z) }))
      .filter((e) => e.d < 70)
      .sort((a, b) => a.d - b.d);
    let n = 0;
    for (const { g } of near) {
      if (n >= max) break;
      const len = Math.min(60, (g.y - focus.y + 6) / sy);
      m.compose(new THREE.Vector3(g.x, g.y, g.z), q, new THREE.Vector3(g.w, len, 1));
      this.shafts.setMatrixAt(n++, m);
    }
    this.shafts.count = n;
    this.shafts.visible = n > 0;
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
