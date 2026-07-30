import type { SceneRegistration } from '@/core/types'
import { CapyBlobDisco } from './capyBlobDisco'
import { HotSpringSoak } from './hotSpringSoak'
import { PixelCapyParade } from './pixelCapyParade'

/**
 * Every scene in the show. Adding one means adding a single entry here —
 * the director, settings panel and keyboard shortcuts all read from this list,
 * so nothing else needs touching.
 */
export const SCENE_REGISTRY: readonly SceneRegistration[] = [
  {
    id: 'capyBlobDisco',
    name: 'Capy Blob Disco',
    tags: ['2d', 'procedural', 'cartoon'],
    create: () => new CapyBlobDisco(),
  },
  {
    id: 'pixelCapyParade',
    name: 'Pixel Capy Parade',
    tags: ['pixel', 'procedural', '2d'],
    create: () => new PixelCapyParade(),
  },
  {
    id: 'hotSpringSoak',
    name: 'Hot Spring Soak',
    tags: ['3d', 'procedural'],
    create: () => new HotSpringSoak(),
  },
]
