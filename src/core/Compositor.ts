import * as THREE from 'three'
import type { CapyScene } from './types'

/** MSAA on the offscreen targets; the resolution slider is the escape hatch. */
const SAMPLES = 4

const BLIT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

/**
 * Crossfade with a soft luminance-weighted bias, so the incoming scene's bright
 * areas punch through first. A straight linear mix between two busy scenes
 * reads as a muddy dissolve; this keeps the transition legible.
 */
const BLIT_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uFrom;
  uniform sampler2D uTo;
  uniform float uMix;

  void main() {
    vec4 a = texture2D(uFrom, vUv);
    vec4 b = texture2D(uTo, vUv);

    float lumB = dot(b.rgb, vec3(0.299, 0.587, 0.114));
    // Bright incoming pixels reach full opacity slightly ahead of dark ones.
    // Kept mild — at 0.6 a bright scene swallowed the outgoing one by the
    // halfway point, which read as a cut rather than a fade.
    float bias = clamp(uMix * (1.0 + lumB * 0.22), 0.0, 1.0);
    gl_FragColor = mix(a, b, smoothstep(0.0, 1.0, bias));
  }
`

/**
 * Owns the offscreen targets and the final present pass.
 *
 * Every scene renders into a target rather than straight to the canvas, even
 * when nothing is transitioning. Keeping one pipeline avoids a class of bugs
 * where a scene behaves differently mid-transition, and leaves an obvious seam
 * for global post-processing later.
 */
export class Compositor {
  private from: THREE.WebGLRenderTarget
  private to: THREE.WebGLRenderTarget
  private quadScene = new THREE.Scene()
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private material: THREE.ShaderMaterial
  private geometry = new THREE.PlaneGeometry(2, 2)

  constructor(width: number, height: number) {
    this.from = Compositor.createTarget(width, height)
    this.to = Compositor.createTarget(width, height)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFrom: { value: this.from.texture },
        uTo: { value: this.to.texture },
        uMix: { value: 0 },
      },
      vertexShader: BLIT_VERTEX,
      fragmentShader: BLIT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.quadScene.add(new THREE.Mesh(this.geometry, this.material))
  }

  private static createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      samples: SAMPLES,
      depthBuffer: true,
      stencilBuffer: false,
    })
    target.texture.colorSpace = THREE.SRGBColorSpace
    return target
  }

  resize(width: number, height: number): void {
    this.from.setSize(width, height)
    this.to.setSize(width, height)
  }

  /** Render a scene into one of the two slots. */
  renderInto(
    renderer: THREE.WebGLRenderer,
    scene: CapyScene,
    slot: 'from' | 'to',
  ): void {
    const target = slot === 'from' ? this.from : this.to
    renderer.setRenderTarget(target)
    renderer.clear()
    scene.render(renderer)
    renderer.setRenderTarget(null)
  }

  /** Draw the composite to the canvas. `mix` of 0 shows `from`, 1 shows `to`. */
  present(renderer: THREE.WebGLRenderer, mix: number): void {
    this.material.uniforms.uFrom!.value = this.from.texture
    this.material.uniforms.uTo!.value = this.to.texture
    this.material.uniforms.uMix!.value = mix
    renderer.setRenderTarget(null)
    renderer.render(this.quadScene, this.quadCamera)
  }

  dispose(): void {
    this.from.dispose()
    this.to.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
