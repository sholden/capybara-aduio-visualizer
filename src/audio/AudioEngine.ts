import type { AudioFrame, AudioSourceKind } from '@/core/types'
import { SpectrumAnalyser, createEmptyFrame } from './analysis'
import { AudioSourceError, openSource } from './sources'

export type AudioEngineEvent =
  | { type: 'sourceChanged'; source: AudioSourceKind }
  | { type: 'sourceEnded'; source: AudioSourceKind }
  | { type: 'error'; error: AudioSourceError }

type Listener = (event: AudioEngineEvent) => void

/**
 * Owns the AudioContext and whichever capture is currently live, and produces
 * one normalized AudioFrame per rendered frame.
 *
 * Scenes read `frame` and nothing else — switching between mic and system audio
 * is invisible to them by design.
 */
export class AudioEngine {
  readonly frame: AudioFrame = createEmptyFrame()

  private context: AudioContext | null = null
  private analyser: SpectrumAnalyser | null = null
  private zeroGain: GainNode | null = null
  private stream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private currentSource: AudioSourceKind | null = null
  private listeners = new Set<Listener>()
  /** Guards against overlapping switches when keys are mashed. */
  private switching: Promise<void> | null = null

  get source(): AudioSourceKind | null {
    return this.currentSource
  }

  get ready(): boolean {
    return this.analyser !== null && this.sourceNode !== null
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 0
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(event: AudioEngineEvent): void {
    for (const fn of this.listeners) fn(event)
  }

  /**
   * Must be called from a user gesture: both getDisplayMedia and resuming a
   * suspended AudioContext require one.
   */
  async setSource(kind: AudioSourceKind): Promise<void> {
    // Serialize switches so a fast toggle can't leave two streams live.
    const chained = (this.switching ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const stream = await openSource(kind)
        await this.attachStream(stream, kind)
      })

    this.switching = chained.catch((err) => {
      const error =
        err instanceof AudioSourceError
          ? err
          : new AudioSourceError(String(err), kind, true)
      this.emit({ type: 'error', error })
    })

    return chained
  }

  async toggleSource(): Promise<void> {
    return this.setSource(this.currentSource === 'system' ? 'mic' : 'system')
  }

  /**
   * Route an already-open MediaStream into the analyser.
   *
   * This is the seam `setSource` is built on, and it is also what an
   * app-plays-its-own-audio mode would use: pipe a
   * MediaStreamAudioDestinationNode in here and every scene reacts to it with
   * no other changes.
   */
  async attachStream(stream: MediaStream, kind: AudioSourceKind): Promise<void> {
    this.teardownStream()

    const context = this.ensureContext()
    if (context.state === 'suspended') await context.resume()

    const analyser = this.ensureAnalyser(context)
    analyser.reset()

    const sourceNode = context.createMediaStreamSource(stream)
    sourceNode.connect(analyser.node)

    this.stream = stream
    this.sourceNode = sourceNode
    this.currentSource = kind

    // Chrome's "Stop sharing" button, or unplugging a mic, ends the track.
    const [track] = stream.getAudioTracks()
    track?.addEventListener('ended', () => {
      if (this.stream !== stream) return
      this.teardownStream()
      this.currentSource = null
      this.emit({ type: 'sourceEnded', source: kind })
    })

    this.emit({ type: 'sourceChanged', source: kind })
  }

  /** Advance analysis one frame. Cheap and safe to call before any source. */
  update(dt: number): AudioFrame {
    if (this.analyser) this.analyser.process(dt, this.frame)
    else this.frame.dt = dt
    return this.frame
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
    }
    return this.context
  }

  private ensureAnalyser(context: AudioContext): SpectrumAnalyser {
    if (!this.analyser) {
      this.analyser = new SpectrumAnalyser(context)
      // An AnalyserNode with no path to the destination is not guaranteed to be
      // pulled. A muted gain node keeps the graph live without making sound —
      // critical for mic input, which would otherwise feed back.
      this.zeroGain = context.createGain()
      this.zeroGain.gain.value = 0
      this.analyser.node.connect(this.zeroGain)
      this.zeroGain.connect(context.destination)
    }
    return this.analyser
  }

  private teardownStream(): void {
    this.sourceNode?.disconnect()
    this.sourceNode = null
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
  }

  async dispose(): Promise<void> {
    this.teardownStream()
    this.listeners.clear()
    this.zeroGain?.disconnect()
    this.analyser?.node.disconnect()
    this.analyser = null
    this.zeroGain = null
    await this.context?.close()
    this.context = null
    this.currentSource = null
  }
}
