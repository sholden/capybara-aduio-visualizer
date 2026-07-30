import { CELL } from './flightPath'

/**
 * Raymarched Mandelbox.
 *
 * Rendered into a half-resolution target and upscaled — the distance estimator
 * runs a folding loop per march step, so it is by far the most expensive thing
 * in the app and full-res 4K is not worth the frame budget. At half res the
 * softness is invisible against a fractal this busy.
 *
 * CELL is interpolated from flightPath.ts rather than duplicated: the camera
 * steering evaluates this same field on the CPU, and if the two ever disagreed
 * the steering would be dodging obstacles that aren't where they're drawn.
 */
export const MANDELBOX_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uLevel;
  uniform float uPunch;
  uniform float uHue;
  uniform float uComplexity;
  uniform vec3  uCameraPos;
  uniform float uScale;
  uniform float uMinRadius2;

  const int   FOLD_ITERATIONS = 9;
  const int   MARCH_STEPS     = 78;
  const float MIN_DIST        = 0.0006;
  const float MAX_DIST        = 30.0;

  /**
   * Edge length of the repeating cell — see flightPath.ts, which owns this
   * value. A single Mandelbox is finite, so however the camera is aimed the
   * frame eventually runs out of fractal and goes black; tiling it guarantees
   * geometry in every direction.
   */
  const float CELL = ${CELL.toFixed(4)};

  // --- Mandelbox distance estimator ---------------------------------------
  // Box fold, then sphere fold, then scale — repeated. The scale factor is the
  // shape's personality, so driving it with the bass makes the whole structure
  // inflate and collapse with the track.
  float mandelbox(vec3 pos, float scale, float minRadius2) {
    const float FIXED_RADIUS2 = 1.0;
    vec3 p = pos;
    float dr = 1.0;

    for (int i = 0; i < FOLD_ITERATIONS; i++) {
      p = clamp(p, -1.0, 1.0) * 2.0 - p;

      float r2 = dot(p, p);
      if (r2 < minRadius2) {
        float t = FIXED_RADIUS2 / minRadius2;
        p *= t;
        dr *= t;
      } else if (r2 < FIXED_RADIUS2) {
        float t = FIXED_RADIUS2 / r2;
        p *= t;
        dr *= t;
      }

      p = scale * p + pos;
      dr = dr * abs(scale) + 1.0;
    }

    return length(p) / abs(dr);
  }

  /** Index of the repeating cell a point falls in. Used to vary colour per copy. */
  vec3 cellId(vec3 p) {
    // floor(x + 0.5) rather than round(): this compiles as GLSL ES 1.00, where
    // round() does not exist.
    return floor(p / CELL + 0.5);
  }

  /** Mandelbox repeated infinitely on a lattice. */
  float scene(vec3 p, float scale, float minRadius2) {
    vec3 q = p - CELL * cellId(p);
    return mandelbox(q, scale, minRadius2);
  }

  /**
   * Surface normal by central differences.
   *
   * Without this the shading was orbit-trap and depth only, which looks fine at
   * a distance but goes completely flat up close — as the flight passes through
   * a lattice copy, every near surface rendered as one solid colour blob. Six
   * extra distance evaluations buys actual form at any range.
   */
  vec3 surfaceNormal(vec3 p, float scale, float minRadius2) {
    vec2 e = vec2(0.0018, 0.0);
    return normalize(vec3(
      scene(p + e.xyy, scale, minRadius2) - scene(p - e.xyy, scale, minRadius2),
      scene(p + e.yxy, scale, minRadius2) - scene(p - e.yxy, scale, minRadius2),
      scene(p + e.yyx, scale, minRadius2) - scene(p - e.yyx, scale, minRadius2)
    ));
  }

  // Cosine palette — cheap, and shifting the phase cycles the whole colour
  // scheme on a beat without touching the geometry.
  vec3 palette(float t, float hue) {
    vec3 a = vec3(0.55, 0.45, 0.50);
    vec3 b = vec3(0.45, 0.42, 0.48);
    vec3 c = vec3(1.00, 1.00, 1.00);
    vec3 d = vec3(0.00, 0.28, 0.55) + hue;
    return a + b * cos(6.28318 * (c * t + d));
  }

  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uResolution.x / uResolution.y;

    // Fold parameters and camera position both come from the CPU. The steering
    // in flightPath.ts has to evaluate this exact distance field to keep the
    // camera clear of surfaces, so deriving either independently here would let
    // the two describe slightly different shapes.
    float scale = uScale;
    float minRadius2 = uMinRadius2;

    // Endless flight through the lattice, already steered around anything it
    // would otherwise fly into. Repetition means we never run out of structure,
    // and the standoff distance means we never end up inside it.
    vec3 ro = uCameraPos;
    vec3 rd = normalize(vec3(uv, -1.7));

    // Sway must be bounded. An earlier version yawed by a term linear in time,
    // which rotated the view a little further every second until the fractal
    // had drifted off frame entirely and the background went black.
    float yaw = sin(uTime * 0.05) * 0.22 + uPunch * 0.03;
    float pitch = sin(uTime * 0.037) * 0.13;
    float cy = cos(yaw), sy = sin(yaw);
    rd.xz = mat2(cy, -sy, sy, cy) * rd.xz;
    float cp = cos(pitch), sp = sin(pitch);
    rd.yz = mat2(cp, -sp, sp, cp) * rd.yz;

    // Roll the camera gently; the beat nudges it.
    float roll = uTime * 0.06 + uPunch * 0.10;
    float cs = cos(roll), sn = sin(roll);
    rd.xy = mat2(cs, -sn, sn, cs) * rd.xy;

    float travelled = 0.0;
    float glow = 0.0;
    float trap = 1e9;
    float cellHash = 0.0;
    vec3  hitPos = vec3(0.0);
    bool hit = false;

    for (int i = 0; i < MARCH_STEPS; i++) {
      vec3 p = ro + rd * travelled;
      float d = scene(p, scale, minRadius2);

      // Trap on the folded position so colour is stable per copy rather than
      // sliding with world position as we fly.
      vec3 folded = p - CELL * cellId(p);
      trap = min(trap, length(folded));

      // Accumulated proximity gives the volumetric haze between surfaces,
      // which is most of the psychedelic look. Kept tight — a broader falloff
      // saturated over 78 steps and washed the whole frame to flat gold.
      glow += exp(-d * 42.0) * 0.038;

      if (d < MIN_DIST) {
        hit = true;
        hitPos = p;
        vec3 id = cellId(p);
        cellHash = fract(sin(dot(id, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        break;
      }
      // Shorter steps than a single Mandelbox needs: the repeated distance
      // estimate is only valid within a cell, so a full step can tunnel
      // through a neighbouring copy's surface.
      travelled += d * 0.72;
      if (travelled > MAX_DIST) break;
    }

    float depth = travelled / MAX_DIST;
    // Each lattice copy gets its own colour offset, so flying through reads as
    // travelling somewhere rather than staring at one repeating texture.
    vec3 col = palette(trap * 0.32 + uTime * 0.03 + depth * 0.55 + cellHash * 0.30, uHue);

    if (hit) {
      vec3 n = surfaceNormal(hitPos, scale, minRadius2);

      // Two lights from opposite sides, so folds read as folds no matter which
      // way a surface faces.
      vec3 key = normalize(vec3(0.55, 0.70, 0.45));
      vec3 rimDir = normalize(vec3(-0.60, -0.25, 0.70));
      float diffuse = max(dot(n, key), 0.0);
      float back = max(dot(n, rimDir), 0.0);
      float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

      // Generous ambient floor. Wider cells mean more surfaces face away from
      // both lights, and at 0.22 those went almost black — reintroducing the
      // dead regions the lattice was meant to eliminate.
      col *= 0.40 + 0.62 * diffuse + 0.32 * back;
      col += palette(trap * 0.5 + uTime * 0.04, uHue + 0.5) * fresnel * (0.35 + uHigh * 0.4);

      // Cheap ambient occlusion from how far the ray got before hitting.
      col *= 0.30 + 0.70 * (1.0 - depth);
    } else {
      // With repetition a miss is now rare — it only happens down the narrow
      // corridors between copies. Fill it with a nebula so those gaps read as
      // depth rather than as holes.
      float band = dot(rd, vec3(0.35, 0.55, 0.25)) * 0.5 + length(uv) * 0.22;
      vec3 nebula = palette(band + uTime * 0.02, uHue + 0.35);
      col = nebula * (0.38 + uLevel * 0.30);
    }

    col += palette(glow * 0.65 + uTime * 0.05, uHue) * glow * (0.55 + uLevel * 0.85);
    col += vec3(0.9, 0.5, 1.0) * uPunch * glow * 0.35;

    // Fade the far field so the head always has something dark to sit against.
    col *= mix(1.0, 0.55, smoothstep(0.60, 1.0, depth));
    col *= 0.55 + uComplexity * 0.45;

    // Push saturation and contrast — the raw march reads washed out, and this
    // scene wants to look like a poster, not a render.
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, 1.45);
    col = pow(max(col, 0.0), vec3(1.18));

    col = col / (1.0 + col * 0.42);
    gl_FragColor = vec4(col, 1.0);
  }
`
