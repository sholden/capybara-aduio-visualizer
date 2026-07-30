import * as THREE from 'three'
import type { AudioFrame, CapyScene, ParamSpec, SceneContext } from '@/core/types'
import { createCapybara, type CapybaraParts } from './capybaraModel'

const MAX_CAPYS = 7

/** Water surface: gerstner-ish ripples plus a beat-driven ring pulse. */
const WATER_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  uniform float uTime;
  uniform float uBass;
  uniform float uPunch;

  void main() {
    vUv = uv;
    vec3 pos = position;

    float d = length(pos.xy);
    float wave =
        sin(pos.x * 1.6 + uTime * 1.1) * 0.055
      + sin(pos.y * 2.1 - uTime * 0.9) * 0.045
      + sin((pos.x + pos.y) * 3.3 + uTime * 1.7) * 0.022;

    // Ring travelling outward from the centre on each beat.
    wave += sin(d * 3.0 - uTime * 4.0) * uPunch * 0.10 * exp(-d * 0.10);
    pos.z += wave * (1.0 + uBass * 1.6);

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const WATER_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vWorld;
  uniform float uTime;
  uniform float uBass;
  uniform float uHigh;
  uniform vec3 uCamera;

  void main() {
    vec3 viewDir = normalize(uCamera - vWorld);

    // Cheap fresnel against a flat up-normal: grazing angles go pale and misty,
    // which is most of what sells steaming water at this distance.
    float fresnel = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.5);

    vec3 deep = vec3(0.035, 0.13, 0.145);
    vec3 shallow = vec3(0.16, 0.42, 0.40);
    vec3 col = mix(deep, shallow, 0.35 + uBass * 0.4);

    // Specular glitter riding the surface.
    float glint = sin(vWorld.x * 7.0 + uTime * 2.2) * sin(vWorld.z * 6.0 - uTime * 1.7);
    col += vec3(0.9, 0.75, 0.55) * smoothstep(0.75, 1.0, glint) * (0.10 + uHigh * 0.35);

    col = mix(col, vec3(0.92, 0.72, 0.52), fresnel * 0.55);

    // Fade the far edge into the fog so the plane has no visible boundary.
    float fade = smoothstep(26.0, 9.0, length(vWorld.xz));
    gl_FragColor = vec4(col, fade);
  }
`

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform float uLevel;

  void main() {
    float h = normalize(vDir).y;
    vec3 horizon = vec3(0.95, 0.52, 0.24);
    vec3 mid = vec3(0.42, 0.18, 0.26);
    vec3 top = vec3(0.10, 0.07, 0.16);
    vec3 col = mix(horizon, mid, smoothstep(-0.02, 0.35, h));
    col = mix(col, top, smoothstep(0.25, 0.85, h));
    col += vec3(0.10, 0.05, 0.02) * uLevel * smoothstep(0.4, -0.1, h);
    gl_FragColor = vec4(col, 1.0);
  }
`

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const STEAM_VERTEX = /* glsl */ `
  attribute float aSeed;
  varying float vAlpha;
  uniform float uTime;
  uniform float uHigh;
  uniform float uPixelRatio;

  void main() {
    vec3 pos = position;
    float life = fract(uTime * (0.06 + aSeed * 0.05) + aSeed);
    pos.y += life * 6.0;
    // Curl outward as it rises.
    pos.x += sin(uTime * 0.5 + aSeed * 20.0) * life * 1.4;
    pos.z += cos(uTime * 0.4 + aSeed * 17.0) * life * 1.4;

    vAlpha = (1.0 - life) * life * 4.0 * (0.25 + uHigh * 0.6);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = (70.0 + aSeed * 90.0) * uPixelRatio / max(-mv.z, 0.001);
    gl_Position = projectionMatrix * mv;
  }
`

const STEAM_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float mask = smoothstep(0.5, 0.05, length(d));
    gl_FragColor = vec4(vec3(0.94, 0.90, 0.86), mask * vAlpha * 0.30);
  }
`

interface Soaker {
  parts: CapybaraParts
  seed: number
  baseY: number
}

export class HotSpringSoak implements CapyScene {
  readonly id = 'hotSpringSoak'
  readonly name = 'Hot Spring Soak'
  readonly tags = ['3d', 'procedural'] as const

  readonly params: readonly ParamSpec[] = [
    { key: 'count', label: 'Capybaras', min: 1, max: MAX_CAPYS, step: 1, default: 5 },
    { key: 'bob', label: 'Bob', min: 0, max: 2, step: 0.05, default: 1 },
    { key: 'steam', label: 'Steam', min: 0, max: 2, step: 0.05, default: 1 },
  ]

  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
  private soakers: Soaker[] = []
  private water!: THREE.Mesh
  private waterMaterial!: THREE.ShaderMaterial
  private skyMaterial!: THREE.ShaderMaterial
  private steamMaterial!: THREE.ShaderMaterial
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  private keyLight!: THREE.DirectionalLight
  private time = 0

  async load(ctx: SceneContext): Promise<void> {
    this.scene.fog = new THREE.FogExp2(0x6a3a2c, 0.035)

    // --- sky --------------------------------------------------------------
    const skyGeo = new THREE.SphereGeometry(60, 24, 16)
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: { uLevel: { value: 0 } },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.scene.add(new THREE.Mesh(skyGeo, this.skyMaterial))
    this.disposables.push(skyGeo, this.skyMaterial)

    // --- lighting ---------------------------------------------------------
    this.scene.add(new THREE.HemisphereLight(0xffd9b0, 0x2a1a12, 0.7))
    this.keyLight = new THREE.DirectionalLight(0xffb070, 2.4)
    // Low and behind, so every capybara gets a warm sunset rim.
    this.keyLight.position.set(-6, 3.2, -7)
    this.scene.add(this.keyLight)
    // Strong front fill. With only the low back-light the animals rendered as
    // near-black blobs — atmospheric, but you couldn't tell they were capybaras.
    const fill = new THREE.DirectionalLight(0xffd2b0, 1.5)
    fill.position.set(3.5, 4, 8)
    this.scene.add(fill)

    // --- water ------------------------------------------------------------
    const waterGeo = new THREE.PlaneGeometry(60, 60, 120, 120)
    this.waterMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uHigh: { value: 0 },
        uPunch: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
      },
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      fog: false,
    })
    this.water = new THREE.Mesh(waterGeo, this.waterMaterial)
    this.water.rotation.x = -Math.PI / 2
    this.scene.add(this.water)
    this.disposables.push(waterGeo, this.waterMaterial)

    // --- capybaras --------------------------------------------------------
    for (let i = 0; i < MAX_CAPYS; i++) {
      const seed = (Math.sin(i * 127.1) * 0.5 + 0.5) % 1
      const parts = createCapybara(seed)

      // Fan outward from the centre — index 0 in the middle, then alternating
      // right and left. Spreading evenly across MAX_CAPYS instead would pile
      // the whole group on one side whenever `count` is below the maximum,
      // since only the first `count` are ever shown.
      const slot = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2)
      const normalised = slot / Math.ceil((MAX_CAPYS - 1) / 2)

      // Scattered at varied depths rather than along an arc. An arc curved the
      // outer animals toward the camera, so the whole group fused into one
      // continuous chain with no gaps between bodies.
      const scale = 0.62 + seed * 0.30
      parts.group.position.set(
        normalised * 2.9 + (seed - 0.5) * 0.6,
        // Waterline crosses low on the body, leaving back and head clear.
        0.02,
        -1.0 - seed * 2.8,
      )
      // Facing scattered too, so it reads as a lounging group not a formation.
      parts.group.rotation.y = (seed - 0.5) * 1.6 - normalised * 0.4
      parts.group.scale.setScalar(scale)

      this.scene.add(parts.group)
      this.soakers.push({ parts, seed, baseY: parts.group.position.y })
    }

    // --- steam ------------------------------------------------------------
    const STEAM_COUNT = 220
    const positions = new Float32Array(STEAM_COUNT * 3)
    const seeds = new Float32Array(STEAM_COUNT)
    for (let i = 0; i < STEAM_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2
      const radius = Math.random() * 4.5
      positions[i * 3] = Math.cos(angle) * radius
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = Math.sin(angle) * radius - 1.5
      seeds[i] = Math.random()
    }
    const steamGeo = new THREE.BufferGeometry()
    steamGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    steamGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    this.steamMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uHigh: { value: 0 },
        uPixelRatio: { value: Math.min(ctx.height / 900, 2) },
      },
      vertexShader: STEAM_VERTEX,
      fragmentShader: STEAM_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    })
    this.scene.add(new THREE.Points(steamGeo, this.steamMaterial))
    this.disposables.push(steamGeo, this.steamMaterial)

    // Raised and angled down, so the group reads as a group rather than a row
    // of shapes on a distant horizon.
    this.camera.position.set(0, 1.45, 7.5)
    this.camera.lookAt(0, 0.32, -1.5)
  }

  update(frame: AudioFrame, params: Record<string, number>): void {
    this.time += frame.dt
    const count = params.count ?? 5
    const bob = params.bob ?? 1

    const w = this.waterMaterial.uniforms
    w.uTime!.value = this.time
    w.uBass!.value = frame.bass
    w.uHigh!.value = frame.high
    w.uPunch!.value = frame.sinceBeat
    ;(w.uCamera!.value as THREE.Vector3).copy(this.camera.position)

    this.skyMaterial.uniforms.uLevel!.value = frame.level
    this.steamMaterial.uniforms.uTime!.value = this.time
    this.steamMaterial.uniforms.uHigh!.value = frame.high * (params.steam ?? 1)

    this.keyLight.intensity = 2.4 + frame.sinceBeat * 1.6

    for (let i = 0; i < this.soakers.length; i++) {
      const soaker = this.soakers[i]!
      const visible = i < count
      soaker.parts.group.visible = visible
      if (!visible) continue

      const phase = soaker.seed * 6.2831 + this.time * (0.9 + soaker.seed * 0.6)
      // Float on the water, ride the bass, hop on the beat.
      soaker.parts.group.position.y =
        soaker.baseY +
        Math.sin(phase) * 0.05 +
        (frame.bass * 0.12 + frame.sinceBeat * 0.10) * bob

      soaker.parts.group.rotation.z = Math.sin(phase * 0.7) * 0.05
      // Head nods a beat behind the body, which reads as listening.
      soaker.parts.head.rotation.z = -frame.sinceBeat * 0.28 * (0.6 + soaker.seed)
      soaker.parts.head.rotation.y = Math.sin(phase * 0.5) * 0.22
    }

    // Camera drifts slowly so a long hold never feels static.
    this.camera.position.x = Math.sin(this.time * 0.08) * 0.5
    this.camera.position.y = 1.45 + Math.sin(this.time * 0.11) * 0.12
    this.camera.lookAt(0, 0.32, -1.5)
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera)
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.steamMaterial.uniforms.uPixelRatio!.value = Math.min(height / 900, 2)
  }

  dispose(): void {
    for (const soaker of this.soakers) soaker.parts.dispose()
    this.soakers = []
    for (const item of this.disposables) item.dispose()
    this.disposables = []
    this.scene.clear()
  }
}
