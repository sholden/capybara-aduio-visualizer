import type { AudioEngine } from '@/audio/AudioEngine'
import type { FrameClock } from '@/core/FrameClock'
import type { SceneDirector } from '@/core/SceneDirector'
import type { Stage } from '@/core/Stage'
import type { Store } from '@/core/Store'

interface DevContext {
  audio: AudioEngine
  stage: Stage
  clock: FrameClock
  director: SceneDirector
  store: Store
}

/**
 * A synthetic signal that can be fed straight into the AudioEngine, so the
 * analyser can be validated without OS capture dialogs: a tone at a known
 * frequency must light the matching bands, and timed noise bursts must produce
 * onsets at a known tempo.
 */
function createTestSignal() {
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()

  const osc = context.createOscillator()
  const oscGain = context.createGain()
  oscGain.gain.value = 0.2
  osc.frequency.value = 100
  osc.connect(oscGain).connect(destination)
  osc.start()

  // Short white-noise buffer reused for every burst.
  const noiseBuffer = context.createBuffer(1, context.sampleRate * 0.2, context.sampleRate)
  const noiseData = noiseBuffer.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1

  let beatTimer: number | undefined

  const burst = () => {
    const src = context.createBufferSource()
    const gain = context.createGain()
    src.buffer = noiseBuffer
    // Sharp attack, fast decay — a percussive envelope the flux detector sees.
    gain.gain.setValueAtTime(0.9, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.15)
    src.connect(gain).connect(destination)
    src.start()
    src.stop(context.currentTime + 0.2)
  }

  return {
    stream: destination.stream,
    setFreq: (hz: number) => {
      osc.frequency.value = hz
    },
    setToneGain: (value: number) => {
      oscGain.gain.value = value
    },
    burst,
    /** Fire bursts at a fixed tempo so the BPM estimate can be checked. */
    startBeat: (bpm: number) => {
      clearInterval(beatTimer)
      beatTimer = setInterval(burst, (60 / bpm) * 1000) as unknown as number
    },
    stopBeat: () => clearInterval(beatTimer),
    close: () => {
      clearInterval(beatTimer)
      void context.close()
    },
  }
}

export function install(ctx: DevContext): void {
  const api = {
    ...ctx,
    /** Attach a synthetic signal to the engine. Returns the signal controls. */
    async testSignal() {
      const signal = createTestSignal()
      await ctx.audio.attachStream(signal.stream, 'mic')
      return signal
    },
    /** Snapshot of the current frame, safe to JSON-serialize. */
    snapshot() {
      const f = ctx.audio.frame
      return {
        bands: Array.from(f.bands, (v) => Number(v.toFixed(3))),
        bass: +f.bass.toFixed(3),
        lowMid: +f.lowMid.toFixed(3),
        mid: +f.mid.toFixed(3),
        high: +f.high.toFixed(3),
        presence: +f.presence.toFixed(3),
        level: +f.level.toFixed(3),
        rawRms: +f.rawRms.toFixed(5),
        beatCount: f.beatCount,
        bpm: f.bpm,
        silent: f.silent,
        fps: +ctx.clock.fps.toFixed(1),
      }
    },
  }
  ;(window as unknown as { __capy: typeof api }).__capy = api
  console.log('[capy] dev hooks ready — window.__capy')
}
