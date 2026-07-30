import type { AudioSourceKind } from '@/core/types'

/**
 * The one unavoidable click. Both `getDisplayMedia` and resuming a suspended
 * AudioContext require a user gesture, so the show starts behind a button.
 * Doubles as the recovery UI when a capture ends mid-run.
 */
export class StartOverlay {
  private root: HTMLDivElement
  private status: HTMLParagraphElement
  private onPick: (kind: AudioSourceKind) => void

  constructor(parent: HTMLElement, onPick: (kind: AudioSourceKind) => void) {
    this.onPick = onPick

    this.root = document.createElement('div')
    this.root.className = 'start-overlay'
    this.root.innerHTML = `
      <div class="start-card">
        <h1>Capybara Visualizer</h1>
        <p class="start-sub">Pick what the visuals should listen to.</p>
        <div class="start-buttons">
          <button data-kind="system">
            <strong>System audio</strong>
            <span>Spotify, browser, anything playing on this Mac</span>
          </button>
          <button data-kind="mic">
            <strong>Microphone</strong>
            <span>Room sound</span>
          </button>
        </div>
        <p class="start-status"></p>
        <p class="start-hint">
          For system audio, pick a screen or window and tick <em>Share system audio</em>.
        </p>
      </div>
    `

    this.status = this.root.querySelector<HTMLParagraphElement>('.start-status')!
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-kind]')) {
      button.addEventListener('click', () => {
        const kind = button.dataset.kind as AudioSourceKind
        this.setStatus('Starting…')
        this.onPick(kind)
      })
    }

    parent.append(this.root)
  }

  setStatus(message: string, isError = false): void {
    this.status.textContent = message
    this.status.classList.toggle('is-error', isError)
  }

  show(message?: string): void {
    this.root.classList.remove('is-hidden')
    this.setStatus(message ?? '', Boolean(message))
  }

  hide(): void {
    this.root.classList.add('is-hidden')
  }
}
