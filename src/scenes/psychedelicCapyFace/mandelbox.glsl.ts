/**
 * Raymarched Mandelbox.
 *
 * Rendered into a half-resolution target and upscaled — the distance estimator
 * runs a folding loop per march step, so it is by far the most expensive thing
 * in the app and full-res 4K is not worth the frame budget. At half res the
 * softness is invisible against a fractal this busy.
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

  const int   FOLD_ITERATIONS = 9;
  const int   MARCH_STEPS     = 78;
  const float MIN_DIST        = 0.0006;
  const float MAX_DIST        = 34.0;

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

    // Audio drives the fold parameters. Ranges kept inside the region where
    // the Mandelbox stays a recognisable solid rather than dissolving to dust.
    float scale = -2.05 + uBass * 0.26 + sin(uTime * 0.09) * 0.08;
    float minRadius2 = 0.25 + uMid * 0.12;

    // Orbit at a distance rather than flying in. An earlier version started at
    // z=3.6 and advanced 0.16/s, which put the camera inside the structure
    // within seconds — every ray hit immediately and the whole frame smeared
    // into one flat surface instead of resolving detail.
    float orbit = uTime * 0.05;
    vec3 ro = vec3(
      sin(orbit) * 1.1,
      cos(uTime * 0.04) * 0.7,
      4.7 + cos(orbit) * 0.8
    );
    vec3 rd = normalize(vec3(uv, -1.7));
    // Aim back at the origin so the structure stays framed while we orbit.
    float yaw = -orbit * 0.55;
    float cy = cos(yaw), sy = sin(yaw);
    rd.xz = mat2(cy, -sy, sy, cy) * rd.xz;

    // Roll the camera gently; the beat nudges it.
    float roll = uTime * 0.06 + uPunch * 0.10;
    float cs = cos(roll), sn = sin(roll);
    rd.xy = mat2(cs, -sn, sn, cs) * rd.xy;

    float travelled = 0.0;
    float glow = 0.0;
    float trap = 1e9;
    bool hit = false;

    for (int i = 0; i < MARCH_STEPS; i++) {
      vec3 p = ro + rd * travelled;
      float d = mandelbox(p, scale, minRadius2);
      trap = min(trap, length(p));

      // Accumulated proximity gives the volumetric haze between surfaces,
      // which is most of the psychedelic look. Kept tight — a broader falloff
      // saturated over 78 steps and washed the whole frame to flat gold.
      glow += exp(-d * 42.0) * 0.030;

      if (d < MIN_DIST) { hit = true; break; }
      travelled += d * 0.82;
      if (travelled > MAX_DIST) break;
    }

    float depth = travelled / MAX_DIST;
    vec3 col = palette(trap * 0.32 + uTime * 0.03 + depth * 0.55, uHue);

    if (hit) {
      // Cheap ambient occlusion from how far the ray got before hitting.
      col *= 0.30 + 0.70 * (1.0 - depth);
    } else {
      // The Mandelbox is a finite object, so rays past its silhouette used to
      // leave the frame corners dead black. Give misses a slow nebula keyed to
      // ray direction so the background stays alive edge to edge.
      float band = dot(rd, vec3(0.35, 0.55, 0.25)) * 0.5 + length(uv) * 0.22;
      vec3 nebula = palette(band + uTime * 0.02, uHue + 0.35);
      col = nebula * (0.16 + uLevel * 0.22);
    }

    col += palette(glow * 0.65 + uTime * 0.05, uHue) * glow * (0.55 + uLevel * 0.85);
    col += vec3(0.9, 0.5, 1.0) * uPunch * glow * 0.35;

    // Fade the far field so the head always has something dark to sit against.
    col *= mix(1.0, 0.28, smoothstep(0.50, 1.0, depth));
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
