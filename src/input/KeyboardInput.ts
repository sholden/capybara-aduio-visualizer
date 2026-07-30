import type { Action, ActionHandler, InputSource } from '@/core/types'

/** The one place key codes exist. Everything downstream sees only Actions. */
const BINDINGS: Record<string, Action> = {
  arrowright: { type: 'nextScene' },
  arrowleft: { type: 'prevScene' },
  ' ': { type: 'nextScene' },
  s: { type: 'toggleAudioSource' },
  h: { type: 'toggleHud' },
  d: { type: 'toggleDebug' },
  f: { type: 'toggleFullscreen' },
  m: { type: 'setRotationMode', mode: 'manual' },
  q: { type: 'setRotationMode', mode: 'sequential' },
  r: { type: 'setRotationMode', mode: 'random' },
}

export class KeyboardInput implements InputSource {
  readonly name = 'keyboard'
  private emit: ActionHandler | null = null
  private listener = (event: KeyboardEvent) => this.handle(event)

  attach(emit: ActionHandler): void {
    this.emit = emit
    window.addEventListener('keydown', this.listener)
  }

  detach(): void {
    window.removeEventListener('keydown', this.listener)
    this.emit = null
  }

  /** Scenes are addressable by number key, which the settings panel mirrors. */
  private handle(event: KeyboardEvent): void {
    if (!this.emit) return
    // Never steal keys from the settings panel's own inputs.
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    const key = event.key.toLowerCase()
    const bound = BINDINGS[key]
    if (bound) {
      event.preventDefault()
      this.emit(bound)
      return
    }

    if (key === 'tab' || key === 'escape') {
      event.preventDefault()
      this.emit({ type: 'toggleSettings' })
    }
  }
}

/** Shown in the HUD so the controls are discoverable on the TV itself. */
export const KEYBOARD_HELP =
  '← → scene · S source · M/Q/R mode · H hud · D audio · Tab settings · F full'
