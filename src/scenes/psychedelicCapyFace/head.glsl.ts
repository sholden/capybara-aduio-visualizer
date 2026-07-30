import { FEATURES } from './features'

const COUNT = FEATURES.length

/**
 * Shared between vertex and fragment stages: the same feature influence falloff
 * drives both the Z pop and the UV magnification, so they stay locked together.
 */
const FEATURE_COMMON = /* glsl */ `
  uniform vec2  uFeaturePos[${COUNT}];
  uniform float uFeatureRadius[${COUNT}];
  uniform float uFeatureDrive[${COUNT}];
  uniform float uFeatureSwell[${COUNT}];
  uniform float uFeaturePop[${COUNT}];
  uniform float uAspectCorrect;

  // Smooth 0..1 influence of feature i at texture coordinate uv.
  float featureFalloff(vec2 uv, int index) {
    vec2 delta = uv - uFeaturePos[index];
    delta.y *= uAspectCorrect;
    float d = length(delta);
    return 1.0 - smoothstep(0.0, uFeatureRadius[index], d);
  }
`

export const HEAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying float vPop;
  varying vec3 vViewPos;

  uniform float uTime;
  uniform float uDome;
  uniform float uWobble;
  uniform float uLevel;

  ${FEATURE_COMMON}

  void main() {
    vUv = uv;

    vec3 pos = position;

    // Base relief: a soft dome so the photo reads as a curved surface rather
    // than a flat card, strongest at the centre of the face.
    vec2 c = uv - vec2(0.5, 0.45);
    c.y *= uAspectCorrect;
    float dome = exp(-dot(c, c) * 3.2);
    pos.z += dome * uDome;

    // Slow organic breathing across the whole surface.
    pos.z += sin(uv.x * 7.0 + uTime * 0.9) * sin(uv.y * 5.0 - uTime * 0.7)
           * 0.035 * uWobble * (0.4 + uLevel);

    // Per-feature pop toward the camera.
    float pop = 0.0;
    for (int i = 0; i < ${COUNT}; i++) {
      float f = featureFalloff(uv, i);
      // Smootherstep on the falloff keeps the bulge rounded instead of conical.
      f = f * f * (3.0 - 2.0 * f);
      pop += f * uFeatureDrive[i] * uFeaturePop[i];
    }
    pos.z += pop;
    vPop = pop;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

export const HEAD_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vPop;
  varying vec3 vViewPos;

  uniform sampler2D uPhoto;
  uniform float uTime;
  uniform float uHue;
  uniform float uPunch;
  uniform float uHigh;
  uniform float uChroma;
  uniform vec4  uFaceCore;
  uniform float uCoreGrow;

  ${FEATURE_COMMON}

  // Magnify the photo around each feature by sampling closer to its centre.
  vec2 swellUv(vec2 uv) {
    vec2 out_ = uv;
    for (int i = 0; i < ${COUNT}; i++) {
      float f = featureFalloff(uv, i);
      f = f * f * (3.0 - 2.0 * f);
      float amount = f * uFeatureDrive[i] * uFeatureSwell[i];
      vec2 delta = out_ - uFeaturePos[i];
      // Pulling samples inward stretches the centre outward — the feature
      // appears to grow without moving the surrounding face.
      out_ = uFeaturePos[i] + delta * (1.0 - amount);
    }
    return out_;
  }

  void main() {
    vec2 uv = swellUv(vUv);

    // Chromatic split, scaled by how far this pixel has popped out. Cheap, and
    // it makes the bulging features feel like they are straining.
    float split = (0.0016 + uHigh * 0.0042 + vPop * 0.010) * uChroma;
    vec2 dir = normalize(uv - vec2(0.5, 0.45) + 1e-5);
    vec3 photo;
    photo.r = texture2D(uPhoto, uv + dir * split).r;
    photo.g = texture2D(uPhoto, uv).g;
    photo.b = texture2D(uPhoto, uv - dir * split).b;

    float luma = dot(photo, vec3(0.299, 0.587, 0.114));

    // --- alpha ------------------------------------------------------------
    // The photo is shot on black, so luminance keys the background out. The
    // eyes, nostrils and mouth are near-black too, so a face-core ellipse
    // protects them from being keyed into holes. It grows with the bulges so a
    // swollen eye cannot escape the protected region.
    vec2 core = (uv - uFaceCore.xy) / (uFaceCore.zw * uCoreGrow);
    float protectCore = 1.0 - smoothstep(0.85, 1.0, length(core));
    float keyed = smoothstep(0.020, 0.085, luma);
    float alpha = clamp(max(keyed, protectCore), 0.0, 1.0);

    // Trim the very edge of the plane so the geometry border never shows.
    vec2 edge = smoothstep(vec2(0.0), vec2(0.02), vUv)
              * smoothstep(vec2(0.0), vec2(0.02), 1.0 - vUv);
    alpha *= edge.x * edge.y;

    if (alpha < 0.004) discard;

    // --- shading ----------------------------------------------------------
    vec3 col = photo;

    // Popped features catch a psychedelic rim light whose hue tracks the
    // fractal behind, so the head reads as lit by the scene it sits in.
    // Deliberately restrained: at higher intensities the bulges turned into
    // flat glowing orbs and you lost the eye, nostril and mouth detail that
    // makes the swelling read as a face doing something silly.
    vec3 rim = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + uHue + vPop * 0.8));
    col += rim * clamp(vPop, 0.0, 1.0) * (0.12 + uPunch * 0.26);

    // Subtle overall tint pulse so the head never looks pasted on.
    col *= 1.0 + 0.16 * uPunch;
    col = mix(col, col * rim * 1.6, 0.06 + uHigh * 0.08);

    col = col / (1.0 + col * 0.25);
    gl_FragColor = vec4(col, alpha);
  }
`
