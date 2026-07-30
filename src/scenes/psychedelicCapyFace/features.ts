/**
 * Facial feature anchors for `capy-face.jpg`, measured off the image itself.
 *
 * Coordinates are normalized to the image with **v measured from the top**,
 * matching how you'd read pixel positions in an image editor. The scene flips
 * v once when it uploads these as uniforms, since GL texture space has v=0 at
 * the bottom.
 *
 * Radii are in units of image *width*, so they stay circular once the shader
 * applies the aspect correction below.
 *
 * Everything here is image-specific: swapping in a different capybara photo
 * means re-measuring this table and nothing else.
 */

export const IMAGE_WIDTH = 474
export const IMAGE_HEIGHT = 632

/** Multiply v-deltas by this to measure distance in width-relative units. */
export const ASPECT_CORRECT = IMAGE_HEIGHT / IMAGE_WIDTH

/** Which analysed band drives a feature. Keeps each one moving independently. */
export type FeatureDriver = 'bass' | 'lowMid' | 'mid' | 'high' | 'presence' | 'punch'

export interface Feature {
  name: string
  /** Centre, normalized, v from the top of the image. */
  u: number
  v: number
  /** Influence radius, in units of image width. */
  radius: number
  driver: FeatureDriver
  /** How much this feature magnifies in UV space at full drive. */
  swell: number
  /** How far it pushes toward the camera at full drive, in world units. */
  pop: number
}

export const FEATURES: readonly Feature[] = [
  // Ears sit high and wide; the beat makes them flap out.
  { name: 'earL', u: 0.247, v: 0.222, radius: 0.090, driver: 'punch', swell: 0.72, pop: 0.58 },
  { name: 'earR', u: 0.753, v: 0.222, radius: 0.090, driver: 'punch', swell: 0.72, pop: 0.58 },

  // Eyes on the top end so hats and cymbals make them bug out.
  { name: 'eyeL', u: 0.316, v: 0.282, radius: 0.060, driver: 'high', swell: 0.95, pop: 0.66 },
  { name: 'eyeR', u: 0.690, v: 0.282, radius: 0.060, driver: 'high', swell: 0.95, pop: 0.66 },

  // The whole snout swells on the low end — the biggest, slowest motion.
  { name: 'nose', u: 0.485, v: 0.396, radius: 0.110, driver: 'bass', swell: 0.58, pop: 0.78 },

  { name: 'nostrilL', u: 0.418, v: 0.396, radius: 0.044, driver: 'lowMid', swell: 0.95, pop: 0.44 },
  { name: 'nostrilR', u: 0.553, v: 0.399, radius: 0.044, driver: 'lowMid', swell: 0.95, pop: 0.44 },

  { name: 'mouth', u: 0.481, v: 0.590, radius: 0.065, driver: 'mid', swell: 0.90, pop: 0.52 },
]

/**
 * Spring constants for the feature drives.
 *
 * Underdamped on purpose: critical damping for this stiffness would be
 * 2·sqrt(STIFFNESS) ≈ 26, and sitting well below it makes each feature
 * overshoot its target and wobble back. That overshoot is the whole difference
 * between "the eye gets bigger" and "the eye boings out" — plain exponential
 * smoothing can only ever ease toward a target and never past it.
 */
export const SPRING_STIFFNESS = 170
export const SPRING_DAMPING = 11
/** Integration is unstable at large steps; substep anything longer than this. */
export const SPRING_MAX_STEP = 1 / 120

/**
 * Region kept fully opaque regardless of brightness.
 *
 * The photo is shot on black, so the background keys out on luminance alone —
 * but the eyes, nostrils and mouth are nearly black too and would punch holes
 * straight through the face. This ellipse covers the facial features so they
 * stay solid while the surrounding black still drops out.
 */
export const FACE_CORE = {
  u: 0.5,
  // Centred between the eyes (v 0.282) and the mouth (v 0.590), sized to just
  // enclose both. Any larger and the ellipse reaches past the fur into the
  // black background, which then renders as an opaque halo around the head.
  v: 0.436,
  radiusU: 0.28,
  radiusV: 0.23,
}
