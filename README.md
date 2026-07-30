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

Psychedelic Capy Face exercises the texture path. The GLTF path is written and
typechecked but still unexercised — no scene loads a model yet.

## Scenes

| Scene | Style | Notes |
| --- | --- | --- |
| Capy Blob Disco | Cartoon 2D | SDF capybaras half-submerged at sunset. Squash on beat, bass-driven bobbing. |
| Pixel Capy Parade | Pixel art | Rendered at 320×180 with nearest-neighbour upscaling and quantised to a 9-colour palette with Bayer dithering. Two-frame waddle steps on the beat. |
| Hot Spring Soak | 3D | Lit geometry, custom water shader with beat ripple rings, steam particles. |
| Psychedelic Capy Face | 3D + photo | A photographed capybara face on a displaced surface over a raymarched Mandelbox. Each eye, ear, nostril, the nose and the mouth swell and pop independently, each driven by a different frequency band. |

### Psychedelic Capy Face

The eight facial anchors live in `src/scenes/psychedelicCapyFace/features.ts`,
measured off `capy-face.jpg` with v counted from the **top** of the image. That
table is the only image-specific thing in the scene — swapping in a different
capybara photo means re-measuring those eight points and the `FACE_CORE`
ellipse, and nothing else.

Two details worth knowing before editing it:

- The photo is shot on black, so the background keys out on luminance. The eyes,
  nostrils and mouth are near-black too, so `FACE_CORE` is an ellipse that
  forces them opaque. **If you enlarge it past the fur it becomes a black halo
  around the head**, which is exactly what it looks like when it's wrong.
- The Mandelbox is **repeated on a lattice** (`CELL` in `mandelbox.glsl.ts`).
  A single copy is a finite object, so however the camera is aimed the frame
  eventually runs out of fractal and goes black; tiling it guarantees geometry
  in every direction. The flight wraps into one cell with `mod`, which is exact
  because the scene is periodic, and stops the coordinate growing without bound
  over a multi-hour run.
- Camera sway must stay **bounded**. An earlier version yawed by a term linear
  in time, rotating a little further every second until the fractal had drifted
  off frame — the original symptom that motivated the lattice.
- Surfaces are shaded from a real normal (central differences on the distance
  estimator). Without it the fractal goes flat wherever the camera passes close
  to a copy, since orbit-trap and depth alone carry no form.
- Feature drives are **underdamped springs**, not smoothing. Exponential
  smoothing can only ease toward a target; the overshoot and wobble past it is
  what makes the bulges read as cartoon rubber. Both shader stages clamp the
  resulting drive — past a swell of 1.0 the UV scale factor passes through zero
  and the feature turns inside out.

The source image is 474×632, which is soft when the head is large on a 4K
display. Dropping in a higher-resolution capybara portrait is the single biggest
available quality win for this scene.

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
