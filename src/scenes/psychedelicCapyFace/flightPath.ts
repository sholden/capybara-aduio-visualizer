/**
 * CPU-side mirror of the Mandelbox distance estimator, used to steer the
 * camera around the fractal instead of through it.
 *
 * Flying into a copy is what made the scene painful to watch: at point-blank
 * range every pixel hits within a step or two, the orbit trap varies wildly
 * between neighbouring pixels, and the palette turns that into full-screen
 * strobing. Keeping a guaranteed standoff distance removes the condition
 * entirely rather than trying to tone down the symptom.
 *
 * This runs once per frame on one point, not per-pixel, so the cost is
 * irrelevant — evaluating the same thing in the shader would mean repeating it
 * for every pixel to compute a value that is identical across the whole frame.
 *
 * MUST stay in sync with `mandelbox.glsl.ts`: same fold count, same CELL, and
 * the scale/minRadius2 values are computed here and passed in as uniforms so
 * both sides are guaranteed to agree.
 */

const FOLD_ITERATIONS = 9
const FIXED_RADIUS2 = 1.0

/**
 * Edge length of the repeating cell — the single source of truth, interpolated
 * into the shader so the CPU steering and the GPU raymarch cannot disagree.
 *
 * Sized from measurement, not taste: at 6.4 the roomiest point in the entire
 * lattice had only ~2.0 units of clearance and 29% of the volume was open, so
 * the camera permanently hugged a surface and the near field rendered as flat
 * colour. At 9 there is roughly triple the headroom and ~76% is open.
 */
export const CELL = 9.0

/**
 * Standoff distance. Comfortably reachable within a CELL of 9 — set it beyond
 * what the lattice can actually provide and the solver below thrashes, which
 * is worse than not steering at all.
 */
const MIN_CLEARANCE = 1.9

/** Cap on how far steering may displace the camera from its nominal path. */
const MAX_OFFSET = 4.0

/** Push iterations per frame. More is smoother in tight spots. */
const PUSH_ITERATIONS = 10

/**
 * Largest single steering step.
 *
 * Without this the step is proportional to how far short of the target we are,
 * which near a surface is enormous — it hurls the camera clear across the
 * lattice into a neighbouring copy, and it oscillates instead of converging.
 */
const MAX_PUSH_STEP = 0.30

/** How quickly the camera eases toward the steered position. */
const FOLLOW_RATE = 5

/** Amplitude of the lazy lateral drift, kept small enough to stay in-corridor. */
const DRIFT_X = 0.55
const DRIFT_Y = 0.4

function mandelboxDistance(
  x: number,
  y: number,
  z: number,
  scale: number,
  minRadius2: number,
): number {
  let px = x
  let py = y
  let pz = z
  let dr = 1

  for (let i = 0; i < FOLD_ITERATIONS; i++) {
    // Box fold.
    px = Math.min(Math.max(px, -1), 1) * 2 - px
    py = Math.min(Math.max(py, -1), 1) * 2 - py
    pz = Math.min(Math.max(pz, -1), 1) * 2 - pz

    // Sphere fold.
    const r2 = px * px + py * py + pz * pz
    if (r2 < minRadius2) {
      const t = FIXED_RADIUS2 / minRadius2
      px *= t
      py *= t
      pz *= t
      dr *= t
    } else if (r2 < FIXED_RADIUS2) {
      const t = FIXED_RADIUS2 / r2
      px *= t
      py *= t
      pz *= t
      dr *= t
    }

    px = scale * px + x
    py = scale * py + y
    pz = scale * pz + z
    dr = dr * Math.abs(scale) + 1
  }

  return Math.hypot(px, py, pz) / Math.abs(dr)
}

/** Distance to the infinitely repeated lattice. */
function latticeDistance(
  x: number,
  y: number,
  z: number,
  scale: number,
  minRadius2: number,
): number {
  const fx = x - CELL * Math.floor(x / CELL + 0.5)
  const fy = y - CELL * Math.floor(y / CELL + 0.5)
  const fz = z - CELL * Math.floor(z / CELL + 0.5)
  return mandelboxDistance(fx, fy, fz, scale, minRadius2)
}

export interface FlightState {
  x: number
  y: number
  z: number
  /** Distance to the nearest surface at the current position. */
  clearance: number
}

/**
 * Drives the camera forward through the lattice while steering it clear of
 * every surface it would otherwise fly into.
 */
export class FlightPath {
  private t = 0
  private x = 0
  private y = 0
  /** Kept unwrapped for smooth integration; wrapped only when read. */
  private z = 0
  private clearance = MIN_CLEARANCE
  /** Lateral offset placing the nominal path down an open corridor. */
  private corridorX = 0
  private corridorY = 0
  private located = false

  /**
   * Find a lane through the lattice with the most headroom along its whole
   * length, and route the flight down it.
   *
   * Without this the path ran through the origin, which is buried deep inside
   * a copy. The per-frame steering did eventually climb out, but it took
   * nearly five seconds of being embedded in geometry — precisely the strobing
   * that makes this scene hard to watch, happening exactly when the scene
   * appears on screen.
   *
   * Runs once, costs a few thousand distance evaluations, and is invisible.
   */
  private locateCorridor(scale: number, minRadius2: number): void {
    const LANES = 10
    const DEPTH_SAMPLES = 20
    let best = -Infinity

    for (let i = 0; i < LANES; i++) {
      for (let j = 0; j < LANES; j++) {
        const ox = (i / (LANES - 1) - 0.5) * CELL
        const oy = (j / (LANES - 1) - 0.5) * CELL

        // Score a lane by its *tightest* point over a full cell of travel, and
        // at the extremes of the lateral drift, so the whole flight stays clear
        // rather than just its centre line.
        let worst = Infinity
        for (let k = 0; k < DEPTH_SAMPLES; k++) {
          const z = (k / DEPTH_SAMPLES) * CELL
          worst = Math.min(
            worst,
            latticeDistance(ox, oy, z, scale, minRadius2),
            latticeDistance(ox + DRIFT_X, oy + DRIFT_Y, z, scale, minRadius2),
            latticeDistance(ox - DRIFT_X, oy - DRIFT_Y, z, scale, minRadius2),
          )
        }

        if (worst > best) {
          best = worst
          this.corridorX = ox
          this.corridorY = oy
        }
      }
    }

    this.x = this.corridorX
    this.y = this.corridorY
    this.located = true
  }

  advance(dt: number, scale: number, minRadius2: number): void {
    if (!this.located) this.locateCorridor(scale, minRadius2)
    this.t += dt

    // Nominal path: bounded lateral drift plus steady forward travel, routed
    // along the corridor found at startup.
    const nominalX = this.corridorX + Math.sin(this.t * 0.06) * DRIFT_X
    const nominalY = this.corridorY + Math.cos(this.t * 0.045) * DRIFT_Y
    const nominalZ = this.z - dt * 0.42

    let x = nominalX
    let y = nominalY
    let z = nominalZ

    // Slide along the gradient until clear of any surface. Pushing along the
    // normal rather than simply halting means the camera rounds obstacles
    // instead of stalling in front of them.
    let distance = latticeDistance(x, y, z, scale, minRadius2)
    for (let i = 0; i < PUSH_ITERATIONS && distance < MIN_CLEARANCE; i++) {
      const e = 0.02
      const gx = latticeDistance(x + e, y, z, scale, minRadius2) - distance
      const gy = latticeDistance(x, y + e, z, scale, minRadius2) - distance
      const gz = latticeDistance(x, y, z + e, scale, minRadius2) - distance
      const length = Math.hypot(gx, gy, gz) || 1

      const push = Math.min((MIN_CLEARANCE - distance) * 0.6, MAX_PUSH_STEP)
      x += (gx / length) * push
      y += (gy / length) * push
      z += (gz / length) * push

      distance = latticeDistance(x, y, z, scale, minRadius2)
    }

    // Never let steering drag the camera arbitrarily far off the path.
    const dx = x - nominalX
    const dy = y - nominalY
    const dz = z - nominalZ
    const offset = Math.hypot(dx, dy, dz)
    if (offset > MAX_OFFSET) {
      const k = MAX_OFFSET / offset
      x = nominalX + dx * k
      y = nominalY + dy * k
      z = nominalZ + dz * k
    }

    // Ease toward the steered target so corrections read as gentle banking
    // rather than a snap.
    const follow = Math.min(1, dt * FOLLOW_RATE)
    this.x += (x - this.x) * follow
    this.y += (y - this.y) * follow
    this.z += (z - this.z) * follow
    this.clearance = latticeDistance(this.x, this.y, this.z, scale, minRadius2)
  }

  /** Current position, with z wrapped into one cell. */
  get state(): FlightState {
    return {
      x: this.x,
      y: this.y,
      // The scene is exactly periodic in CELL, so wrapping renders identically
      // while keeping the value the shader sees small and precise.
      z: ((this.z % CELL) + CELL) % CELL,
      clearance: this.clearance,
    }
  }
}

/**
 * Fold parameters, computed here so the CPU steering and the GPU raymarch are
 * guaranteed to be describing the same shape.
 */
export function foldParameters(time: number, bass: number, mid: number) {
  return {
    scale: -2.05 + bass * 0.26 + Math.sin(time * 0.09) * 0.08,
    minRadius2: 0.25 + mid * 0.12,
  }
}
