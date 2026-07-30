/**
 * Shared world constants and level generation.
 *
 * The simulation and the renderer both work in these world units — 32 wide by
 * 18 tall, origin bottom-left, matching 16:9 — so nothing ever converts between
 * coordinate spaces.
 */

export const WORLD_WIDTH = 32
export const WORLD_HEIGHT = 18

/** Height reserved at the top for the scoreboard; platforms stay below it. */
export const HUD_HEIGHT = 2.2

/**
 * Sized against the pixel grid, not chosen freely: the foreground renders at
 * 640x360 across a 32x18 world, so one world unit is 20 pixels and a capybara
 * lands at roughly 40x30 px — big enough for eyes, straw and wings to read as
 * distinct pixel-art features.
 */
export const CAPY_WIDTH = 2.0
export const CAPY_HEIGHT = 1.5

// --- physics ---------------------------------------------------------------
export const GRAVITY = -40
export const JUMP_SPEED = 18
export const RUN_SPEED = 7.5
/** Peak jump height, derived: v²/2g ≈ 4.05 world units. */
export const JUMP_HEIGHT = (JUMP_SPEED * JUMP_SPEED) / (2 * -GRAVITY)

export const GROUND_TOP = 1.2
/**
 * Vertical spacing between platform rows. Must stay under JUMP_HEIGHT or the
 * upper rows become unreachable and rounds stall out with capybaras stranded
 * on separate levels unable to reach each other.
 */
export const ROW_SPACING = 3.4

export interface Platform {
  x: number
  y: number
  width: number
  height: number
  /** Stable 0..1 value used to vary colour and glow phase per platform. */
  tint: number
}

export interface Level {
  round: number
  platforms: Platform[]
  /** Points capybaras can be spawned at, all standing on a platform top. */
  spawns: { x: number; y: number }[]
}

/** Small deterministic PRNG so a given round always builds the same level. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a platform layout for a round.
 *
 * Platforms are laid out in rows spaced under one jump height apart, so every
 * row is reachable from the one below it. Within a row they are placed with
 * gaps, which is what makes the chases interesting — capybaras have to commit
 * to a jump rather than walking anywhere they like.
 */
export function generateLevel(round: number, seed: number): Level {
  const random = mulberry32(seed + round * 7919)
  const platforms: Platform[] = []

  // Solid ground so nothing can ever fall out of the world.
  platforms.push({
    x: 0,
    y: 0,
    width: WORLD_WIDTH,
    height: GROUND_TOP,
    tint: random(),
  })

  const topLimit = WORLD_HEIGHT - HUD_HEIGHT - 1.2
  const rowCount = Math.max(2, Math.floor((topLimit - GROUND_TOP) / ROW_SPACING))

  for (let row = 0; row < rowCount; row++) {
    const y = GROUND_TOP + ROW_SPACING * (row + 1)
    const count = 2 + Math.floor(random() * 3)

    // Divide the row into slots and jitter one platform inside each, which
    // spreads them out without ever letting two overlap.
    const slotWidth = WORLD_WIDTH / count
    for (let slot = 0; slot < count; slot++) {
      const width = 3.5 + random() * 3.5
      const slack = Math.max(0, slotWidth - width - 1.5)
      const x = slot * slotWidth + 0.75 + random() * slack
      platforms.push({
        x,
        y,
        width: Math.min(width, WORLD_WIDTH - x - 0.5),
        height: 0.75,
        tint: random(),
      })
    }
  }

  const spawns = platforms.map((p) => ({
    x: p.x + p.width * 0.5,
    y: p.y + p.height,
  }))

  return { round, platforms, spawns }
}

/** The ten competitors, each visually distinct at a glance from across a room. */
export const CAPY_COLORS: readonly [number, number, number][] = [
  [0.98, 0.45, 0.35], // coral
  [0.99, 0.75, 0.29], // amber
  [0.95, 0.93, 0.42], // lemon
  [0.55, 0.88, 0.42], // lime
  [0.30, 0.82, 0.60], // mint
  [0.35, 0.80, 0.95], // sky
  [0.42, 0.55, 0.98], // blue
  [0.68, 0.48, 0.97], // violet
  [0.95, 0.50, 0.85], // magenta
  [0.98, 0.98, 0.98], // white
]

export const CAPY_NAMES: readonly string[] = [
  'CORAL',
  'AMBER',
  'LEMON',
  'LIME',
  'MINT',
  'SKY',
  'BLUE',
  'VIOLET',
  'MAGENTA',
  'SNOW',
]
