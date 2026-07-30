import GUI from 'lil-gui'
import type { Stage } from '@/core/Stage'
import type { Store } from '@/core/Store'
import type { ActionDispatcher } from '@/input/dispatcher'
import type { RotationMode, SceneRegistration } from '@/core/types'

/**
 * lil-gui panel over the Store.
 *
 * Deliberately a *view*: every control emits an Action or writes to the Store,
 * never to the director or a scene directly. That keeps this interchangeable
 * with a phone remote driving the same state.
 */
export class SettingsPanel {
  private gui: GUI
  private visible = false

  constructor(
    store: Store,
    stage: Stage,
    dispatcher: ActionDispatcher,
    registry: readonly SceneRegistration[],
  ) {
    this.gui = new GUI({ title: 'Capybara Visualizer', width: 300 })
    this.gui.domElement.classList.add('capy-settings')

    const settings = store.settings

    // --- playback ---------------------------------------------------------
    const playback = this.gui.addFolder('Playback')
    const playbackState = {
      mode: settings.rotationMode,
      interval: settings.rotationIntervalSec,
      next: () => dispatcher.emit({ type: 'nextScene' }),
      prev: () => dispatcher.emit({ type: 'prevScene' }),
    }
    playback
      .add(playbackState, 'mode', ['manual', 'sequential', 'random'])
      .name('Rotation')
      .onChange((mode: RotationMode) => dispatcher.emit({ type: 'setRotationMode', mode }))
    playback
      .add(playbackState, 'interval', 5, 300, 5)
      .name('Hold (s)')
      .onChange((rotationIntervalSec: number) => store.update({ rotationIntervalSec }))
    playback.add(playbackState, 'prev').name('◀ Previous')
    playback.add(playbackState, 'next').name('Next ▶')

    // --- scenes -----------------------------------------------------------
    const scenes = this.gui.addFolder('Scenes in rotation')
    for (const registration of registry) {
      const row = { enabled: store.isSceneEnabled(registration.id) }
      scenes
        .add(row, 'enabled')
        .name(registration.name)
        .onChange((enabled: boolean) =>
          dispatcher.emit({ type: 'setSceneEnabled', id: registration.id, enabled }),
        )
    }
    const jump: Record<string, () => void> = {}
    for (const registration of registry) {
      jump[registration.name] = () =>
        dispatcher.emit({ type: 'gotoScene', id: registration.id })
    }
    const jumpFolder = this.gui.addFolder('Jump to scene')
    for (const [name, fn] of Object.entries(jump)) {
      jumpFolder.add({ [name]: fn }, name).name(name)
    }
    jumpFolder.close()

    // --- per-scene parameters --------------------------------------------
    const paramsFolder = this.gui.addFolder('Scene settings')
    for (const registration of registry) {
      // Instantiated once purely to read its declared params; disposed at once.
      const probe = registration.create()
      if (!probe.params || probe.params.length === 0) {
        probe.dispose?.()
        continue
      }
      const folder = paramsFolder.addFolder(registration.name)
      const stored = store.getSceneParams(registration.id)
      for (const spec of probe.params) {
        const row = { [spec.key]: stored[spec.key] ?? spec.default }
        folder
          .add(row, spec.key, spec.min, spec.max, spec.step)
          .name(spec.label)
          .onChange((value: number) =>
            dispatcher.emit({
              type: 'setParam',
              scene: registration.id,
              key: spec.key,
              value,
            }),
          )
      }
      folder.close()
    }
    paramsFolder.close()

    // --- output -----------------------------------------------------------
    const output = this.gui.addFolder('Output')
    const outputState = {
      resolution: settings.resolutionScale,
      hud: settings.showHud,
      source: settings.audioSource,
      fullscreen: () => dispatcher.emit({ type: 'toggleFullscreen' }),
    }
    output
      .add(outputState, 'resolution', 0.25, 1, 0.05)
      .name('Resolution')
      .onChange((resolutionScale: number) => {
        stage.setResolutionScale(resolutionScale)
        store.update({ resolutionScale })
      })
    output
      .add(outputState, 'source', ['system', 'mic'])
      .name('Audio input')
      .onChange((source: 'system' | 'mic') =>
        dispatcher.emit({ type: 'setAudioSource', source }),
      )
    output
      .add(outputState, 'hud')
      .name('Show HUD')
      .onChange(() => dispatcher.emit({ type: 'toggleHud' }))
    output.add(outputState, 'fullscreen').name('Fullscreen')

    this.setVisible(false)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.gui.domElement.style.display = visible ? '' : 'none'
  }

  toggle(): void {
    this.setVisible(!this.visible)
  }

  get isVisible(): boolean {
    return this.visible
  }
}
