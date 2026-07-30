import type { AudioFrame, AudioSourceKind } from '@/core/types'

const GROUPS = ['bass', 'lowMid', 'mid', 'high', 'presence'] as const

/**
 * A plain 2D-canvas readout of everything the analyser produces. Its whole job
 * is making the DSP tunable against real music — bar heights, beat flashes and
 * the BPM lock are far easier to judge by eye than by logging numbers.
 */
export class AudioDebugView {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private beatFlash = 0
  private lastBeatCount = 0

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'audio-debug'
    parent.append(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for the debug view')
    this.ctx = ctx
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  setVisible(visible: boolean): void {
    this.canvas.classList.toggle('is-hidden', !visible)
  }

  get visible(): boolean {
    return !this.canvas.classList.contains('is-hidden')
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(window.innerWidth * dpr)
    this.canvas.height = Math.round(window.innerHeight * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  draw(frame: AudioFrame, source: AudioSourceKind | null, fps: number): void {
    if (!this.visible) return

    const { ctx } = this
    const w = window.innerWidth
    const h = window.innerHeight

    if (frame.beatCount !== this.lastBeatCount) {
      this.lastBeatCount = frame.beatCount
      this.beatFlash = 1
    }
    this.beatFlash = Math.max(0, this.beatFlash - frame.dt * 4)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = `rgb(${20 + this.beatFlash * 40}, ${16 + this.beatFlash * 22}, ${14 + this.beatFlash * 16})`
    ctx.fillRect(0, 0, w, h)

    // --- spectrum ---------------------------------------------------------
    const pad = 48
    const chartW = w - pad * 2
    const chartH = h * 0.45
    const chartY = h * 0.58
    const bands = frame.bands
    const barW = chartW / bands.length

    for (let i = 0; i < bands.length; i++) {
      const value = bands[i]
      const barH = value * chartH
      const hue = 20 + (i / bands.length) * 45
      ctx.fillStyle = `hsl(${hue} 55% ${28 + value * 32}%)`
      ctx.fillRect(pad + i * barW, chartY - barH, barW - 2, barH)
    }

    // Smoothed envelope drawn over the raw bars.
    ctx.strokeStyle = 'rgba(232, 222, 210, 0.75)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < frame.bandsSmooth.length; i++) {
      const x = pad + i * barW + barW / 2
      const y = chartY - frame.bandsSmooth[i] * chartH
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(232, 222, 210, 0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad, chartY)
    ctx.lineTo(pad + chartW, chartY)
    ctx.stroke()

    // --- group meters -----------------------------------------------------
    const meterY = h * 0.68
    const meterW = chartW / GROUPS.length
    ctx.font = '11px ui-monospace, monospace'
    for (let i = 0; i < GROUPS.length; i++) {
      const name = GROUPS[i]
      const value = frame[name]
      const x = pad + i * meterW
      ctx.fillStyle = 'rgba(255,255,255,0.07)'
      ctx.fillRect(x, meterY, meterW - 8, 14)
      ctx.fillStyle = `hsl(${25 + i * 12} 60% 55%)`
      ctx.fillRect(x, meterY, (meterW - 8) * value, 14)
      ctx.fillStyle = 'rgba(232,222,210,0.75)'
      ctx.fillText(`${name} ${value.toFixed(2)}`, x, meterY + 30)
    }

    // --- level + beat -----------------------------------------------------
    const levelY = h * 0.78
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fillRect(pad, levelY, chartW, 18)
    ctx.fillStyle = '#c89f6b'
    ctx.fillRect(pad, levelY, chartW * frame.level, 18)
    ctx.fillStyle = 'rgba(232,222,210,0.5)'
    ctx.fillText(`level ${frame.level.toFixed(3)}`, pad, levelY + 34)

    // sinceBeat envelope, the value scenes actually use for punch.
    const punchY = levelY + 46
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fillRect(pad, punchY, chartW, 10)
    ctx.fillStyle = '#3c7f7a'
    ctx.fillRect(pad, punchY, chartW * frame.sinceBeat, 10)

    // --- text readout -----------------------------------------------------
    ctx.font = '13px ui-monospace, monospace'
    ctx.fillStyle = '#e8ded2'
    const lines = [
      `source    ${source ?? 'none'}`,
      `fps       ${fps.toFixed(0)}`,
      `bpm       ${frame.bpm ? frame.bpm.toFixed(1) : '—'}`,
      `beats     ${frame.beatCount}`,
      `intensity ${frame.beatIntensity.toFixed(2)}`,
      `rawRms    ${frame.rawRms.toFixed(5)}`,
      `silent    ${frame.silent ? 'yes' : 'no'}`,
    ]
    lines.forEach((line, i) => ctx.fillText(line, pad, 40 + i * 20))

    if (this.beatFlash > 0.01) {
      ctx.fillStyle = `rgba(224, 138, 76, ${this.beatFlash})`
      ctx.beginPath()
      ctx.arc(w - pad - 30, 60, 14 + this.beatFlash * 8, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = 'rgba(232,222,210,0.35)'
    ctx.font = '11px ui-monospace, monospace'
    ctx.fillText('D debug · S source · F fullscreen', pad, h - 24)
  }
}
