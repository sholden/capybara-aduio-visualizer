import type { Action, ActionHandler, InputSource } from '@/core/types'

/**
 * Single funnel for every control surface.
 *
 * Keyboard today; a phone web remote or WebMIDI box later registers here and
 * emits the same Action union. Nothing downstream of the dispatcher knows or
 * cares where an action came from.
 */
export class ActionDispatcher {
  private sources: InputSource[] = []
  private handlers = new Set<ActionHandler>()

  register(source: InputSource): void {
    source.attach((action) => this.emit(action))
    this.sources.push(source)
  }

  onAction(handler: ActionHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(action: Action): void {
    for (const handler of this.handlers) handler(action)
  }

  dispose(): void {
    for (const source of this.sources) source.detach()
    this.sources = []
    this.handlers.clear()
  }
}
