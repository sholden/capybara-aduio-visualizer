import type * as THREE from 'three'
import type { AssetLoader } from './AssetLoader'
import type { Compositor } from './Compositor'
import type { Stage } from './Stage'
import type { Store } from './Store'
import type { AudioFrame, CapyScene, SceneRegistration } from './types'

const TRANSITION_SEC = 1.2

interface ActiveScene {
  registration: SceneRegistration
  scene: CapyScene
}

export interface DirectorStatus {
  currentId: string | null
  currentName: string | null
  nextId: string | null
  transitioning: boolean
  holdRemaining: number
  unavailable: string[]
}

/**
 * Owns scene lifecycle and rotation.
 *
 * Two properties matter most for something that runs unattended for hours:
 * the next scene is loaded *while the current one is still playing*, so
 * rotation never hitches; and a scene that fails to load is quarantined and
 * skipped rather than taking the show down.
 */
export class SceneDirector {
  private current: ActiveScene | null = null
  private incoming: ActiveScene | null = null
  private preloaded: ActiveScene | null = null
  private preloading: string | null = null
  private plannedNextId: string | null = null

  private transitionT = 0
  private transitioning = false
  private hold = 0
  private unavailable = new Set<string>()
  private starting = false

  constructor(
    private stage: Stage,
    private store: Store,
    private compositor: Compositor,
    private assets: AssetLoader,
    private registry: readonly SceneRegistration[],
  ) {
    this.stage.onResize((w, h) => {
      this.compositor.resize(w, h)
      this.current?.scene.resize(w, h)
      this.incoming?.scene.resize(w, h)
      this.preloaded?.scene.resize(w, h)
    })
  }

  get status(): DirectorStatus {
    return {
      currentId: this.current?.registration.id ?? null,
      currentName: this.current?.registration.name ?? null,
      nextId: this.plannedNextId,
      transitioning: this.transitioning,
      holdRemaining: Math.max(0, this.holdDuration - this.hold),
      unavailable: [...this.unavailable],
    }
  }

  /** Registrations that are neither disabled nor quarantined. */
  get playable(): SceneRegistration[] {
    return this.registry.filter(
      (r) => this.store.isSceneEnabled(r.id) && !this.unavailable.has(r.id),
    )
  }

  private get holdDuration(): number {
    return Math.max(5, this.store.settings.rotationIntervalSec)
  }

  async start(): Promise<void> {
    if (this.current || this.starting) return
    this.starting = true
    try {
      const first = this.playable[0] ?? this.registry[0]
      if (!first) throw new Error('no scenes registered')
      const active = await this.instantiate(first)
      if (!active) throw new Error('the first scene failed to load')
      this.current = active
      this.hold = 0
      this.planNext()
    } finally {
      this.starting = false
    }
  }

  next(): void {
    void this.beginTransition(this.plannedNextId ?? this.pickNextId(1))
  }

  prev(): void {
    void this.beginTransition(this.pickNextId(-1))
  }

  goto(id: string): void {
    if (id === this.current?.registration.id) return
    void this.beginTransition(id)
  }

  update(frame: AudioFrame): void {
    const dt = frame.dt

    if (!this.transitioning && this.store.settings.rotationMode !== 'manual') {
      this.hold += dt
      if (this.hold >= this.holdDuration && this.playable.length > 1) {
        this.hold = 0
        this.next()
      }
    }

    this.current?.scene.update(frame, this.paramsFor(this.current))
    this.incoming?.scene.update(frame, this.paramsFor(this.incoming))

    if (this.transitioning) {
      this.transitionT += dt / TRANSITION_SEC
      if (this.transitionT >= 1) this.finishTransition()
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.current) return

    this.compositor.renderInto(renderer, this.current.scene, 'from')
    if (this.transitioning && this.incoming) {
      this.compositor.renderInto(renderer, this.incoming.scene, 'to')
      this.compositor.present(renderer, this.transitionT)
    } else {
      this.compositor.present(renderer, 0)
    }
  }

  dispose(): void {
    this.current?.scene.dispose()
    this.incoming?.scene.dispose()
    this.preloaded?.scene.dispose()
    this.current = this.incoming = this.preloaded = null
  }

  // -------------------------------------------------------------------------

  private paramsFor(active: ActiveScene): Record<string, number> {
    const stored = this.store.getSceneParams(active.registration.id)
    const resolved: Record<string, number> = {}
    for (const spec of active.scene.params ?? []) {
      resolved[spec.key] = stored[spec.key] ?? spec.default
    }
    return resolved
  }

  private pickNextId(direction: 1 | -1): string | null {
    const options = this.playable
    if (options.length === 0) return null
    if (options.length === 1) return options[0]!.id

    const currentId = this.current?.registration.id
    if (this.store.settings.rotationMode === 'random' && direction === 1) {
      const others = options.filter((r) => r.id !== currentId)
      const pick = others[Math.floor(Math.random() * others.length)]
      return (pick ?? options[0]!).id
    }

    const index = options.findIndex((r) => r.id === currentId)
    // A current scene that was just disabled won't be found; start from 0.
    const base = index < 0 ? 0 : index
    const nextIndex = (base + direction + options.length) % options.length
    return options[nextIndex]!.id
  }

  /** Decide what plays next and warm it up while the current scene runs. */
  private planNext(): void {
    this.plannedNextId = this.pickNextId(1)
    const id = this.plannedNextId
    if (!id || id === this.current?.registration.id) return
    if (this.preloaded?.registration.id === id || this.preloading === id) return

    const registration = this.registry.find((r) => r.id === id)
    if (!registration) return

    this.preloading = id
    void this.instantiate(registration).then((active) => {
      if (this.preloading !== id) {
        // A newer plan superseded this one while it was loading.
        active?.scene.dispose()
        return
      }
      this.preloading = null
      this.preloaded?.scene.dispose()
      this.preloaded = active
      if (!active) this.planNext()
    })
  }

  private async beginTransition(id: string | null): Promise<void> {
    if (this.transitioning || !id) return
    if (!this.current) return
    if (id === this.current.registration.id) return

    let active: ActiveScene | null
    if (this.preloaded?.registration.id === id) {
      active = this.preloaded
      this.preloaded = null
    } else {
      const registration = this.registry.find((r) => r.id === id)
      if (!registration) return
      // Not preloaded — the current scene keeps rendering while this loads, so
      // the wait costs nothing visually.
      active = await this.instantiate(registration)
    }

    if (!active) {
      this.planNext()
      return
    }

    this.incoming = active
    this.transitionT = 0
    this.transitioning = true
  }

  private finishTransition(): void {
    if (!this.incoming) return
    this.current?.scene.dispose()
    this.current = this.incoming
    this.incoming = null
    this.transitioning = false
    this.transitionT = 0
    this.hold = 0
    this.planNext()
  }

  private async instantiate(
    registration: SceneRegistration,
  ): Promise<ActiveScene | null> {
    try {
      const scene = registration.create()
      const assets = await this.assets.load(scene.assets)
      await scene.load({
        renderer: this.stage.renderer,
        width: this.stage.width,
        height: this.stage.height,
        assets,
        params: {},
      })
      scene.resize(this.stage.width, this.stage.height)
      return { registration, scene }
    } catch (error) {
      // Quarantine rather than crash: one broken asset must not end the show.
      console.error(`[capy] scene "${registration.id}" failed to load`, error)
      this.unavailable.add(registration.id)
      return null
    }
  }
}
