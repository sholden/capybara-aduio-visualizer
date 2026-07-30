import * as THREE from 'three'
import type { AudioFrame, CapyScene, ParamSpec, SceneContext } from '@/core/types'
import { FULLSCREEN_VERTEX } from '@/shaders/lib'
import { CAPY_FRAGMENT, LIQUID_FRAGMENT, PLATFORM_FRAGMENT } from './sprites.glsl'
import { Banner, Scoreboard } from './scoreboard'
import { BLOW_TIME, Simulation } from './simulation'
import {
  CAPY_COLORS,
  CAPY_HEIGHT,
  CAPY_WIDTH,
  HUD_HEIGHT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './world'

/** Foreground pixel grid. 640x360 over a 32x18 world is 20px per world unit. */
const LOW_WIDTH = 640
const LOW_HEIGHT = 360

/** Quad is larger than the body so wings and bugged eyes are not clipped. */
const SPRITE_SCALE = 2.6

const UPSCALE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSource;
  void main() {
    vec4 c = texture2D(uSource, vUv);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`

interface CapyVisual {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
}

export class CapyChaseRoyale implements CapyScene {
  readonly id = 'capyChaseRoyale'
  readonly name = 'Capy Chase Royale'
  readonly tags = ['pixel', '2d', 'game'] as const

  readonly params: readonly ParamSpec[] = [
    { key: 'glow', label: 'Level glow', min: 0, max: 2, step: 0.05, default: 1 },
    { key: 'liquid', label: 'Liquid motion', min: 0, max: 2, step: 0.05, default: 1 },
  ]

  private sim!: Simulation

  // Background: full resolution, deliberately not pixelated.
  private bgScene = new THREE.Scene()
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private liquidMaterial!: THREE.ShaderMaterial

  // Foreground: the game itself, rendered small and blown up.
  private gameScene = new THREE.Scene()
  private gameCamera!: THREE.OrthographicCamera
  private lowTarget!: THREE.WebGLRenderTarget
  private upscaleScene = new THREE.Scene()
  private upscaleMaterial!: THREE.ShaderMaterial

  private platformGroup = new THREE.Group()
  private platformMaterials: THREE.ShaderMaterial[] = []
  private capyVisuals: CapyVisual[] = []

  private scoreboard!: Scoreboard
  private banner!: Banner
  private bannerMesh!: THREE.Mesh
  private bannerMaterial!: THREE.MeshBasicMaterial

  private quadGeometry!: THREE.PlaneGeometry
  private unitGeometry!: THREE.PlaneGeometry
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  private time = 0
  private hue = 0
  private levelRound = -1

  async load(ctx: SceneContext): Promise<void> {
    this.sim = new Simulation(Math.floor(ctx.width * 7919 + ctx.height))

    this.quadGeometry = new THREE.PlaneGeometry(2, 2)
    this.unitGeometry = new THREE.PlaneGeometry(1, 1)
    this.disposables.push(this.quadGeometry, this.unitGeometry)

    // --- background -------------------------------------------------------
    this.liquidMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: ctx.width / ctx.height },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uLevel: { value: 0 },
        uPunch: { value: 0 },
        uHue: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: LIQUID_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.bgScene.add(new THREE.Mesh(this.quadGeometry, this.liquidMaterial))
    this.disposables.push(this.liquidMaterial)

    // --- foreground target ------------------------------------------------
    this.lowTarget = new THREE.WebGLRenderTarget(LOW_WIDTH, LOW_HEIGHT, {
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    })
    this.lowTarget.texture.colorSpace = THREE.SRGBColorSpace

    this.upscaleMaterial = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: this.lowTarget.texture } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: UPSCALE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this.upscaleScene.add(new THREE.Mesh(this.quadGeometry, this.upscaleMaterial))
    this.disposables.push(this.upscaleMaterial)

    // World-space camera: one unit of the ortho frustum is one world unit.
    this.gameCamera = new THREE.OrthographicCamera(
      0,
      WORLD_WIDTH,
      WORLD_HEIGHT,
      0,
      -10,
      10,
    )
    this.gameScene.add(this.platformGroup)

    // --- capybaras --------------------------------------------------------
    for (let i = 0; i < this.sim.capys.length; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(...CAPY_COLORS[i]!) },
          uTime: { value: 0 },
          uFacing: { value: 1 },
          uSquash: { value: 1 },
          uSpin: { value: 0 },
          uEyeScale: { value: 0 },
          uWings: { value: 0 },
          uBlow: { value: 0 },
          uGlow: { value: 0 },
          uDim: { value: 0 },
          uBodyScale: { value: SPRITE_SCALE },
          uPuff: { value: 0 },
        },
        vertexShader: FULLSCREEN_VERTEX_LOCAL,
        fragmentShader: CAPY_FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.unitGeometry, material)
      mesh.scale.set(CAPY_WIDTH * SPRITE_SCALE, CAPY_HEIGHT * SPRITE_SCALE, 1)
      mesh.renderOrder = 10 + i
      this.gameScene.add(mesh)
      this.capyVisuals.push({ mesh, material })
      this.disposables.push(material)
    }

    // --- scoreboard and banner -------------------------------------------
    this.scoreboard = new Scoreboard()
    const scoreMaterial = new THREE.MeshBasicMaterial({
      map: this.scoreboard.texture,
      transparent: true,
      depthTest: false,
    })
    const scoreMesh = new THREE.Mesh(this.unitGeometry, scoreMaterial)
    const scoreHeight = (HUD_HEIGHT / LOW_HEIGHT) * 360
    scoreMesh.scale.set(WORLD_WIDTH, scoreHeight, 1)
    scoreMesh.position.set(WORLD_WIDTH / 2, WORLD_HEIGHT - scoreHeight / 2, 1)
    scoreMesh.renderOrder = 100
    this.gameScene.add(scoreMesh)
    this.disposables.push(scoreMaterial)

    this.banner = new Banner()
    this.bannerMaterial = new THREE.MeshBasicMaterial({
      map: this.banner.texture,
      transparent: true,
      depthTest: false,
    })
    this.bannerMesh = new THREE.Mesh(this.unitGeometry, this.bannerMaterial)
    this.bannerMesh.scale.set(WORLD_WIDTH * 0.56, WORLD_WIDTH * 0.56 * (60 / 360), 1)
    this.bannerMesh.position.set(WORLD_WIDTH / 2, WORLD_HEIGHT * 0.55, 2)
    this.bannerMesh.renderOrder = 110
    this.bannerMesh.visible = false
    this.gameScene.add(this.bannerMesh)
    this.disposables.push(this.bannerMaterial)

    this.rebuildPlatforms()
  }

  /** Rebuild platform meshes when the round (and therefore the level) changes. */
  private rebuildPlatforms(): void {
    for (const child of [...this.platformGroup.children]) {
      this.platformGroup.remove(child)
    }
    for (const material of this.platformMaterials) material.dispose()
    this.platformMaterials = []

    for (const platform of this.sim.level.platforms) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0.22, 0.26, 0.45) },
          uGlow: { value: 0 },
          uPulse: { value: platform.tint },
          uPixelSize: {
            value: new THREE.Vector2(
              1 / (platform.width * (LOW_WIDTH / WORLD_WIDTH)),
              1 / (platform.height * (LOW_HEIGHT / WORLD_HEIGHT)),
            ),
          },
        },
        vertexShader: FULLSCREEN_VERTEX_LOCAL,
        fragmentShader: PLATFORM_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.unitGeometry, material)
      mesh.scale.set(platform.width, platform.height, 1)
      mesh.position.set(
        platform.x + platform.width / 2,
        platform.y + platform.height / 2,
        0,
      )
      this.platformGroup.add(mesh)
      this.platformMaterials.push(material)
    }

    this.levelRound = this.sim.round
  }

  update(frame: AudioFrame, params: Record<string, number>): void {
    this.time += frame.dt
    this.hue += frame.dt * 0.035 + (frame.beat ? 0.03 : 0)

    this.sim.update(frame.dt, frame.beat, frame.level)
    if (this.sim.round !== this.levelRound) this.rebuildPlatforms()

    const glow = params.glow ?? 1

    // --- background -------------------------------------------------------
    const lu = this.liquidMaterial.uniforms
    lu.uTime!.value = this.time * (params.liquid ?? 1)
    lu.uBass!.value = frame.bass
    lu.uMid!.value = frame.mid
    lu.uHigh!.value = frame.high
    lu.uLevel!.value = frame.level
    lu.uPunch!.value = frame.sinceBeat
    lu.uHue!.value = this.hue

    // --- platforms --------------------------------------------------------
    // Each platform reads a different band, so the level lights up across the
    // spectrum rather than every slab pulsing in unison.
    const bands = [frame.bass, frame.lowMid, frame.mid, frame.high, frame.presence]
    for (let i = 0; i < this.platformMaterials.length; i++) {
      const material = this.platformMaterials[i]!
      const band = bands[i % bands.length]!
      material.uniforms.uGlow!.value = band * glow
      const hue = (this.hue + i * 0.07) % 1
      ;(material.uniforms.uColor!.value as THREE.Color).setHSL(
        hue,
        0.55,
        0.30 + band * 0.22,
      )
    }

    // --- capybaras --------------------------------------------------------
    for (let i = 0; i < this.capyVisuals.length; i++) {
      const capy = this.sim.capys[i]!
      const visual = this.capyVisuals[i]!
      const u = visual.material.uniforms

      visual.mesh.visible = capy.state !== 'gone'
      if (!visual.mesh.visible) continue

      // capy.y is the feet; the quad is centred. In local space the feet sit at
      // -0.35, which after the body scaling works out to this world offset.
      visual.mesh.position.set(
        capy.x + CAPY_WIDTH / 2,
        capy.y + 0.35 * CAPY_HEIGHT,
        0,
      )

      u.uTime!.value = this.time
      u.uFacing!.value = capy.facing
      u.uSquash!.value = capy.squash
      u.uSpin!.value = capy.spin
      u.uEyeScale!.value = capy.eyeScale
      u.uWings!.value = capy.wings
      // Normalized 1 -> 0 across the blow, so the straw can jab out and retract.
      u.uBlow!.value = capy.blowTimer / BLOW_TIME
      u.uPuff!.value = capy.puff
      u.uGlow!.value = frame.level * glow * 0.5
      u.uDim!.value = capy.state === 'active' ? 0 : 0.35
    }

    // --- hud --------------------------------------------------------------
    this.scoreboard.update(
      this.sim.capys,
      this.sim.round,
      this.sim.revision,
      this.sim.winnerIndex,
    )

    const showBanner = this.sim.phase === 'celebrating' && this.sim.winnerIndex >= 0
    this.bannerMesh.visible = showBanner
    if (showBanner) {
      const winner = this.sim.capys[this.sim.winnerIndex]!
      this.banner.update(this.sim.winnerIndex, this.sim.round, winner.roundCatches)
      // Gentle bob so the banner does not look like a frozen overlay.
      this.bannerMesh.position.y =
        WORLD_HEIGHT * 0.55 + Math.sin(this.time * 3) * 0.12
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget()

    // The foreground target must clear to fully transparent so the liquid
    // background shows through everywhere the level does not cover.
    const clearColor = new THREE.Color()
    renderer.getClearColor(clearColor)
    const clearAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget(this.lowTarget)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    renderer.render(this.gameScene, this.gameCamera)
    renderer.setClearColor(clearColor, clearAlpha)

    renderer.setRenderTarget(previous)
    const autoClear = renderer.autoClear
    renderer.autoClear = true
    renderer.render(this.bgScene, this.quadCamera)
    renderer.autoClear = false
    renderer.render(this.upscaleScene, this.quadCamera)
    renderer.autoClear = autoClear
  }

  resize(width: number, height: number): void {
    this.liquidMaterial.uniforms.uAspect!.value = width / height
  }

  dispose(): void {
    this.lowTarget.dispose()
    for (const material of this.platformMaterials) material.dispose()
    this.platformMaterials = []
    for (const item of this.disposables) item.dispose()
    this.disposables = []
    this.scoreboard.dispose()
    this.banner.dispose()
    this.bgScene.clear()
    this.gameScene.clear()
    this.upscaleScene.clear()
    this.platformGroup.clear()
  }
}

/**
 * Vertex shader for world-space quads.
 *
 * Unlike the fullscreen variant this respects the model and view matrices, so
 * the same unit plane can be positioned and scaled per entity.
 */
const FULLSCREEN_VERTEX_LOCAL = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
