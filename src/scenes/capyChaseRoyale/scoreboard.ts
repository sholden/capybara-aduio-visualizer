import * as THREE from 'three'
import { CAPY_COLORS, CAPY_NAMES } from './world'
import type { Capy } from './simulation'

/** Matches the foreground target's width so one canvas pixel is one game pixel. */
const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 44

function css(rgb: readonly [number, number, number], scale = 1): string {
  const to255 = (v: number) => Math.round(Math.min(1, v * scale) * 255)
  return `rgb(${to255(rgb[0])}, ${to255(rgb[1])}, ${to255(rgb[2])})`
}

/**
 * Scoreboard strip drawn into a canvas and uploaded as a texture.
 *
 * Canvas 2D rather than geometry because this needs real text, and it lives
 * inside the scene rather than as a DOM overlay so it crossfades with
 * everything else when the director rotates scenes.
 *
 * Redrawn only when the simulation's revision changes — scores move a few times
 * a round, not every frame.
 */
export class Scoreboard {
  readonly texture: THREE.CanvasTexture
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private lastRevision = -1

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = CANVAS_WIDTH
    this.canvas.height = CANVAS_HEIGHT
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('capyChaseRoyale: 2D context unavailable')
    this.ctx = ctx

    this.texture = new THREE.CanvasTexture(this.canvas)
    // Nearest on both, or the text turns to soup when blown up to a TV.
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.colorSpace = THREE.SRGBColorSpace
  }

  /** Redraw if anything changed. Cheap to call every frame. */
  update(
    capys: readonly Capy[],
    round: number,
    revision: number,
    winnerIndex: number,
  ): void {
    if (revision === this.lastRevision) return
    this.lastRevision = revision
    this.draw(capys, round, winnerIndex)
    this.texture.needsUpdate = true
  }

  private draw(capys: readonly Capy[], round: number, winnerIndex: number): void {
    const { ctx } = this
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

    ctx.fillStyle = 'rgba(6, 5, 12, 0.93)'
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
    ctx.fillStyle = 'rgba(150, 190, 255, 0.30)'
    ctx.fillRect(0, CANVAS_HEIGHT - 2, CANVAS_WIDTH, 2)

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'

    ctx.fillStyle = '#cfe3ff'
    ctx.fillText(`ROUND ${round}`, 8, 12)

    // Ten entries across two rows of five, which fits the width at a legible
    // size where a single row of ten would not.
    const columns = 5
    const cellWidth = (CANVAS_WIDTH - 96) / columns
    for (let i = 0; i < capys.length; i++) {
      const capy = capys[i]!
      const color = CAPY_COLORS[i]!
      const column = i % columns
      const row = Math.floor(i / columns)
      const x = 96 + column * cellWidth
      const y = 12 + row * 18

      // Colour chip identifies who is who; the name is secondary.
      ctx.fillStyle = css(color, capy.state === 'gone' ? 0.4 : 1)
      ctx.fillRect(x, y - 5, 9, 9)

      if (i === winnerIndex) {
        ctx.strokeStyle = '#ffe9a8'
        ctx.lineWidth = 1
        ctx.strokeRect(x - 1.5, y - 6.5, 12, 12)
      }

      const dimmed = capy.state === 'gone' || capy.state === 'flying'
      ctx.fillStyle = dimmed ? 'rgba(207,227,255,0.45)' : '#cfe3ff'
      ctx.fillText(`${CAPY_NAMES[i]!.slice(0, 4)} ${capy.score}`, x + 14, y)
    }
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * Centre banner announcing the round winner.
 *
 * Separate canvas from the scoreboard so it can be shown and hidden without
 * forcing a scoreboard redraw.
 */
export class Banner {
  readonly texture: THREE.CanvasTexture
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private lastKey = ''

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 360
    this.canvas.height = 60
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('capyChaseRoyale: 2D context unavailable')
    this.ctx = ctx

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.colorSpace = THREE.SRGBColorSpace
  }

  update(winnerIndex: number, round: number, catches: number): void {
    const key = `${winnerIndex}:${round}:${catches}`
    if (key === this.lastKey) return
    this.lastKey = key

    const { ctx } = this
    ctx.clearRect(0, 0, 360, 60)
    if (winnerIndex < 0) {
      this.texture.needsUpdate = true
      return
    }

    ctx.fillStyle = 'rgba(6, 5, 12, 0.80)'
    ctx.fillRect(0, 0, 360, 60)
    ctx.strokeStyle = css(CAPY_COLORS[winnerIndex]!)
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, 358, 58)

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = css(CAPY_COLORS[winnerIndex]!)
    ctx.fillText(`${CAPY_NAMES[winnerIndex]!} WINS ROUND ${round}`, 180, 22)

    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillStyle = '#cfe3ff'
    ctx.fillText(`${catches} boofed into outer space`, 180, 44)

    ctx.textAlign = 'left'
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
