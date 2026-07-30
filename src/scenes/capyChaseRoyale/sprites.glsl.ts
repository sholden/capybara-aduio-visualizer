import { SDF } from '@/shaders/lib'

/**
 * One competitor, drawn procedurally on its own quad.
 *
 * The quad is deliberately larger than the body so wings and bugged-out eyes
 * have somewhere to go without being clipped. Everything is drawn from signed
 * distances and hard-thresholded, which gives clean pixel edges once this is
 * rasterised into the low-resolution foreground target.
 */
export const CAPY_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec3  uColor;
  uniform float uTime;
  uniform float uFacing;
  uniform float uSquash;
  uniform float uSpin;
  uniform float uEyeScale;
  uniform float uWings;
  uniform float uBlow;
  uniform float uGlow;
  uniform float uDim;
  uniform float uBodyScale;
  uniform float uPuff;

  ${SDF}

  const vec3 INK = vec3(0.06, 0.05, 0.09);

  void main() {
    // Local space: body roughly spans x -0.5..0.5, y -0.35..0.35.
    vec2 p = vUv - 0.5;

    // The quad is deliberately oversized so wings and bugged eyes have room.
    // Scaling local space by the same factor shrinks the body back to its true
    // size inside it — without this the body is drawn across the entire quad
    // and every capybara comes out several times too large.
    p *= uBodyScale;

    // Dividing local space inflates everything drawn from here on, which is how
    // a victim balloons after taking a lungful of air.
    p /= 1.0 + uPuff * 0.55;

    // Spin applies about the body centre, used while a victim tumbles away.
    float c = cos(uSpin), s = sin(uSpin);
    p = mat2(c, -s, s, c) * p;

    p.x *= uFacing;
    // Squash and stretch, preserving volume.
    p.y /= uSquash;
    p.x *= mix(1.0, uSquash, 0.6);

    // --- wings, drawn behind the body ------------------------------------
    float wingMask = 0.0;
    if (uWings > 0.001) {
      float flap = sin(uTime * 22.0) * 0.5 + 0.5;
      vec2 w = p;
      w.x = abs(w.x);
      vec2 wp = w - vec2(0.16, 0.10 + flap * 0.10);
      // Squeeze into a feather-ish ellipse that beats up and down.
      wp.y /= mix(0.45, 0.85, flap);
      wp *= mix(3.2, 2.4, uWings);
      wingMask = 1.0 - step(0.32, length(wp));
    }

    // --- body -------------------------------------------------------------
    float body  = sdRoundBox(p - vec2(-0.02, -0.02), vec2(0.30, 0.19), 0.13);
    float head  = sdRoundBox(p - vec2( 0.26,  0.09), vec2(0.13, 0.12), 0.08);
    float snout = sdRoundBox(p - vec2( 0.39,  0.03), vec2(0.07, 0.07), 0.05);
    float d = smin(body, head, 0.08);
    d = smin(d, snout, 0.05);
    d = smin(d, sdCircle(p - vec2(0.20, 0.24), 0.055), 0.03);

    // Legs swing while running; frozen mid-stride reads as a walk cycle.
    float stride = sin(uTime * 14.0) * 0.05;
    d = smin(d, sdRoundBox(p - vec2( 0.14 + stride, -0.26), vec2(0.05, 0.09), 0.04), 0.04);
    d = smin(d, sdRoundBox(p - vec2(-0.16 - stride, -0.26), vec2(0.05, 0.09), 0.04), 0.04);

    // --- straw, extended forward after a successful chase -----------------
    // Thick, white and long enough to read clearly at this pixel size, with a
    // burst of air pulsing along it so the blow is unmistakable.
    float straw = 1e9;
    float puffBurst = 1e9;
    if (uBlow > 0.001) {
      // Jab out fast, hold, then withdraw.
      float extend = smoothstep(0.0, 0.25, 1.0 - uBlow) * smoothstep(0.0, 0.30, uBlow);
      float len = 0.10 + extend * 0.16;
      straw = sdRoundBox(p - vec2(0.52 + len * 0.5, 0.02), vec2(len, 0.038), 0.030);

      // Three puffs travelling away from the tip on a loop.
      float tip = 0.52 + len;
      for (int i = 0; i < 3; i++) {
        float phase = fract(uTime * 2.2 + float(i) * 0.333);
        float dist = phase * 0.30;
        float size = (0.030 + phase * 0.055) * (1.0 - phase);
        puffBurst = min(puffBurst, sdCircle(p - vec2(tip + 0.05 + dist, 0.02), size));
      }
    }

    // --- assemble ---------------------------------------------------------
    float bodyMask = 1.0 - step(0.0, d);
    float outline = (1.0 - step(0.035, d)) - bodyMask;
    float strawMask = 1.0 - step(0.0, straw);
    float puffMask = 1.0 - step(0.0, puffBurst);

    vec3 col = uColor;
    // Lighter along the back, darker underneath — two-tone shading, the way a
    // sprite artist would ramp it.
    col *= mix(0.72, 1.12, smoothstep(-0.30, 0.28, p.y));

    // --- eyes -------------------------------------------------------------
    // Neutral is a single dark dot. Panic blows it up into a gargantuan white
    // cartoon eye that swamps the head, pupil rattling inside it.
    float eyeRadius = mix(0.032, 0.235, uEyeScale);
    vec2 eyePos = vec2(0.28 - uEyeScale * 0.02, 0.11 + uEyeScale * 0.05);
    float eye = sdCircle(p - eyePos, eyeRadius);
    float eyeMask = 1.0 - step(0.0, eye);

    // Pupil shrinks relative to the eye and jitters, which reads as shock.
    vec2 jitter = vec2(sin(uTime * 27.0), cos(uTime * 31.0)) * uEyeScale * 0.022;
    float pupilRadius = mix(0.030, 0.070, uEyeScale);
    float pupilMask = 1.0 - step(0.0, sdCircle(p - eyePos - jitter, pupilRadius));

    // A big eye needs an outline of its own or it merges into pale fur.
    float eyeRing = (1.0 - step(0.0, eye + 0.022)) ;
    float eyeRimMask = eyeMask - eyeRing;

    float alpha = max(max(bodyMask, outline), max(max(wingMask, strawMask), puffMask));
    // The huge eye can extend past the body silhouette.
    alpha = max(alpha, eyeMask * uEyeScale);
    if (alpha < 0.5) discard;

    vec3 outColor = col;
    if (wingMask > 0.5 && bodyMask < 0.5) outColor = vec3(0.95, 0.96, 1.0);
    if (outline > 0.5 && bodyMask < 0.5) outColor = INK;

    if (bodyMask > 0.5 || (eyeMask > 0.5 && uEyeScale > 0.2)) {
      if (eyeMask > 0.5) outColor = mix(INK, vec3(0.99), step(0.2, uEyeScale));
      if (eyeRimMask > 0.5 && uEyeScale > 0.2) outColor = INK;
      if (pupilMask > 0.5) outColor = INK;
    }

    // Straw and its air burst sit on top of everything.
    if (puffMask > 0.5) outColor = vec3(0.92, 0.95, 1.0);
    if (strawMask > 0.5) outColor = vec3(1.0, 1.0, 1.0);

    // Audio glow, plus a dim pass for anyone already knocked out of the round.
    outColor *= 1.0 + uGlow * 0.35;
    outColor = mix(outColor, outColor * 0.45, uDim);

    gl_FragColor = vec4(outColor, 1.0);
  }
`

/**
 * A platform slab.
 *
 * Hard horizontal bands rather than a gradient: a lit top edge, a mid body and
 * a shadowed underside is the classic three-tone platformer tile, and it stays
 * crisp at this resolution where a smooth ramp would just dither.
 */
export const PLATFORM_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec3  uColor;
  uniform float uGlow;
  uniform float uPulse;
  uniform vec2  uPixelSize;

  void main() {
    // Thickness of the edge bands in this platform's own UV space, so they stay
    // a constant number of screen pixels regardless of platform size.
    float topBand = uPixelSize.y * 2.0;
    float underBand = uPixelSize.y * 1.5;

    vec3 col = uColor;
    if (vUv.y > 1.0 - topBand) {
      col = mix(uColor, vec3(1.0), 0.55);        // lit top lip
    } else if (vUv.y < underBand) {
      col = uColor * 0.35;                       // shadowed underside
    } else {
      col = uColor * mix(0.62, 0.78, vUv.y);     // body
    }

    // Side edges get the same ink border as the sprites.
    if (vUv.x < uPixelSize.x || vUv.x > 1.0 - uPixelSize.x) {
      col = vec3(0.06, 0.05, 0.09);
    }

    col *= 1.0 + uGlow * 0.9 * uPulse;
    gl_FragColor = vec4(col, 1.0);
  }
`

/**
 * Dark liquid surface behind everything.
 *
 * Rendered at full resolution rather than into the pixel-art target — the
 * contrast between a smooth, slow, deep background and hard-edged pixel
 * foreground is the whole look.
 */
export const LIQUID_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;
  uniform float uBass;
  uniform float uMid;
  uniform float uHigh;
  uniform float uLevel;
  uniform float uPunch;
  uniform float uHue;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += valueNoise(p) * amp;
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 3.0;

    // Domain warping is what makes this read as a liquid rather than clouds:
    // the field is displaced by another copy of itself.
    float t = uTime * (0.12 + uLevel * 0.18);
    vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, -t * 0.8)));
    vec2 r = vec2(
      fbm(p + 2.4 * q + vec2(1.7, 9.2) + t * 0.5),
      fbm(p + 2.4 * q + vec2(8.3, 2.8) - t * 0.4)
    );
    float surface = fbm(p + 3.2 * r * (1.0 + uBass * 0.7));

    // Deep, desaturated palette so the foreground pixels always sit on top of
    // it clearly. Hue drifts, but never brightens enough to compete.
    vec3 deep = vec3(0.03, 0.04, 0.09);
    vec3 mid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + uHue + surface * 0.5));
    mid *= vec3(0.18, 0.20, 0.34);
    vec3 col = mix(deep, mid, smoothstep(0.25, 0.85, surface));

    // Slick highlights riding the crests, pushed by the top end.
    float crest = smoothstep(0.62, 0.95, surface + length(r) * 0.25);
    col += vec3(0.30, 0.45, 0.70) * crest * (0.25 + uHigh * 0.55);

    // Beat sends a bright swell through the whole surface.
    col += vec3(0.20, 0.14, 0.34) * uPunch * (0.35 + surface);

    // Vignette keeps attention in the middle where the action is.
    col *= 1.0 - 0.45 * pow(length(vUv - 0.5) * 1.3, 2.0);

    gl_FragColor = vec4(col, 1.0);
  }
`
