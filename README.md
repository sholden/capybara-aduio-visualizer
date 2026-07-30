# Capybara Visualizer

An audio-reactive capybara art installation for a TV. Listens to system audio
(Spotify, browser, anything playing on the Mac) or the microphone, and cycles
through scenes spanning 3D, cartoon 2D and pixel art.

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:5173, then pick an audio source:

- **System audio** — Chrome shows a share picker. Pick a screen or window and
  **tick "Share system audio"**. Without that tick there is no audio track and
  the app will say so.
- **Microphone** — allow the permission prompt.

Requires macOS 14.2+ and Chrome 141+ for system audio capture. Both are well
clear on this machine (macOS 26.5, Chrome 151).

## Controls

| Key | Action |
| --- | --- |
| `←` `→` / `Space` | Previous / next scene |
| `S` | Switch between system audio and microphone |
| `M` / `Q` / `R` | Rotation mode: manual / sequential / random |
| `H` | Toggle the HUD |
| `D` | Toggle the audio analyser debug view |
| `Tab` | Toggle the settings panel |
| `F` | Fullscreen |

The settings panel is where scenes are enabled and disabled in the rotation, the
hold interval is set, and per-scene parameters live. Settings persist across
reloads via `localStorage`.

## Putting it on the TV

Connect over HDMI or AirPlay, drag the window to the TV, press `F`. The app takes
a Screen Wake Lock so the display won't sleep mid-show, and hides the cursor after
two seconds of no movement.

If frame rate suffers at 4K, drop **Resolution** in the settings panel — it scales
the render buffer independently of the window.

## Architecture

Four abstractions carry the whole app; everything else is scenes.

- **`src/audio/`** — `AudioEngine` owns the AudioContext and whichever capture is
  live. `SpectrumAnalyser` turns it into an `AudioFrame`: 32 log-spaced bands,
  coarse groups (bass/lowMid/mid/high/presence), a level envelope, onset flags,
  and a BPM estimate — all normalized to 0..1 by a global adaptive ceiling, so a
  quiet mic and a hot line signal drive the visuals identically. **Scenes never
  see raw FFT and never learn which source is live.**
- **`src/core/SceneDirector.ts`** — scene lifecycle and rotation. Loads the next
  scene while the current one is still playing (so rotation never hitches), and
  quarantines a scene that fails to load rather than taking the show down.
- **`src/input/`** — `InputSource` implementations emit semantic `Action`s, not
  key codes. `KeyboardInput` is the only one today; a phone remote or WebMIDI
  surface registers with the same dispatcher and needs no core changes.
- **`src/core/Store.ts`** — persisted settings. The settings panel is a *view*
  over this, never a source of truth, so a remote can drive the same state.

### Adding a scene

1. Implement `CapyScene` (see `src/core/types.ts`) in `src/scenes/<id>/`.
2. Add one entry to `src/scenes/registry.ts`.

That's all — the director, settings panel and rotation pick it up automatically.
Declare tunable knobs via `params` and they appear in the settings panel and are
reachable by any future remote.

Scenes must release every GPU resource in `dispose()`. Rotation runs for hours;
`renderer.info.memory` should stay flat across many cycles.

### Assets

`AssetLoader` handles textures (with a `pixelated` flag for nearest-neighbour
sprite work) and GLTF models, declared per-scene via an `assets` manifest and
preloaded by the director. Put files under `public/assets/<sceneId>/`.

All three current scenes are procedural and need no files, so **the asset loader
is written and typechecked but not yet exercised against real assets.** The first
scene that declares a manifest will be the real test.

## Scenes

| Scene | Style | Notes |
| --- | --- | --- |
| Capy Blob Disco | Cartoon 2D | SDF capybaras half-submerged at sunset. Squash on beat, bass-driven bobbing. |
| Pixel Capy Parade | Pixel art | Rendered at 320×180 with nearest-neighbour upscaling and quantised to a 9-colour palette with Bayer dithering. Two-frame waddle steps on the beat. |
| Hot Spring Soak | 3D | Lit geometry, custom water shader with beat ripple rings, steam particles. |

The capybara silhouette is defined once in `src/shaders/lib.ts` and shared by both
2D scenes; the 3D one is built from primitives in
`src/scenes/hotSpringSoak/capybaraModel.ts`.

## Dev hooks

In dev, `window.__capy` exposes the engine, director, store and stage, plus:

```js
const sig = await __capy.testSignal()  // synthetic audio, no capture dialogs
sig.setFreq(100)                       // tone at a known frequency
sig.startBeat(120)                     // noise bursts at a known tempo
__capy.snapshot()                      // current AudioFrame, JSON-safe
```

This is how the analyser was verified: a tone must light the matching bands, and
bursts at a known BPM must produce the matching onset count.
