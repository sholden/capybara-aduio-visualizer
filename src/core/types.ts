import type * as THREE from 'three'

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** Which capture path is feeding the analyser. */
export type AudioSourceKind = 'system' | 'mic'

/** Number of log-spaced bands in `AudioFrame.bands`. */
export const BAND_COUNT = 32

/**
 * One frame of analysed audio. This is the *only* thing scenes see — they never
 * touch raw FFT data and never learn which source is live, so a scene authored
 * against the mic behaves identically on system audio.
 *
 * Every field except `bpm`, `t` and `dt` is normalized to roughly 0..1 by the
 * auto-gain stage, so scenes can use values directly without per-source tuning.
 */
export interface AudioFrame {
  /** Log-spaced spectrum, normalized. Length is BAND_COUNT. */
  bands: Float32Array
  /** Same bands with a slow decay applied — good for sustained visual state. */
  bandsSmooth: Float32Array

  /** Coarse energy groupings, normalized. */
  bass: number
  lowMid: number
  mid: number
  high: number
  presence: number

  /** Overall loudness, normalized. */
  rms: number
  /** Fast-attack / slow-decay envelope of rms. Good for punchy reactions. */
  level: number
  /** Raw pre-gain loudness in 0..1. Useful for silence UI, not for visuals. */
  rawRms: number

  /** True on the single frame an onset is detected. */
  beat: boolean
  /** 0..1 strength of the most recent onset. */
  beatIntensity: number
  /** Ramps 1 -> 0 across the interval since the last beat. */
  sinceBeat: number
  /** Running count of detected beats. Handy for stepping animation frames. */
  beatCount: number
  /** Estimated tempo, or null until enough onsets are seen. */
  bpm: number | null

  /** True when the input has been near-silent for a moment. */
  silent: boolean

  /** Seconds since the engine started. */
  t: number
  /** Seconds since the previous frame, clamped to survive tab-switch stalls. */
  dt: number
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * A texture to load. Use the object form for pixel art: `pixelated` sets
 * nearest-neighbour filtering, without which sprite sheets turn to mush the
 * moment they're scaled up to a TV.
 */
export type TextureSpec = string | { url: string; pixelated?: boolean }

/** Declared up front so the director can preload and so failures are graceful. */
export interface AssetManifest {
  textures?: Record<string, TextureSpec>
  models?: Record<string, string>
}

/** Loaded assets handed to a scene, keyed the same as its manifest. */
export interface LoadedAssets {
  textures: Record<string, THREE.Texture>
  models: Record<string, THREE.Object3D>
}

/** A scene-tunable knob, surfaced in settings and to any future remote. */
export interface ParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

/** Everything a scene needs from the host at load time. */
export interface SceneContext {
  renderer: THREE.WebGLRenderer
  /** Drawing-buffer size in pixels, already scaled by resolution setting. */
  width: number
  height: number
  assets: LoadedAssets
  /** Current values for this scene's declared params. */
  params: Record<string, number>
}

/**
 * A scene is a self-contained visual. The director owns its lifecycle:
 * load -> (update/render)* -> dispose. Scenes must release every GPU resource
 * they allocate in dispose(), since a rotation runs for hours.
 */
export interface CapyScene {
  readonly id: string
  readonly name: string
  readonly tags: readonly string[]
  readonly assets?: AssetManifest
  readonly params?: readonly ParamSpec[]

  load(ctx: SceneContext): Promise<void>
  update(frame: AudioFrame, params: Record<string, number>): void
  /** Render into whatever target is currently bound by the director. */
  render(renderer: THREE.WebGLRenderer): void
  resize(width: number, height: number): void
  dispose(): void
}

/** Scenes are registered as factories so nothing is constructed until needed. */
export interface SceneRegistration {
  id: string
  name: string
  tags: readonly string[]
  create: () => CapyScene
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type RotationMode = 'manual' | 'sequential' | 'random'

/**
 * Semantic actions, deliberately decoupled from key codes. A phone remote or
 * MIDI controller is just another emitter of these — no core changes needed.
 */
export type Action =
  | { type: 'nextScene' }
  | { type: 'prevScene' }
  | { type: 'gotoScene'; id: string }
  | { type: 'setRotationMode'; mode: RotationMode }
  | { type: 'setSceneEnabled'; id: string; enabled: boolean }
  | { type: 'setAudioSource'; source: AudioSourceKind }
  | { type: 'toggleAudioSource' }
  | { type: 'setParam'; scene: string; key: string; value: number }
  | { type: 'toggleSettings' }
  | { type: 'toggleHud' }
  | { type: 'toggleDebug' }
  | { type: 'toggleFullscreen' }

export type ActionHandler = (action: Action) => void

/** Anything that can drive the app. Implementations: keyboard, remote, MIDI. */
export interface InputSource {
  readonly name: string
  attach(emit: ActionHandler): void
  detach(): void
}
