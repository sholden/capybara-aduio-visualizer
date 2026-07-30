/** Tab-switch and GC stalls produce huge dt spikes; clamp so nothing teleports. */
const MAX_DT = 1 / 20

/** Per-frame timing plus a smoothed FPS readout for the HUD. */
export class FrameClock {
  private last = performance.now() / 1000
  private start = this.last
  private fpsSmooth = 60

  /** Seconds since the clock was created. */
  t = 0
  /** Seconds since the previous tick, clamped. */
  dt = 0

  tick(): void {
    const now = performance.now() / 1000
    const raw = now - this.last
    this.last = now
    this.dt = Math.min(raw, MAX_DT)
    this.t = now - this.start

    if (raw > 0) {
      // Exponential smoothing — a raw per-frame FPS number is unreadable.
      this.fpsSmooth += (1 / raw - this.fpsSmooth) * 0.05
    }
  }

  get fps(): number {
    return this.fpsSmooth
  }
}
