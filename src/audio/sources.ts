import type { AudioSourceKind } from '@/core/types'

/**
 * Browser audio processing is tuned for speech and will wreck music dynamics:
 * AGC flattens exactly the loud/quiet contrast the visuals feed on, and noise
 * suppression eats sustained tones. Off for both sources, always.
 */
const RAW_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
}

export class AudioSourceError extends Error {
  constructor(
    message: string,
    readonly kind: AudioSourceKind,
    readonly recoverable: boolean,
  ) {
    super(message)
    this.name = 'AudioSourceError'
  }
}

/**
 * System audio via getDisplayMedia. Needs macOS 14.2+ and Chrome 141+, both of
 * which this machine clears.
 *
 * Chrome requires a video track to be *requested* even when only audio is
 * wanted, so we ask for video and immediately stop that track — the audio track
 * survives on its own and we avoid paying for a screen capture we never read.
 */
export async function openSystemAudio(): Promise<MediaStream> {
  let display: MediaStream
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: RAW_AUDIO,
      // Nudges Chrome's picker toward the tab/window list rather than a screen,
      // and keeps the local echo of the captured audio playing normally.
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    } as DisplayMediaStreamOptions)
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'NotAllowedError'
    throw new AudioSourceError(
      aborted
        ? 'Screen share was dismissed before a source was picked.'
        : `Could not start system audio capture: ${(err as Error).message}`,
      'system',
      true,
    )
  }

  const audio = display.getAudioTracks()
  if (audio.length === 0) {
    // Overwhelmingly the "forgot to tick Share audio" case.
    for (const track of display.getTracks()) track.stop()
    throw new AudioSourceError(
      'That capture had no audio. Re-share and enable "Share tab audio" / "Share system audio".',
      'system',
      true,
    )
  }

  for (const track of display.getVideoTracks()) {
    display.removeTrack(track)
    track.stop()
  }

  return new MediaStream(audio)
}

/** Microphone capture — room sound, no picker dialog. */
export async function openMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
  } catch (err) {
    const denied = err instanceof DOMException && err.name === 'NotAllowedError'
    throw new AudioSourceError(
      denied
        ? 'Microphone permission denied. Allow it in the address bar and retry.'
        : `Could not open the microphone: ${(err as Error).message}`,
      'mic',
      true,
    )
  }
}

export function openSource(kind: AudioSourceKind): Promise<MediaStream> {
  return kind === 'system' ? openSystemAudio() : openMic()
}
