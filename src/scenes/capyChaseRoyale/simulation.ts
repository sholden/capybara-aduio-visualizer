import {
  CAPY_HEIGHT,
  CAPY_WIDTH,
  GRAVITY,
  GROUND_TOP,
  JUMP_SPEED,
  RUN_SPEED,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  generateLevel,
  type Level,
  type Platform,
} from './world'

export const CAPY_COUNT = 10

/** How close a chaser must get before the straw comes out. */
const CATCH_RANGE = 1.2

/**
 * Separation the pair snap to when the straw comes out, in world units.
 *
 * Catch range is deliberately short, but the bodies are CAPY_WIDTH across, so
 * at the moment of contact the two are overlapping and there is physically no
 * room between a mouth and a rear for the straw to span. Snapping to a fixed
 * gap — chaser directly behind, both facing the same way, matched height — is
 * what lets the straw actually connect the two ends every time instead of
 * landing at whatever angle the chase happened to end at.
 *
 * Derived from the sprite: the straw tip reaches ~1.1 local units ahead of the
 * chaser's centre and the victim's rear sits ~0.5 behind its own, and one local
 * unit is CAPY_WIDTH. Slightly under the sum, so the tip stays inserted even as
 * the victim inflates and its rear pushes further back.
 */
const CONTACT_GAP = 2.5

/**
 * How long a chaser must stay on its target before the catch lands.
 *
 * Without this, catches trigger the instant two capybaras brush past each
 * other, and a full round of ten collapsed in under six seconds — far too fast
 * to follow. Requiring sustained pursuit turns each elimination into a visible
 * chase.
 */
const GRAB_TIME = 0.30

/**
 * Round escalation.
 *
 * Rounds were bimodal: either over in seconds, or two survivors on separate
 * towers orbiting each other until the time limit. Ramping speed and reach as
 * the round ages breaks those stalemates without making the opening frantic.
 */
const ESCALATION_START = 10
const ESCALATION_RATE = 0.08
/**
 * Victim's full stun: a frozen contact hold, then a spin-up.
 *
 * The hold covers the whole straw animation so the pair stay locked together
 * in the pose while the eyes and body balloon; the remainder is the spin before
 * the wings come out.
 */
const STUN_TIME = 2.6
/** Frozen portion of the stun. Matches BLOW_TIME so both sides unfreeze together. */
const HOLD_TIME = 2.0
/** Wings-out drifting-away phase. Long and slow, so the exit is savoured. */
const FLY_TIME = 3.4
/** How long the straw stays out. Exported so the sprite can animate against it. */
export const BLOW_TIME = 2.0
/**
 * Pause on the winner before the next round starts. Comfortably longer than a
 * flight, so a late victim finishes leaving before the level resets.
 */
const CELEBRATION_TIME = 4.6
/**
 * Hard cap on a round.
 *
 * Without it a round can run forever — two capybaras on separate towers that
 * keep just missing each other will happily chase all night, and the scene
 * would sit on round 1 for the rest of the installation.
 */
const ROUND_TIME_LIMIT = 42

export type CapyState = 'active' | 'stunned' | 'flying' | 'gone'

export interface Capy {
  index: number
  x: number
  y: number
  vx: number
  vy: number
  facing: 1 | -1
  grounded: boolean
  state: CapyState
  /** Counts down within the current state. */
  timer: number
  /** Squash/stretch, 1 is neutral. */
  squash: number
  /** 0..1, drives how wide the eyes are drawn. */
  eyeScale: number
  /** Radians; only non-zero while spinning away. */
  spin: number
  /** 0..1, wings fade in before the escape. */
  wings: number
  /** 0..1, how far the body has ballooned after taking the straw. */
  puff: number
  /** >0 while holding the straw out after a successful chase. */
  blowTimer: number
  /** Total score across the whole scene. */
  score: number
  /** Chase-downs in the current round only. */
  roundCatches: number
  /** Index of the capybara currently being chased, or -1. */
  targetIndex: number
  /** Blocks instant re-catching after a catch. */
  catchCooldown: number
  /** Time spent locked onto the current victim, counting toward GRAB_TIME. */
  grabTimer: number
  /** Nudges the AI to commit to a jump for a moment. */
  jumpUrge: number
  /**
   * Minimum contact time after landing before jumping again.
   *
   * Without it capybaras re-launched on the very frame they touched down and
   * spent 86% of the round airborne, which read as the whole crowd floating
   * rather than bouncing around a platformer.
   */
  landLock: number
}

export type RoundPhase = 'playing' | 'celebrating'

export interface SimulationEvents {
  /** A caught another capybara. Used to trigger sound or extra flourish. */
  onCatch?: (chaser: Capy, victim: Capy) => void
  onRoundEnd?: (winner: Capy | null, round: number) => void
}

export class Simulation {
  readonly capys: Capy[] = []
  level!: Level
  round = 1
  phase: RoundPhase = 'playing'
  phaseTimer = 0
  roundTimer = 0
  winnerIndex = -1
  /** Bumped whenever the scoreboard needs redrawing. */
  revision = 0

  private seed: number
  private events: SimulationEvents
  /** Rotates catch-resolution order so no index is systematically favoured. */
  private tick = 0

  constructor(seed: number, events: SimulationEvents = {}) {
    this.seed = seed
    this.events = events

    for (let i = 0; i < CAPY_COUNT; i++) {
      this.capys.push({
        index: i,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        facing: 1,
        grounded: false,
        state: 'active',
        timer: 0,
        squash: 1,
        eyeScale: 0,
        spin: 0,
        wings: 0,
        puff: 0,
        blowTimer: 0,
        score: 0,
        roundCatches: 0,
        targetIndex: -1,
        catchCooldown: 0,
        grabTimer: 0,
        jumpUrge: 0,
        landLock: 0,
      })
    }

    this.startRound(1)
  }

  get activeCount(): number {
    return this.capys.filter((c) => c.state === 'active').length
  }

  private startRound(round: number): void {
    this.round = round
    this.level = generateLevel(round, this.seed)
    this.phase = 'playing'
    this.phaseTimer = 0
    this.roundTimer = 0
    this.winnerIndex = -1

    const random = mulberrySpawn(this.seed + round * 104729)
    const spawns = this.level.spawns

    for (const capy of this.capys) {
      const spawn = spawns[Math.floor(random() * spawns.length)]!
      capy.x = Math.min(
        WORLD_WIDTH - CAPY_WIDTH,
        Math.max(0, spawn.x + (random() - 0.5) * 3),
      )
      capy.y = spawn.y + 0.05
      capy.vx = 0
      capy.vy = 0
      capy.facing = random() > 0.5 ? 1 : -1
      capy.grounded = true
      capy.state = 'active'
      capy.timer = 0
      capy.squash = 1
      capy.eyeScale = 0
      capy.spin = 0
      capy.wings = 0
      capy.puff = 0
      capy.blowTimer = 0
      capy.roundCatches = 0
      capy.targetIndex = -1
      capy.catchCooldown = 0
      capy.grabTimer = 0
      capy.jumpUrge = 0
      capy.landLock = 0
    }

    this.revision++
  }

  /**
   * Advance the simulation.
   *
   * `beat` makes every grounded capybara hop, which is what ties the whole
   * scene to the music — the crowd pulses on the downbeat.
   */
  update(dt: number, beat: boolean, energy: number): void {
    if (this.phase === 'celebrating') {
      this.phaseTimer -= dt
      // Keep running the full state machine, not just physics. Integrating
      // alone froze victims mid-elimination — they kept their bulging eyes,
      // never sprouted wings, and simply dropped onto a platform and sat there
      // through the whole celebration.
      for (const capy of this.capys) this.advance(capy, dt, false, beat, energy)
      if (this.phaseTimer <= 0) this.startRound(this.round + 1)
      return
    }

    this.roundTimer += dt

    for (const capy of this.capys) this.advance(capy, dt, true, beat, energy)

    this.resolveCatches(dt)

    const remaining = this.capys.filter((c) => c.state === 'active')
    if (remaining.length <= 1 || this.roundTimer > ROUND_TIME_LIMIT) {
      this.endRound(remaining)
    }
  }

  /** One capybara's per-frame update. `chase` is off during celebrations. */
  private advance(
    capy: Capy,
    dt: number,
    chase: boolean,
    beat: boolean,
    energy: number,
  ): void {
    if (capy.blowTimer > 0) capy.blowTimer = Math.max(0, capy.blowTimer - dt)
    if (capy.catchCooldown > 0) capy.catchCooldown -= dt
    if (capy.landLock > 0) capy.landLock -= dt

    switch (capy.state) {
      case 'active':
        if (capy.blowTimer > 0) {
          // Holding the straw in: frozen in the pose alongside the victim.
          capy.vx = 0
          capy.vy = 0
          break
        }
        if (chase) this.think(capy, dt, beat, energy)
        this.integrate(capy, dt)
        break
      case 'stunned': {
        capy.timer -= dt
        const elapsed = STUN_TIME - capy.timer

        // Eyes and body swell over the course of the hold.
        capy.eyeScale = Math.min(1, capy.eyeScale + dt / (HOLD_TIME * 0.55))
        capy.puff = Math.min(1, capy.puff + dt / (HOLD_TIME * 0.7))

        if (elapsed < HOLD_TIME) {
          // Frozen at the moment of contact — no gravity, no drift. Both
          // capybaras hang in the pose while the air goes in, which is what
          // makes the hit land instead of flashing past.
          capy.vx = 0
          capy.vy = 0
          capy.squash = 1 + Math.sin(elapsed * 38) * 0.05 * capy.puff
        } else {
          capy.spin += dt * (5 + (elapsed - HOLD_TIME) * 14)
          capy.vx *= 0.86
          this.integrate(capy, dt)
        }

        if (capy.timer <= 0) {
          capy.state = 'flying'
          capy.timer = FLY_TIME
        }
        break
      }
      case 'flying':
        capy.timer -= dt
        capy.wings = Math.min(1, capy.wings + dt * 3)
        capy.spin += dt * 1.4
        // Wings beat and it drifts gently upward — a slow, dopey departure
        // rather than being fired off the screen.
        capy.vy = 2.5 + (FLY_TIME - capy.timer) * 2.2
        capy.vx += capy.facing * dt * 2.5
        capy.x += capy.vx * dt
        capy.y += capy.vy * dt
        if (capy.timer <= 0 || capy.y > WORLD_HEIGHT + 3) capy.state = 'gone'
        break
      case 'gone':
        break
    }
  }

  private endRound(remaining: Capy[]): void {
    let winner: Capy | null = null
    if (remaining.length === 1) {
      winner = remaining[0]!
    } else if (remaining.length > 1) {
      // Timed out: the most successful chaser still standing takes it.
      winner = remaining.reduce((best, c) =>
        c.roundCatches > best.roundCatches ? c : best,
      )
    }

    if (winner) {
      // Survival bonus on top of the points already banked per chase-down, so
      // the scoreboard rewards both aggression and lasting the round out.
      winner.score += 1 + winner.roundCatches
      this.winnerIndex = winner.index
    }

    this.phase = 'celebrating'
    this.phaseTimer = CELEBRATION_TIME
    this.revision++
    this.events.onRoundEnd?.(winner, this.round)
  }

  private think(capy: Capy, dt: number, beat: boolean, energy: number): void {
    const target = this.pickTarget(capy)
    capy.targetIndex = target ? target.index : -1

    if (target) {
      const dx = target.x - capy.x
      const dy = target.y - capy.y
      const direction = Math.sign(dx) || 1
      capy.facing = direction as 1 | -1

      // Chase harder when the music is loud, and a little harder late in a
      // round — but only a little. Scaling raw speed by the full escalation
      // backfired: at 20+ units/s the final two crossed the catch window in
      // less time than the grab takes, so escalation actively prevented the
      // catches it exists to force. Reach and grab leniency carry it instead.
      const speed =
        RUN_SPEED * (0.8 + energy * 0.5) * Math.min(1.35, this.escalation())
      const control = capy.grounded ? 12 : 5

      let desiredVx = direction * speed
      // Once alongside, match the target's pace instead of barrelling past it.
      // Sprinting straight through meant only ~0.16s inside catch range, well
      // under the grab time, so head-on catches could never land at all.
      if (Math.abs(dx) < 2.6 * this.escalation() && Math.abs(dy) < CAPY_HEIGHT) {
        desiredVx = target.vx + direction * 2.4
      }
      capy.vx += (desiredVx - capy.vx) * Math.min(1, dt * control)

      // Vertical pursuit. Rounds used to stall out because survivors settled on
      // different rows: the catch test and the tailing behaviour both require
      // being at roughly the same height, so two capybaras a floor apart would
      // chase past each other indefinitely until the round timed out.
      const wantsHeight = dy > 0.8
      const wantsDrop = dy < -0.8
      const ledgeAhead = !this.groundAhead(capy, direction)

      let shouldJump = false
      if (capy.grounded && capy.landLock <= 0) {
        if (wantsHeight) {
          // Platforms are one-way, so jumping from underneath lands on top of
          // them — but only if we are roughly in the target's column already.
          shouldJump = Math.abs(dx) < 4
        } else if (wantsDrop) {
          // Target is below: walk off the edge rather than jumping, which would
          // only keep us up here longer.
          shouldJump = false
        } else if (ledgeAhead || capy.jumpUrge > 0) {
          shouldJump = true
        }
      }

      if (shouldJump) {
        // A banked beat urge is still only a hop; a full launch is reserved for
        // actually needing to reach somewhere.
        const fromBeat = capy.jumpUrge > 0 && !wantsHeight && !ledgeAhead
        capy.vy = fromBeat ? JUMP_SPEED * 0.4 : JUMP_SPEED
        capy.grounded = false
        capy.squash = 0.72
        capy.jumpUrge = 0
      }
    } else {
      capy.vx *= 0.9
    }

    // Gentle mutual separation. There is no capybara-capybara collision, so
    // without this a whole pack settles into the exact same pixel and reads as
    // one smeared blob. Deliberately weak and short-ranged so it never stops a
    // chaser closing to catch range.
    for (const other of this.capys) {
      if (other.index === capy.index || other.state === 'gone') continue
      const gapX = capy.x - other.x
      if (Math.abs(gapX) < 0.7 && Math.abs(capy.y - other.y) < 1.0) {
        capy.vx += (gapX >= 0 ? 1 : -1) * dt * 3.5
      }
    }

    // Everyone hops on the beat — a small bounce, not a full jump. A navigation
    // jump hangs for ~0.9s, longer than the gap between beats at any normal
    // tempo, so beat-jumping at full power left every capybara permanently
    // airborne and the whole crowd just floated.
    if (beat) {
      if (capy.grounded && capy.landLock <= 0) {
        capy.vy = JUMP_SPEED * (0.32 + energy * 0.16)
        capy.grounded = false
        capy.squash = 0.78
      } else {
        capy.jumpUrge = 0.4
      }
    }
    if (capy.jumpUrge > 0) capy.jumpUrge -= dt
  }

  private pickTarget(capy: Capy): Capy | null {
    let best: Capy | null = null
    let bestDistance = Infinity
    for (const other of this.capys) {
      if (other.index === capy.index || other.state !== 'active') continue
      const dx = other.x - capy.x
      const dy = other.y - capy.y
      // Weight vertical distance heavily: something two platforms up is a far
      // worse target than something the same distance away on this floor.
      const distance = dx * dx + dy * dy * 2.5
      if (distance < bestDistance) {
        bestDistance = distance
        best = other
      }
    }
    return best
  }

  /** Is there platform under the capybara a short step ahead? */
  private groundAhead(capy: Capy, direction: number): boolean {
    const probeX = capy.x + direction * (CAPY_WIDTH * 0.5 + 0.9)
    const footY = capy.y
    for (const platform of this.level.platforms) {
      const top = platform.y + platform.height
      if (Math.abs(top - footY) > 0.35) continue
      if (probeX >= platform.x - 0.2 && probeX <= platform.x + platform.width + 0.2) {
        return true
      }
    }
    return false
  }

  private integrate(capy: Capy, dt: number): void {
    if (capy.state === 'gone') return

    capy.vy += GRAVITY * dt
    const previousBottom = capy.y

    capy.x += capy.vx * dt
    capy.y += capy.vy * dt

    // Soft walls so nobody leaves the arena sideways.
    if (capy.x < 0) {
      capy.x = 0
      capy.vx = Math.abs(capy.vx) * 0.5
    } else if (capy.x > WORLD_WIDTH - CAPY_WIDTH) {
      capy.x = WORLD_WIDTH - CAPY_WIDTH
      capy.vx = -Math.abs(capy.vx) * 0.5
    }

    // Capture the previous contact state before clearing it. Testing
    // `capy.grounded` after this reset always reads false, which meant the
    // landing lock was re-armed every frame a capybara stood still and never
    // expired — jumping was blocked entirely.
    const wasGrounded = capy.grounded
    capy.grounded = false
    if (capy.vy <= 0) {
      for (const platform of this.level.platforms) {
        if (!this.landsOn(capy, platform, previousBottom)) continue
        capy.y = platform.y + platform.height
        capy.vy = 0
        if (!wasGrounded) capy.landLock = 0.14
        capy.grounded = true
        // Land with a squash that springs back in `integrate`'s tail.
        capy.squash = Math.min(capy.squash, 0.8)
        break
      }
    }

    if (capy.y < GROUND_TOP) {
      capy.y = GROUND_TOP
      capy.vy = 0
      if (!wasGrounded) capy.landLock = 0.14
      capy.grounded = true
    }

    // Ease squash back toward neutral, and stretch a little while rising.
    const targetSquash = capy.grounded ? 1 : 1 + Math.min(0.25, Math.abs(capy.vy) * 0.008)
    capy.squash += (targetSquash - capy.squash) * Math.min(1, dt * 9)
  }

  /**
   * One-way platforms: a capybara only lands when its feet cross the top from
   * above. Passing up through a platform is intentional — solid platforms make
   * the AI get stuck underneath ledges constantly.
   */
  private landsOn(capy: Capy, platform: Platform, previousBottom: number): boolean {
    const top = platform.y + platform.height
    if (previousBottom < top - 0.01) return false
    if (capy.y > top) return false
    const left = platform.x - CAPY_WIDTH * 0.45
    const right = platform.x + platform.width + CAPY_WIDTH * 0.45
    return capy.x + CAPY_WIDTH * 0.5 >= left && capy.x + CAPY_WIDTH * 0.5 <= right
  }

  private resolveCatches(dt: number): void {
    const count = this.capys.length
    // Rotate who is evaluated first. Fixed index order meant low-numbered
    // capybaras always won mutual approaches, and over four simulated minutes
    // capy 0 scored 85 against capy 9's 2.
    this.tick = (this.tick + 1) % count
    const reach = CATCH_RANGE * this.escalation()

    for (let k = 0; k < count; k++) {
      const chaser = this.capys[(k + this.tick) % count]!
      if (chaser.state !== 'active' || chaser.catchCooldown > 0) {
        chaser.grabTimer = 0
        continue
      }

      let locked = false
      for (const victim of this.capys) {
        if (victim.index === chaser.index || victim.state !== 'active') continue
        // Whoever is mid-blow is untouchable until the straw comes out — being
        // boofed while frozen in your own boofing pose would read as a bug.
        if (victim.blowTimer > 0) continue

        const dx = victim.x - chaser.x
        const dy = victim.y - chaser.y
        if (Math.abs(dy) > CAPY_HEIGHT * 0.9) continue
        if (Math.abs(dx) > reach) continue

        // The straw goes in from behind, so the chaser has to actually be
        // facing its quarry rather than bumping into it backwards.
        if (Math.sign(dx) !== chaser.facing) continue

        // Must sustain the pursuit — a brush past is not a catch. The required
        // hold shortens as the round drags, so a stubborn final duel resolves
        // instead of running out the clock.
        locked = true
        chaser.grabTimer += dt
        if (chaser.grabTimer < GRAB_TIME / this.escalation()) break

        chaser.grabTimer = 0
        victim.state = 'stunned'
        victim.timer = STUN_TIME
        victim.eyeScale = 0
        victim.puff = 0
        victim.spin = 0
        // No knockback: the pair hold the pose together while the air goes in.
        victim.vx = 0
        victim.vy = 0

        // Snap into the pose. Both face the same way so the chaser's mouth is
        // behind the victim's rear, and the correction is split between them so
        // neither visibly teleports.
        const dir = chaser.facing
        victim.facing = dir
        const midX = (chaser.x + victim.x) * 0.5
        const midY = (chaser.y + victim.y) * 0.5
        let chaserX = midX - dir * CONTACT_GAP * 0.5
        let victimX = midX + dir * CONTACT_GAP * 0.5

        // Nudge the pair as a unit if the pose overhangs the arena edge.
        // Clamping each independently squeezed them together against a wall and
        // the straw ended up buried in the victim rather than spanning the gap.
        const maxX = WORLD_WIDTH - CAPY_WIDTH
        const leftMost = Math.min(chaserX, victimX)
        const rightMost = Math.max(chaserX, victimX)
        const shift = leftMost < 0 ? -leftMost : rightMost > maxX ? maxX - rightMost : 0
        chaserX += shift
        victimX += shift

        chaser.x = clamp(chaserX, 0, maxX)
        victim.x = clamp(victimX, 0, maxX)
        chaser.y = midY
        victim.y = midY
        chaser.vx = 0
        chaser.vy = 0

        chaser.blowTimer = BLOW_TIME
        // Long enough that a chaser cannot chain straight into the next
        // victim, which is what let whole rounds evaporate in a few seconds.
        chaser.catchCooldown = 1.0
        chaser.roundCatches++
        chaser.score++
        this.revision++

        this.events.onCatch?.(chaser, victim)
        break
      }

      // Decay rather than reset: a momentary slip during a scrappy chase
      // shouldn't throw away all the pursuit already banked.
      if (!locked) chaser.grabTimer = Math.max(0, chaser.grabTimer - dt * 2)
    }
  }

  /**
   * Grows from 1 as a round drags on, scaling chase speed and reach.
   *
   * Two survivors circling each other on separate towers would otherwise run
   * out the clock; this closes the gap on them rather than waiting for the
   * timeout to end an anticlimactic round.
   */
  private escalation(): number {
    return 1 + Math.max(0, this.roundTimer - ESCALATION_START) * ESCALATION_RATE
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Separate stream from level generation so spawn jitter varies independently. */
function mulberrySpawn(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
