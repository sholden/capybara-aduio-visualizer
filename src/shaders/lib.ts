/**
 * Shared GLSL chunks. Imported as strings and concatenated into scene shaders,
 * so the capybara silhouette itself is defined exactly once and every
 * procedural scene draws the same animal.
 */

export const SDF = /* glsl */ `
  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  float sdCircle(vec2 p, float r) {
    return length(p) - r;
  }

  // Polynomial smooth minimum — the blobby union that gives the capybara its
  // continuous, loaf-like outline instead of visible seams between parts.
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }
`

/**
 * A capybara in side profile, centred near the origin and roughly 1.6 units
 * long. `squash` is the audio-reactive dial: 1.0 is neutral, above 1 flattens
 * and widens the body the way a real one settles when it flops down.
 */
export const CAPYBARA_SDF = /* glsl */ `
  float sdCapybara(vec2 p, float squash) {
    p.y /= squash;
    p.x *= mix(1.0, squash, 0.65);

    float body  = sdRoundBox(p - vec2(0.00,  0.00), vec2(0.42, 0.24), 0.18);
    float head  = sdRoundBox(p - vec2(0.46,  0.16), vec2(0.16, 0.15), 0.09);
    float snout = sdRoundBox(p - vec2(0.66,  0.10), vec2(0.08, 0.09), 0.06);

    float d = smin(body, head, 0.10);
    d = smin(d, snout, 0.06);

    // Ears: small and set well back, which is most of what reads as "capybara".
    d = smin(d, sdCircle(p - vec2(0.38, 0.34), 0.055), 0.03);
    d = smin(d, sdCircle(p - vec2(0.52, 0.33), 0.050), 0.03);

    // Stubby legs.
    d = smin(d, sdRoundBox(p - vec2( 0.28, -0.30), vec2(0.06, 0.10), 0.05), 0.05);
    d = smin(d, sdRoundBox(p - vec2(-0.20, -0.30), vec2(0.07, 0.10), 0.05), 0.05);

    return d;
  }

  // Eye and nostril, returned separately so scenes can tint them independently.
  float sdCapybaraFace(vec2 p, float squash) {
    p.y /= squash;
    p.x *= mix(1.0, squash, 0.65);
    float eye = sdCircle(p - vec2(0.52, 0.20), 0.030);
    float nostril = sdCircle(p - vec2(0.71, 0.13), 0.016);
    return min(eye, nostril);
  }
`

export const PALETTE = /* glsl */ `
  // Warm capybara-and-hot-spring ramp: deep plum -> fur brown -> sunset gold.
  vec3 capyPalette(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 deep   = vec3(0.09, 0.06, 0.10);
    vec3 fur    = vec3(0.55, 0.38, 0.22);
    vec3 light  = vec3(0.78, 0.62, 0.42);
    vec3 sunset = vec3(0.88, 0.54, 0.30);
    vec3 c = mix(deep, fur, smoothstep(0.0, 0.45, t));
    c = mix(c, light, smoothstep(0.40, 0.75, t));
    c = mix(c, sunset, smoothstep(0.70, 1.0, t));
    return c;
  }

  vec3 capyWater(float t) {
    return mix(vec3(0.05, 0.16, 0.17), vec3(0.24, 0.60, 0.56), clamp(t, 0.0, 1.0));
  }
`

export const NOISE = /* glsl */ `
  float hash11(float n) { return fract(sin(n) * 43758.5453123); }

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += valueNoise(p) * amp;
      p *= 2.02;
      amp *= 0.5;
    }
    return sum;
  }
`

/** Vertex shader for a fullscreen quad; shared by every 2D scene. */
export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
