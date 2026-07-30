import type { AudioSourceKind, RotationMode } from './types'

export interface Settings {
  audioSource: AudioSourceKind
  rotationMode: RotationMode
  /** Seconds a scene holds before rotating, when not in manual mode. */
  rotationIntervalSec: number
  /** Scenes excluded from rotation. Stored as the exclusion set so a newly
   *  added scene is enabled by default rather than silently missing. */
  disabledScenes: string[]
  resolutionScale: number
  showHud: boolean
  /** sceneId -> paramKey -> value */
  sceneParams: Record<string, Record<string, number>>
}

const DEFAULTS: Settings = {
  audioSource: 'system',
  rotationMode: 'sequential',
  rotationIntervalSec: 45,
  disabledScenes: [],
  resolutionScale: 1,
  showHud: true,
  sceneParams: {},
}

const STORAGE_KEY = 'capybara.settings.v1'

type Listener = (settings: Settings) => void

/**
 * Settings state, persisted and observable.
 *
 * Kept deliberately separate from any UI: the lil-gui panel is just one view
 * over this, so a phone remote or MIDI surface can read and write the exact
 * same state later without touching the panel code.
 */
export class Store {
  private state: Settings
  private listeners = new Set<Listener>()

  constructor() {
    this.state = this.load()
  }

  get settings(): Readonly<Settings> {
    return this.state
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  update(patch: Partial<Settings>): void {
    this.state = { ...this.state, ...patch }
    this.persist()
    for (const fn of this.listeners) fn(this.state)
  }

  isSceneEnabled(id: string): boolean {
    return !this.state.disabledScenes.includes(id)
  }

  setSceneEnabled(id: string, enabled: boolean): void {
    const disabled = new Set(this.state.disabledScenes)
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    this.update({ disabledScenes: [...disabled] })
  }

  getSceneParams(id: string): Record<string, number> {
    return this.state.sceneParams[id] ?? {}
  }

  setSceneParam(id: string, key: string, value: number): void {
    const forScene = { ...this.getSceneParams(id), [key]: value }
    this.update({ sceneParams: { ...this.state.sceneParams, [id]: forScene } })
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { ...DEFAULTS }
      // Merge over defaults so a stored blob from an older build still boots.
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      // Private browsing or a full quota — settings just won't survive reload.
    }
  }
}
