import * as THREE from 'three'
import type { AudioFrame, CapyScene, ParamSpec, SceneContext } from '@/core/types'
import { FULLSCREEN_VERTEX } from '@/shaders/lib'
import { MANDELBOX_FRAGMENT } from './mandelbox.glsl'
import { HEAD_FRAGMENT, HEAD_VERTEX } from './head.glsl'
import {
  ASPECT_CORRECT,
  FACE_CORE,
  FEATURES,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  type FeatureDriver,
} from './features'

/** The raymarch is the frame budget; render it small and upscale. */
const FRACTAL_SCALE = 0.5

const PHOTO_URL = '/assets/psychedelicCapyFace/capy-face.jpg'

const UPSCALE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSource;
  void main() { gl_FragColor = texture2D(uSource, vUv); }
`

export class PsychedelicCapyFace implements CapyScene {
  readonly id = 'psychedelicCapyFace'
  readonly name = 'Psychedelic Capy Face'
  readonly tags = ['3d', 'fractal', 'photo'] as const

  readonly assets = {
    textures: { face: PHOTO_URL },
  }

  readonly params: readonly ParamSpec[] = [
    { key: 'swell', label: 'Feature swell', min: 0, max: 2.5, step: 0.05, default: 1 },
    { key: 'dome', label: 'Head relief', min: 0, max: 1.5, step: 0.05, default: 1 },
    { key: 'chroma', label: 'Chromatic split', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'complexity', label: 'Fractal glow', min: 0.2, max: 1.5, step: 0.05, default: 1 },
    { key: 'headScale', label: 'Head size', min: 0.5, max: 1.6, step: 0.02, default: 1 },
  ]

  // Fractal pass: fullscreen quad into a half-res target.
  private fractalScene = new THREE.Scene()
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private fractalTarget!: THREE.WebGLRenderTarget
  private fractalMaterial!: THREE.ShaderMaterial

  // Upscale pass: draws the fractal target across the frame.
  private upscaleScene = new THREE.Scene()
  private upscaleMaterial!: THREE.ShaderMaterial

  // Head pass: perspective, drawn over the fractal.
  private headScene = new THREE.Scene()
  private headCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 40)
  private headMaterial!: THREE.ShaderMaterial
  private headMesh!: THREE.Mesh

  private quadGeometry!: THREE.PlaneGeometry
  private headGeometry!: THREE.PlaneGeometry

  private time = 0
  private hue = 0
  /** Smoothed per-feature drive values, so bulges ease rather than snap. */
  private drives = new Float32Array(FEATURES.length)

  async load(ctx: SceneContext): Promise<void> {
    const photo = ctx.assets.textures.face
    if (!photo) throw new Error('psychedelicCapyFace: face texture missing')
    // The head is transparent at the edges; clamping stops the swell distortion
    // from wrapping the opposite side of the photo into view.
    photo.wrapS = THREE.ClampToEdgeWrapping
    photo.wrapT = THREE.ClampToEdgeWrapping

    this.quadGeometry = new THREE.PlaneGeometry(2, 2)

    // --- fractal ----------------------------------------------------------
    this.fractalTarget = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(ctx.width * FRACTAL_SCALE)),
      Math.max(1, Math.round(ctx.height * FRACTAL_SCALE)),
      { depthBuffer: false, generateMipmaps: false },
    )
    this.fractalTarget.texture.colorSpace = THREE.SRGBColorSpace
    this.fractalTarget.texture.minFilter = THREE.LinearFilter
    this.fractalTarget.texture.magFilter = THREE.LinearFilter

    this.fractalMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uResolution: {
          value: new THREE.Vector2(ctx.width * FRACTAL_SCALE, ctx.height * FRACTAL_SCALE),
        },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uLevel: { value: 0 },
        uPunch: { value: 0 },
        uHue: { value: 0 },
        uComplexity: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: MANDELBOX_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.fractalScene.add(new THREE.Mesh(this.quadGeometry, this.fractalMaterial))

    this.upscaleMaterial = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: this.fractalTarget.texture } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: UPSCALE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.upscaleScene.add(new THREE.Mesh(this.quadGeometry, this.upscaleMaterial))

    // --- head -------------------------------------------------------------
    // Plane matches the photo's aspect so nothing is stretched. Heavily
    // subdivided because every bulge is real vertex displacement.
    // Sized so the head occupies roughly half the frame height, leaving the
    // fractal plenty of room to read around it.
    const height = 2.35
    const width = (height * IMAGE_WIDTH) / IMAGE_HEIGHT
    this.headGeometry = new THREE.PlaneGeometry(width, height, 180, 240)

    const positions = FEATURES.map(
      // Flip v: the anchor table is measured from the top of the image, GL
      // texture space counts from the bottom.
      (f) => new THREE.Vector2(f.u, 1 - f.v),
    )

    this.headMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPhoto: { value: photo },
        uTime: { value: 0 },
        uDome: { value: 0.35 },
        uWobble: { value: 1 },
        uLevel: { value: 0 },
        uHue: { value: 0 },
        uPunch: { value: 0 },
        uHigh: { value: 0 },
        uChroma: { value: 1 },
        uAspectCorrect: { value: ASPECT_CORRECT },
        uCoreGrow: { value: 1 },
        uFaceCore: {
          value: new THREE.Vector4(
            FACE_CORE.u,
            1 - FACE_CORE.v,
            FACE_CORE.radiusU,
            FACE_CORE.radiusV,
          ),
        },
        uFeaturePos: { value: positions },
        uFeatureRadius: { value: FEATURES.map((f) => f.radius) },
        uFeatureDrive: { value: Array.from(this.drives) },
        uFeatureSwell: { value: FEATURES.map((f) => f.swell) },
        uFeaturePop: { value: FEATURES.map((f) => f.pop) },
      },
      vertexShader: HEAD_VERTEX,
      fragmentShader: HEAD_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    this.headMesh = new THREE.Mesh(this.headGeometry, this.headMaterial)
    this.headScene.add(this.headMesh)
    this.headCamera.position.set(0, 0, 5.5)
    this.headCamera.lookAt(0, 0, 0)
  }

  update(frame: AudioFrame, params: Record<string, number>): void {
    this.time += frame.dt
    // Hue drifts continuously and jumps on beats, so colour never settles.
    this.hue += frame.dt * 0.05 + (frame.beat ? 0.11 : 0)

    const swell = params.swell ?? 1
    const source: Record<FeatureDriver, number> = {
      bass: frame.bass,
      lowMid: frame.lowMid,
      mid: frame.mid,
      high: frame.high,
      presence: frame.presence,
      punch: frame.sinceBeat,
    }

    // Asymmetric smoothing: swell fast, relax slowly. Instant response reads as
    // flicker at 60fps; the slow release is what makes it look elastic.
    for (let i = 0; i < FEATURES.length; i++) {
      const target = source[FEATURES[i]!.driver] * swell
      const k = target > this.drives[i] ? 0.35 : 0.08
      this.drives[i] += (target - this.drives[i]) * k
    }

    const hu = this.headMaterial.uniforms
    const drive = hu.uFeatureDrive!.value as number[]
    let peak = 0
    for (let i = 0; i < FEATURES.length; i++) {
      drive[i] = this.drives[i]
      peak = Math.max(peak, this.drives[i])
    }

    hu.uTime!.value = this.time
    hu.uHue!.value = this.hue
    hu.uPunch!.value = frame.sinceBeat
    hu.uHigh!.value = frame.high
    hu.uLevel!.value = frame.level
    hu.uDome!.value = 0.35 * (params.dome ?? 1)
    hu.uChroma!.value = params.chroma ?? 1
    // Grow the protected core alongside the bulges so a swollen eye stays solid.
    // Only a slight grow — the ellipse is already close to the fur edge, and
    // overshooting it turns the black backdrop into an opaque halo.
    hu.uCoreGrow!.value = 1 + peak * 0.12

    const scale = params.headScale ?? 1
    this.headMesh.scale.setScalar(scale)
    // Lazy sway, plus a kick on each beat.
    this.headMesh.rotation.y = Math.sin(this.time * 0.23) * 0.16
    this.headMesh.rotation.x = Math.sin(this.time * 0.17) * 0.09
    this.headMesh.rotation.z = Math.sin(this.time * 0.13) * 0.05 + frame.sinceBeat * 0.03
    this.headMesh.position.y = Math.sin(this.time * 0.31) * 0.06 + frame.bass * 0.08

    const fu = this.fractalMaterial.uniforms
    fu.uTime!.value = this.time
    fu.uBass!.value = frame.bass
    fu.uMid!.value = frame.mid
    fu.uHigh!.value = frame.high
    fu.uLevel!.value = frame.level
    fu.uPunch!.value = frame.sinceBeat
    fu.uHue!.value = this.hue
    fu.uComplexity!.value = params.complexity ?? 1
  }

  render(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget()

    renderer.setRenderTarget(this.fractalTarget)
    renderer.render(this.fractalScene, this.quadCamera)

    renderer.setRenderTarget(previous)
    // Two passes into one target: the upscale clears, the head must not.
    const autoClear = renderer.autoClear
    renderer.autoClear = true
    renderer.render(this.upscaleScene, this.quadCamera)
    renderer.autoClear = false
    renderer.render(this.headScene, this.headCamera)
    renderer.autoClear = autoClear
  }

  resize(width: number, height: number): void {
    this.headCamera.aspect = width / height
    this.headCamera.updateProjectionMatrix()

    const w = Math.max(1, Math.round(width * FRACTAL_SCALE))
    const h = Math.max(1, Math.round(height * FRACTAL_SCALE))
    this.fractalTarget.setSize(w, h)
    ;(this.fractalMaterial.uniforms.uResolution!.value as THREE.Vector2).set(w, h)
  }

  dispose(): void {
    this.fractalTarget.dispose()
    this.quadGeometry.dispose()
    this.headGeometry.dispose()
    this.fractalMaterial.dispose()
    this.upscaleMaterial.dispose()
    this.headMaterial.dispose()
    this.fractalScene.clear()
    this.upscaleScene.clear()
    this.headScene.clear()
  }
}
