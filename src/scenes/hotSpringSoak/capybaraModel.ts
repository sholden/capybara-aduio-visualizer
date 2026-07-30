import * as THREE from 'three'

/**
 * A capybara assembled from primitives.
 *
 * Deliberately built in code rather than loaded: it needs no asset pipeline,
 * scales to any count for free, and the blocky-loaf proportions that read as
 * "capybara" are easier to dial in numerically than to model. To swap in a real
 * GLTF later, declare it in the scene's `assets` manifest and replace the call
 * to this builder — nothing else changes.
 *
 * Only the upper body is built. Every capybara sits half-submerged, so legs and
 * belly are never visible and would be wasted geometry.
 */

export interface CapybaraParts {
  group: THREE.Group
  /** Rotates on the beat for a small head-bob. */
  head: THREE.Group
  dispose: () => void
}

const FUR_TINTS = [0x8c6239, 0x7a5330, 0x9c714a, 0x6f4a2c]

export function createCapybara(seed: number): CapybaraParts {
  const group = new THREE.Group()
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  const tint = FUR_TINTS[Math.floor(seed * FUR_TINTS.length) % FUR_TINTS.length]!
  const fur = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.92,
    metalness: 0,
  })
  const dark = new THREE.MeshStandardMaterial({
    color: 0x120c08,
    roughness: 0.5,
    metalness: 0,
  })
  disposables.push(fur, dark)

  const sphere = new THREE.SphereGeometry(1, 24, 18)
  disposables.push(sphere)

  const add = (
    parent: THREE.Object3D,
    material: THREE.Material,
    position: [number, number, number],
    scale: [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(sphere, material)
    mesh.position.set(...position)
    mesh.scale.set(...scale)
    parent.add(mesh)
    return mesh
  }

  // Body: a long low loaf.
  add(group, fur, [0, 0, 0], [1.0, 0.62, 0.72])

  // Head rides in its own group so it can nod independently.
  const head = new THREE.Group()
  head.position.set(0.92, 0.22, 0)
  group.add(head)

  add(head, fur, [0, 0, 0], [0.42, 0.40, 0.40])
  // Blunt squared-off snout — the giveaway feature.
  add(head, fur, [0.34, -0.10, 0], [0.24, 0.20, 0.22])
  // Ears: small, round, set well back.
  add(head, fur, [-0.18, 0.34, 0.22], [0.12, 0.12, 0.09])
  add(head, fur, [-0.18, 0.34, -0.22], [0.12, 0.12, 0.09])
  // Eyes and nose.
  add(head, dark, [0.16, 0.14, 0.28], [0.07, 0.07, 0.05])
  add(head, dark, [0.16, 0.14, -0.28], [0.07, 0.07, 0.05])
  add(head, dark, [0.54, -0.10, 0.07], [0.04, 0.035, 0.035])
  add(head, dark, [0.54, -0.10, -0.07], [0.04, 0.035, 0.035])

  return {
    group,
    head,
    dispose: () => {
      for (const item of disposables) item.dispose()
    },
  }
}
