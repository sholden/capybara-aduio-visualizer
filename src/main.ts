import './style.css'
import { Stage } from '@/core/Stage'
import { FrameClock } from '@/core/FrameClock'
import { Store } from '@/core/Store'
import { Compositor } from '@/core/Compositor'
import { AssetLoader } from '@/core/AssetLoader'
import { SceneDirector } from '@/core/SceneDirector'
import { AudioEngine } from '@/audio/AudioEngine'
import { ActionDispatcher } from '@/input/dispatcher'
import { KeyboardInput } from '@/input/KeyboardInput'
import { StartOverlay } from '@/ui/StartOverlay'
import { AudioDebugView } from '@/ui/AudioDebugView'
import { Hud } from '@/ui/Hud'
import { SettingsPanel } from '@/ui/SettingsPanel'
import { SCENE_REGISTRY } from '@/scenes/registry'
import type { AudioSourceKind } from '@/core/types'

const canvas = document.querySelector<HTMLCanvasElement>('#stage')
const overlayRoot = document.querySelector<HTMLElement>('#overlay')
if (!canvas || !overlayRoot) throw new Error('index.html is missing #stage or #overlay')

const store = new Store()
const stage = new Stage(canvas)
stage.setResolutionScale(store.settings.resolutionScale)

const clock = new FrameClock()
const audio = new AudioEngine()
const compositor = new Compositor(stage.width, stage.height)
const assets = new AssetLoader()
const director = new SceneDirector(stage, store, compositor, assets, SCENE_REGISTRY)

const hud = new Hud(overlayRoot)
const debugView = new AudioDebugView(overlayRoot)
debugView.setVisible(false)
hud.setVisible(store.settings.showHud)

const dispatcher = new ActionDispatcher()
dispatcher.register(new KeyboardInput())

const settings = new SettingsPanel(store, stage, dispatcher, SCENE_REGISTRY)

const start = new StartOverlay(overlayRoot, (kind) => void begin(kind))

async function begin(kind: AudioSourceKind): Promise<void> {
  try {
    await audio.setSource(kind)
    store.update({ audioSource: kind })
    start.hide()
    await director.start()
    void requestWakeLock()
  } catch {
    // The engine emits a described error; the overlay stays up to retry.
  }
}

audio.on((event) => {
  if (event.type === 'error') start.show(event.error.message)
  else if (event.type === 'sourceEnded') start.show('Audio stopped. Pick a source to resume.')
})

dispatcher.onAction((action) => {
  switch (action.type) {
    case 'nextScene':
      director.next()
      break
    case 'prevScene':
      director.prev()
      break
    case 'gotoScene':
      director.goto(action.id)
      break
    case 'setRotationMode':
      store.update({ rotationMode: action.mode })
      break
    case 'setSceneEnabled':
      store.setSceneEnabled(action.id, action.enabled)
      break
    case 'setAudioSource':
      void audio.setSource(action.source)
      break
    case 'toggleAudioSource':
      void audio.toggleSource()
      break
    case 'setParam':
      store.setSceneParam(action.scene, action.key, action.value)
      break
    case 'toggleHud':
      store.update({ showHud: !store.settings.showHud })
      hud.setVisible(store.settings.showHud)
      break
    case 'toggleSettings':
      settings.toggle()
      break
    case 'toggleDebug':
      debugView.setVisible(!debugView.visible)
      break
    case 'toggleFullscreen':
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
      break
  }
})

/** Keeps the TV awake for the length of the show. */
async function requestWakeLock(): Promise<void> {
  try {
    await navigator.wakeLock?.request('screen')
  } catch {
    // Not fatal — the display may just sleep on its own.
  }
}
// The lock is dropped whenever the tab is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void requestWakeLock()
})

// Hide the cursor once it stops moving, so it never sits over the visuals.
let idleTimer: number | undefined
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000) as unknown as number
})

if (import.meta.env.DEV) {
  void import('@/dev/devHooks').then((m) =>
    m.install({ audio, stage, clock, director, store }),
  )
}

stage.renderer.setAnimationLoop(() => {
  clock.tick()
  const frame = audio.update(clock.dt)
  director.update(frame)
  director.render(stage.renderer)
  hud.update(frame, director.status, audio.source, store.settings.rotationMode, clock.fps)
  debugView.draw(frame, audio.source, clock.fps)
})
