import * as THREE from 'three'

/** Beyond ~2x the extra pixels cost real frame time and buy nothing on a TV. */
const MAX_PIXEL_RATIO = 2

export type ResizeListener = (width: number, height: number) => void

/**
 * Owns the canvas, the WebGL renderer and sizing policy.
 *
 * Sizing has two independent dials: the browser's devicePixelRatio (capped) and
 * a user-facing `resolutionScale`. The heavier 3D scenes can be dropped to 0.75
 * or 0.5 from the settings panel without touching any scene code.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly canvas: HTMLCanvasElement

  /** Drawing-buffer size in pixels — what scenes and render targets size to. */
  width = 1
  height = 1

  private resolutionScale = 1
  private listeners = new Set<ResizeListener>()
  private observer: ResizeObserver

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The crossfade compositor needs a stable backbuffer to blit into.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor(0x000000, 1)
    // Only affects materials that include the tonemapping shader chunk — i.e.
    // the lit 3D scenes. The 2D ShaderMaterial scenes are untouched and keep
    // their own hand-rolled curves. TVs oversaturate, so this matters there.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15

    this.observer = new ResizeObserver(() => this.applySize())
    this.observer.observe(canvas)
    this.applySize()
  }

  /** 0.25..1. Lower trades sharpness for frame time on demanding scenes. */
  setResolutionScale(scale: number): void {
    const next = THREE.MathUtils.clamp(scale, 0.25, 1)
    if (next === this.resolutionScale) return
    this.resolutionScale = next
    this.applySize()
  }

  getResolutionScale(): number {
    return this.resolutionScale
  }

  onResize(fn: ResizeListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private applySize(): void {
    const cssWidth = this.canvas.clientWidth || window.innerWidth
    const cssHeight = this.canvas.clientHeight || window.innerHeight
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)

    const width = Math.max(1, Math.round(cssWidth * pixelRatio * this.resolutionScale))
    const height = Math.max(1, Math.round(cssHeight * pixelRatio * this.resolutionScale))
    if (width === this.width && height === this.height) return

    this.width = width
    this.height = height

    // `false` keeps CSS size at 100vw/100vh so the buffer can differ from it.
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)

    for (const fn of this.listeners) fn(width, height)
  }

  dispose(): void {
    this.observer.disconnect()
    this.listeners.clear()
    this.renderer.dispose()
  }
}
