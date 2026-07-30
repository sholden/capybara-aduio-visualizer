import * as THREE from 'three'
import type { AudioFrame, CapyScene, ParamSpec, SceneContext } from '@/core/types'
import {
  CAPYBARA_SDF,
  FULLSCREEN_VERTEX,
  NOISE,
  PALETTE,
  SDF,
} from '@/shaders/lib'

const MAX_CAPYS = 6

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uLevel;
  uniform float uPunch;
  uniform float uBeatPhase;
  uniform float uCount;
  uniform float uBob;
  uniform float uGlow;

  ${SDF}
  ${PALETTE}
  ${NOISE}
  ${CAPYBARA_SDF}

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.4;

    // Keeps the group from flying apart on an ultrawide TV while still using
    // the extra width when there is some.
    float spreadWidth = min(uAspect, 1.6) * 1.15;

    // --- sky --------------------------------------------------------------
    // Explicit sunset ramp rather than the shared palette: the fur uses that
    // palette's browns, and the two were reading as the same colour.
    vec3 skyTop = vec3(0.13, 0.08, 0.20);
    vec3 skyMid = vec3(0.52, 0.20, 0.24);
    vec3 skyLow = vec3(0.97, 0.55, 0.24);
    float sky = smoothstep(-0.35, 1.2, p.y);
    vec3 col = mix(skyLow, skyMid, smoothstep(0.0, 0.45, sky));
    col = mix(col, skyTop, smoothstep(0.40, 1.0, sky));
    col += vec3(0.10, 0.05, 0.02) * uMid;

    float haze = fbm(p * 0.7 + vec2(uTime * 0.05, uTime * 0.03));
    col += haze * 0.05 * vec3(1.0, 0.8, 0.6);

    // Warm glow behind the group, breathing with level and flaring on beats.
    float glow = exp(-length(p - vec2(0.0, -0.15)) * 1.7) * (0.16 + uPunch * 0.34);
    col += glow * uGlow * vec3(1.0, 0.62, 0.30);

    // --- capybaras, drawn before the water so it can submerge them ---------
    float waterLine = -0.30
      + sin(p.x * 2.4 + uTime * 0.9) * 0.020 * (1.0 + uBass * 2.5)
      + sin(p.x * 5.7 - uTime * 1.6) * 0.012 * (1.0 + uHigh * 2.0);

    for (int i = 0; i < ${MAX_CAPYS}; i++) {
      if (float(i) >= uCount) break;

      float fi = float(i);
      float seed = hash11(fi * 13.37 + 1.0);

      // Even horizontal spread with a little jitter. Purely hashed lanes
      // clustered badly at low counts and left half the frame empty.
      float slot = (uCount <= 1.0) ? 0.0 : fi / (uCount - 1.0) - 0.5;
      float lane = slot * 1.75 + (hash11(fi * 4.7 + 2.0) - 0.5) * 0.22;

      // Depth alternates rather than following the index, so an evenly spread
      // row doesn't read as one diagonal receding line.
      float depth = mod(fi, 2.0) * 0.55 + hash11(fi * 5.1) * 0.45;
      float scale = mix(0.24, 0.38, depth);
      float phase = seed * 6.2831 + uTime * (1.1 + seed * 0.5);

      vec2 centre = vec2(lane * spreadWidth, mix(-0.17, -0.40, depth));
      centre.y += sin(phase) * 0.025;
      centre.y += (uBass * 0.06 + uPunch * 0.05) * uBob * (0.7 + seed * 0.6);

      float squash = 1.0 + uPunch * 0.22 * (0.8 + seed * 0.5) - uBass * 0.05;

      vec2 q = (p - centre) / scale;
      if (hash11(fi * 3.1) > 0.5) q.x = -q.x;

      float d = sdCapybara(q, squash) * scale;
      float face = sdCapybaraFace(q, squash) * scale;

      // Screen-space derivative keeps edges crisp at any resolution.
      float aa = fwidth(d) * 1.2;
      float body = smoothstep(aa, -aa, d);

      // Deliberately much darker than the sky behind — the silhouette is the
      // whole read at TV viewing distance.
      vec3 fur = mix(vec3(0.30, 0.18, 0.11), vec3(0.52, 0.35, 0.21),
                     hash11(fi * 5.3));
      fur *= mix(0.62, 1.10, smoothstep(-0.35, 0.45, q.y));
      fur += vec3(0.06, 0.03, 0.01) * uHigh;
      // Distance haze: further animals sit back into the sunset.
      fur = mix(fur, skyLow * 0.75, (1.0 - depth) * 0.30);

      col = mix(col, fur, body);

      // Tight rim along the top edge only, so it reads as light rather than
      // an outline swallowing the silhouette.
      float rim = smoothstep(aa * 3.0, 0.0, abs(d)) * smoothstep(-0.1, 0.5, q.y);
      col += vec3(1.0, 0.78, 0.48) * rim * (0.18 + uPunch * 0.45) * uGlow;

      col = mix(col, vec3(0.06, 0.04, 0.03), smoothstep(aa, -aa, face));
    }

    // --- hot spring water, over the bodies --------------------------------
    float inWater = smoothstep(0.012, -0.012, p.y - waterLine);
    vec3 water = capyWater(0.30 + uBass * 0.40 + haze * 0.15);
    // Translucent, so submerged parts stay visible as a murky shape.
    col = mix(col, water, inWater * 0.80);

    // Ripple bands receding toward the surface — keeps the lower third alive
    // instead of a flat wash of teal.
    float depthBelow = clamp((waterLine - p.y) / 0.9, 0.0, 1.0);
    float ripple = sin(p.x * 3.0 + uTime * 0.7 + depthBelow * 6.0)
                 * sin(p.y * 26.0 - uTime * 1.9);
    float rippleMask = inWater * (1.0 - depthBelow) * (0.35 + uBass * 0.65);
    col += vec3(0.35, 0.62, 0.58) * smoothstep(0.25, 1.0, ripple) * rippleMask * 0.20;

    // Sunset reflection smeared on the water directly below the sun glow.
    float reflection = exp(-abs(p.x) * 1.1) * (1.0 - depthBelow) * inWater;
    col += vec3(0.95, 0.55, 0.25) * reflection * (0.10 + uLevel * 0.16);

    // Bright line right at the surface.
    float surface = smoothstep(0.030, 0.0, abs(p.y - waterLine));
    col += vec3(0.60, 0.85, 0.80) * surface * (0.10 + uHigh * 0.30);

    // --- steam ------------------------------------------------------------
    float steam = fbm(vec2(p.x * 1.6, p.y * 2.4 - uTime * 0.55));
    float steamMask = smoothstep(waterLine, waterLine + 0.9, p.y)
                    * smoothstep(1.1, 0.1, p.y);
    col += vec3(0.85, 0.82, 0.78) * pow(steam, 2.2) * steamMask * (0.16 + uLevel * 0.18);

    // --- finish -----------------------------------------------------------
    col *= 1.0 - 0.32 * pow(length(vUv - 0.5) * 1.35, 2.2);
    // Gentle shoulder: tames beat flares without draining colour everywhere.
    col = col / (1.0 + col * 0.35);
    col = pow(col, vec3(0.92));

    gl_FragColor = vec4(col, 1.0);
  }
`

export class CapyBlobDisco implements CapyScene {
  readonly id = 'capyBlobDisco'
  readonly name = 'Capy Blob Disco'
  readonly tags = ['2d', 'procedural', 'cartoon'] as const

  readonly params: readonly ParamSpec[] = [
    { key: 'count', label: 'Capybaras', min: 1, max: MAX_CAPYS, step: 1, default: 4 },
    { key: 'bob', label: 'Bounce', min: 0, max: 2, step: 0.05, default: 1 },
    { key: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, default: 1 },
  ]

  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material!: THREE.ShaderMaterial
  private geometry!: THREE.PlaneGeometry

  async load(ctx: SceneContext): Promise<void> {
    this.geometry = new THREE.PlaneGeometry(2, 2)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: ctx.width / ctx.height },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uLevel: { value: 0 },
        uPunch: { value: 0 },
        uBeatPhase: { value: 0 },
        uCount: { value: 4 },
        uBob: { value: 1 },
        uGlow: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.scene.add(new THREE.Mesh(this.geometry, this.material))
  }

  update(frame: AudioFrame, params: Record<string, number>): void {
    const u = this.material.uniforms
    u.uTime!.value = frame.t
    u.uBass!.value = frame.bass
    u.uMid!.value = frame.mid
    u.uHigh!.value = frame.high
    u.uLevel!.value = frame.level
    u.uPunch!.value = frame.sinceBeat
    u.uBeatPhase!.value = frame.beatCount % 4
    u.uCount!.value = params.count ?? 4
    u.uBob!.value = params.bob ?? 1
    u.uGlow!.value = params.glow ?? 1
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera)
  }

  resize(width: number, height: number): void {
    this.material.uniforms.uAspect!.value = width / height
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.scene.clear()
  }
}
