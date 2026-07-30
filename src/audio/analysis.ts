import { BAND_COUNT, type AudioFrame } from '@/core/types'

const FFT_SIZE = 2048

/** Musically useful span. Below 30Hz is rumble, above 16k is mostly hiss. */
const MIN_HZ = 30
const MAX_HZ = 16000

/** Onset detection ignores the very top end, where cymbal hiss fakes onsets. */
const FLUX_MAX_HZ = 8000

// --- adaptive normalization -------------------------------------------------
// One global ceiling tracks the loudest band, and every band is mapped into a
// fixed dB window below it. This is what lets a quiet mic and a hot line signal
// produce identical visuals with no per-source tuning anywhere downstream.
//
// Deliberately *not* per-band: giving each band its own gain makes every band
// saturate independently, so a kick and a hi-hat both read 1.0 and the spectrum
// loses all shape. A single mapping keeps their relative sizes intact.
//
// Deliberately *not* a chasing floor either: a floor that rises toward the
// signal makes sustained content (a held pad, a steady kick) fade to nothing
// after a few seconds. A fixed window below the ceiling keeps it pinned.
const DYNAMIC_RANGE_DB = 45
const CEIL_FALL_DB_PER_SEC = 3
/** The ceiling never sinks past this, so silence isn't amplified into noise. */
const CEIL_MIN_DB = -72
const INITIAL_FLOOR_DB = -100

/**
 * Music is roughly pink (equal energy per octave), which reads as a spectrum
 * that slumps toward the treble. +3 dB/octave flattens it so the high bands
 * are actually visible without a per-band gain.
 */
const TILT_DB_PER_DECADE = 10

/**
 * Applied to the *untilted* band level. Digital silence and dither sit near
 * -100 dB, and the tilt would otherwise lift that into visible range in the
 * treble. Real musical content in a band stays well above this.
 */
const NOISE_GATE_DB = -95

// --- onsets -----------------------------------------------------------------
const FLUX_HISTORY = 64
/** Threshold is mean + k·stddev of recent flux. Higher = fewer, surer beats. */
const FLUX_THRESHOLD_K = 1.6
/** 300 BPM ceiling — anything faster is a double-trigger, not a beat. */
const MIN_BEAT_GAP_S = 0.2
const BEAT_ENVELOPE_TAU = 4

// --- levels -----------------------------------------------------------------
const LEVEL_ATTACK = 0.5
const LEVEL_RELEASE = 0.06
const SILENCE_RMS = 0.0015
const SILENCE_HOLD_S = 0.5

// --- tempo ------------------------------------------------------------------
const IOI_HISTORY = 24
const BPM_MIN = 70
const BPM_MAX = 180

interface BandRange {
  start: number
  end: number
  centerHz: number
}

/** Coarse groupings scenes actually reach for, in Hz. */
const GROUPS = {
  bass: [30, 140],
  lowMid: [140, 400],
  mid: [400, 2000],
  high: [2000, 6000],
  presence: [6000, 16000],
} as const

type GroupName = keyof typeof GROUPS

function buildBands(sampleRate: number, binCount: number): BandRange[] {
  const nyquist = sampleRate / 2
  const hzPerBin = nyquist / binCount
  const bands: BandRange[] = []
  const logMin = Math.log(MIN_HZ)
  const logMax = Math.log(MAX_HZ)

  for (let i = 0; i < BAND_COUNT; i++) {
    const lowHz = Math.exp(logMin + ((logMax - logMin) * i) / BAND_COUNT)
    const highHz = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / BAND_COUNT)
    const start = Math.max(0, Math.floor(lowHz / hzPerBin))
    // At the bottom, log bands are narrower than one bin; guarantee at least one.
    const end = Math.min(binCount, Math.max(start + 1, Math.ceil(highHz / hzPerBin)))
    bands.push({ start, end, centerHz: Math.sqrt(lowHz * highHz) })
  }
  return bands
}

/**
 * Turns an AnalyserNode into the normalized AudioFrame scenes consume.
 *
 * Everything is preallocated — this runs every frame and must not allocate.
 */
export class SpectrumAnalyser {
  readonly node: AnalyserNode

  private bands: BandRange[]
  private groupRanges: Record<GroupName, [number, number]>

  // WebAudio's getFloat*Data signatures require the non-shared buffer variant.
  private freqDb: Float32Array<ArrayBuffer>
  private timeDomain: Float32Array<ArrayBuffer>
  private mag: Float32Array
  private prevMag: Float32Array

  private bandTilt = new Float32Array(BAND_COUNT)
  private bandDb = new Float32Array(BAND_COUNT)
  private ceilDb = CEIL_MIN_DB
  private bandsOut = new Float32Array(BAND_COUNT)
  private bandsSmoothOut = new Float32Array(BAND_COUNT)

  private fluxHistory = new Float32Array(FLUX_HISTORY)
  private fluxIndex = 0
  private fluxFilled = 0
  private fluxMaxBin: number

  private lastBeatAt = -Infinity
  private beatIntensity = 0
  private beatCount = 0
  private iois: number[] = []
  private bpm: number | null = null

  private level = 0
  private silentFor = 0
  private elapsed = 0

  constructor(context: AudioContext) {
    this.node = context.createAnalyser()
    this.node.fftSize = FFT_SIZE
    // Zero: onset detection needs unsmoothed frames, and `bandsSmooth` gives
    // scenes a smoothed view anyway.
    this.node.smoothingTimeConstant = 0

    const binCount = this.node.frequencyBinCount
    this.freqDb = new Float32Array(binCount)
    this.timeDomain = new Float32Array(this.node.fftSize)
    this.mag = new Float32Array(binCount)
    this.prevMag = new Float32Array(binCount)

    this.bands = buildBands(context.sampleRate, binCount)
    for (let b = 0; b < BAND_COUNT; b++) {
      this.bandTilt[b] = TILT_DB_PER_DECADE * Math.log10(this.bands[b]!.centerHz / MIN_HZ)
    }
    this.fluxMaxBin = Math.min(
      binCount,
      Math.ceil(FLUX_MAX_HZ / (context.sampleRate / 2 / binCount)),
    )

    this.groupRanges = {} as Record<GroupName, [number, number]>
    for (const name of Object.keys(GROUPS) as GroupName[]) {
      const [lo, hi] = GROUPS[name]
      let start = -1
      let end = -1
      for (let i = 0; i < this.bands.length; i++) {
        const hz = this.bands[i]!.centerHz
        if (hz >= lo && hz < hi) {
          if (start < 0) start = i
          end = i + 1
        }
      }
      this.groupRanges[name] = start < 0 ? [0, 1] : [start, end]
    }
  }

  /** Advance one frame and write the result into `out`. */
  process(dt: number, out: AudioFrame): void {
    this.elapsed += dt
    this.node.getFloatFrequencyData(this.freqDb)
    this.node.getFloatTimeDomainData(this.timeDomain)

    // --- loudness ---------------------------------------------------------
    let sumSq = 0
    for (let i = 0; i < this.timeDomain.length; i++) {
      const v = this.timeDomain[i]
      sumSq += v * v
    }
    const rawRms = Math.sqrt(sumSq / this.timeDomain.length)

    if (rawRms < SILENCE_RMS) this.silentFor += dt
    else this.silentFor = 0
    const silent = this.silentFor > SILENCE_HOLD_S

    // --- spectrum ---------------------------------------------------------
    this.prevMag.set(this.mag)
    for (let i = 0; i < this.freqDb.length; i++) {
      const db = this.freqDb[i]
      // -Infinity shows up for empty bins before the first real buffer.
      this.mag[i] = Number.isFinite(db) ? Math.pow(10, db / 20) : 0
    }

    // Pass one: band energies in dB, tilted so the spectrum reads roughly flat.
    let peakDb = -Infinity
    for (let b = 0; b < BAND_COUNT; b++) {
      const { start, end } = this.bands[b]!
      let sum = 0
      for (let i = start; i < end; i++) sum += this.mag[i]
      const meanMag = sum / (end - start)
      const rawDb = meanMag > 0 ? 20 * Math.log10(meanMag) : INITIAL_FLOOR_DB
      // Gate before tilting, so the tilt can't promote noise into signal.
      const db = rawDb < NOISE_GATE_DB ? INITIAL_FLOOR_DB : rawDb + this.bandTilt[b]
      this.bandDb[b] = db
      if (db > peakDb) peakDb = db
    }

    // Ceiling snaps up to any new peak, then sags slowly.
    this.ceilDb = Math.max(peakDb, this.ceilDb - CEIL_FALL_DB_PER_SEC * dt, CEIL_MIN_DB)
    const floorDb = this.ceilDb - DYNAMIC_RANGE_DB

    // Pass two: one shared mapping, so relative band sizes survive.
    for (let b = 0; b < BAND_COUNT; b++) {
      let value = 0
      if (!silent) {
        value = (this.bandDb[b] - floorDb) / DYNAMIC_RANGE_DB
        value = value < 0 ? 0 : value > 1 ? 1 : value
      }
      this.bandsOut[b] = value

      // Asymmetric smoothing: rise quickly, fall gently.
      const prev = this.bandsSmoothOut[b]
      const k = value > prev ? 0.45 : 0.12
      this.bandsSmoothOut[b] = prev + (value - prev) * k
    }

    // --- onsets -----------------------------------------------------------
    let flux = 0
    for (let i = 0; i < this.fluxMaxBin; i++) {
      const d = this.mag[i] - this.prevMag[i]
      if (d > 0) flux += d
    }

    let mean = 0
    const n = this.fluxFilled
    for (let i = 0; i < n; i++) mean += this.fluxHistory[i]
    mean = n > 0 ? mean / n : 0
    let variance = 0
    for (let i = 0; i < n; i++) {
      const d = this.fluxHistory[i] - mean
      variance += d * d
    }
    const stddev = n > 1 ? Math.sqrt(variance / n) : 0

    const threshold = mean + FLUX_THRESHOLD_K * stddev
    const sinceLastBeat = this.elapsed - this.lastBeatAt
    let beat = false

    if (
      !silent &&
      n >= 8 &&
      flux > threshold &&
      threshold > 0 &&
      sinceLastBeat >= MIN_BEAT_GAP_S
    ) {
      beat = true
      this.beatCount++
      this.beatIntensity = Math.min(1, (flux - threshold) / (threshold || 1))
      if (Number.isFinite(sinceLastBeat)) this.pushInterval(sinceLastBeat)
      this.lastBeatAt = this.elapsed
    }

    this.fluxHistory[this.fluxIndex] = flux
    this.fluxIndex = (this.fluxIndex + 1) % FLUX_HISTORY
    if (this.fluxFilled < FLUX_HISTORY) this.fluxFilled++

    // --- level envelope ---------------------------------------------------
    // Normalize rms against the loudest band ceiling so `level` tracks the same
    // auto-gained scale the bands use.
    let loudest = 0
    for (let b = 0; b < BAND_COUNT; b++) loudest = Math.max(loudest, this.bandsOut[b])
    const target = silent ? 0 : loudest
    const lk = target > this.level ? LEVEL_ATTACK : LEVEL_RELEASE
    this.level += (target - this.level) * lk

    // --- write frame ------------------------------------------------------
    out.bands = this.bandsOut
    out.bandsSmooth = this.bandsSmoothOut
    for (const name of Object.keys(GROUPS) as GroupName[]) {
      out[name] = this.groupAverage(name)
    }
    out.rms = Math.min(1, rawRms * 4)
    out.rawRms = rawRms
    out.level = this.level
    out.beat = beat
    out.beatIntensity = this.beatIntensity
    out.beatCount = this.beatCount
    out.sinceBeat = Math.exp(-(this.elapsed - this.lastBeatAt) * BEAT_ENVELOPE_TAU) || 0
    out.bpm = this.bpm
    out.silent = silent
    out.t = this.elapsed
    out.dt = dt
  }

  private groupAverage(name: GroupName): number {
    const [start, end] = this.groupRanges[name]
    let sum = 0
    for (let i = start; i < end; i++) sum += this.bandsOut[i]
    return sum / Math.max(1, end - start)
  }

  private pushInterval(seconds: number): void {
    // Anything outside 0.25–2s between beats is noise, not tempo.
    if (seconds < 0.25 || seconds > 2) return
    this.iois.push(seconds)
    if (this.iois.length > IOI_HISTORY) this.iois.shift()
    if (this.iois.length < 6) return

    const sorted = [...this.iois].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    let bpm = 60 / median
    // Onset detectors routinely lock onto half or double time; fold into range.
    while (bpm < BPM_MIN) bpm *= 2
    while (bpm > BPM_MAX) bpm /= 2
    this.bpm = bpm
  }

  /** Clear adaptive state so a source switch does not inherit stale gain. */
  reset(): void {
    this.ceilDb = CEIL_MIN_DB
    this.bandDb.fill(INITIAL_FLOOR_DB)
    this.bandsOut.fill(0)
    this.bandsSmoothOut.fill(0)
    this.fluxHistory.fill(0)
    this.fluxIndex = 0
    this.fluxFilled = 0
    this.lastBeatAt = -Infinity
    this.beatIntensity = 0
    this.iois.length = 0
    this.bpm = null
    this.level = 0
  }
}

export function createEmptyFrame(): AudioFrame {
  return {
    bands: new Float32Array(BAND_COUNT),
    bandsSmooth: new Float32Array(BAND_COUNT),
    bass: 0,
    lowMid: 0,
    mid: 0,
    high: 0,
    presence: 0,
    rms: 0,
    level: 0,
    rawRms: 0,
    beat: false,
    beatIntensity: 0,
    sinceBeat: 0,
    beatCount: 0,
    bpm: null,
    silent: true,
    t: 0,
    dt: 0,
  }
}
