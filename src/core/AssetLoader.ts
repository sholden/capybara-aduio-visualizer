import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { AssetManifest, LoadedAssets, TextureSpec } from './types'

/**
 * Loads and caches scene assets.
 *
 * Caching is by URL and shared across scenes, so rotating back to a scene is
 * instant and two scenes sharing a capybara model only pay for it once. The
 * cache is intentionally never evicted — the asset set for an installation is
 * small and bounded, and re-fetching mid-show would cause visible hitches.
 */
export class AssetLoader {
  private textureLoader = new THREE.TextureLoader()
  private gltfLoader = new GLTFLoader()
  private textures = new Map<string, Promise<THREE.Texture>>()
  private models = new Map<string, Promise<THREE.Object3D>>()

  async load(manifest: AssetManifest | undefined): Promise<LoadedAssets> {
    const result: LoadedAssets = { textures: {}, models: {} }
    if (!manifest) return result

    const jobs: Promise<void>[] = []

    for (const [key, spec] of Object.entries(manifest.textures ?? {})) {
      jobs.push(
        this.loadTexture(spec).then((texture) => {
          result.textures[key] = texture
        }),
      )
    }

    for (const [key, url] of Object.entries(manifest.models ?? {})) {
      jobs.push(
        this.loadModel(url).then((model) => {
          // Each scene gets its own clone; the cached original stays pristine.
          result.models[key] = model.clone(true)
        }),
      )
    }

    await Promise.all(jobs)
    return result
  }

  private loadTexture(spec: TextureSpec): Promise<THREE.Texture> {
    const url = typeof spec === 'string' ? spec : spec.url
    const pixelated = typeof spec === 'string' ? false : Boolean(spec.pixelated)
    const cacheKey = `${url}|${pixelated}`

    let pending = this.textures.get(cacheKey)
    if (!pending) {
      pending = this.textureLoader.loadAsync(url).then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        if (pixelated) {
          texture.magFilter = THREE.NearestFilter
          texture.minFilter = THREE.NearestFilter
          texture.generateMipmaps = false
        }
        return texture
      })
      this.textures.set(cacheKey, pending)
    }
    return pending
  }

  private loadModel(url: string): Promise<THREE.Object3D> {
    let pending = this.models.get(url)
    if (!pending) {
      pending = this.gltfLoader.loadAsync(url).then((gltf) => gltf.scene)
      this.models.set(url, pending)
    }
    return pending
  }
}
