import type { DirectorStatus } from '@/core/SceneDirector'
import type { AudioFrame, AudioSourceKind, RotationMode } from '@/core/types'
import { KEYBOARD_HELP } from '@/input/KeyboardInput'

/** Corner readout: what's playing, what it's listening to, and how it's doing. */
export class Hud {
  private root: HTMLDivElement
  private sceneEl: HTMLSpanElement
  private metaEl: HTMLSpanElement
  private meterEl: HTMLDivElement
  private beatEl: HTMLDivElement
  private lastBeatCount = 0
  private flash = 0

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'hud'
    this.root.innerHTML = `
      <div class="hud-row">
        <span class="hud-scene"></span>
        <div class="hud-beat"></div>
      </div>
      <div class="hud-meter"><i></i></div>
      <span class="hud-meta"></span>
      <span class="hud-help">${KEYBOARD_HELP}</span>
    `
    this.sceneEl = this.root.querySelector('.hud-scene')!
    this.metaEl = this.root.querySelector('.hud-meta')!
    this.meterEl = this.root.querySelector('.hud-meter i')!
    this.beatEl = this.root.querySelector('.hud-beat')!
    parent.append(this.root)
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('is-hidden', !visible)
  }

  update(
    frame: AudioFrame,
    status: DirectorStatus,
    source: AudioSourceKind | null,
    mode: RotationMode,
    fps: number,
  ): void {
    if (this.root.classList.contains('is-hidden')) return

    if (frame.beatCount !== this.lastBeatCount) {
      this.lastBeatCount = frame.beatCount
      this.flash = 1
    }
    this.flash = Math.max(0, this.flash - frame.dt * 5)

    this.sceneEl.textContent = status.currentName ?? 'loading…'

    const bits = [
      source ?? 'no audio',
      mode,
      frame.bpm ? `${frame.bpm.toFixed(0)} bpm` : '— bpm',
      `${fps.toFixed(0)} fps`,
    ]
    if (mode !== 'manual' && !status.transitioning) {
      bits.push(`next in ${status.holdRemaining.toFixed(0)}s`)
    }
    if (status.unavailable.length > 0) {
      bits.push(`${status.unavailable.length} unavailable`)
    }
    this.metaEl.textContent = bits.join(' · ')

    this.meterEl.style.transform = `scaleX(${frame.level.toFixed(3)})`
    this.beatEl.style.opacity = this.flash.toFixed(3)
  }
}
