import * as THREE from 'three'
import type { AudioFrame, CapyScene, ParamSpec, SceneContext } from '@/core/types'
import { CAPYBARA_SDF, FULLSCREEN_VERTEX, NOISE, SDF } from '@/shaders/lib'

/** Internal render width. Everything is drawn here, then upscaled whole. */
const LOW_WIDTH = 320

const PARADE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;
  uniform float uBass;
  uniform float uHigh;
  uniform float uLevel;
  uniform float uPunch;
  uniform float uBeatCount;
  uniform float uScroll;
  uniform float uCount;
  uniform vec2  uLowRes;

  ${SDF}
  ${NOISE}
  ${CAPYBARA_SDF}

  // Fixed 8-colour ramp. Quantising to a real palette — rather than just
  // rendering small — is what actually makes this read as pixel art.
  const vec3 PAL0 = vec3(0.102, 0.071, 0.125);
  const vec3 PAL1 = vec3(0.239, 0.169, 0.239);
  const vec3 PAL2 = vec3(0.420, 0.290, 0.227);
  const vec3 PAL3 = vec3(0.549, 0.384, 0.224);
  const vec3 PAL4 = vec3(0.784, 0.624, 0.420);
  const vec3 PAL5 = vec3(0.235, 0.498, 0.478);
  const vec3 PAL6 = vec3(0.878, 0.541, 0.298);
  const vec3 PAL7 = vec3(0.957, 0.878, 0.753);
  // Deep water. Without a palette entry near it, the water gradient dithered
  // between two distant colours and broke into mottled patches.
  const vec3 PAL8 = vec3(0.145, 0.318, 0.322);

  vec3 quantise(vec3 c) {
    vec3 best = PAL0;
    float bestD = distance(c, PAL0);
    #define TRY(P) { float d = distance(c, P); if (d < bestD) { bestD = d; best = P; } }
    TRY(PAL1) TRY(PAL2) TRY(PAL3) TRY(PAL4) TRY(PAL5) TRY(PAL6) TRY(PAL7) TRY(PAL8)
    #undef TRY
    return best;
  }

  // 4x4 Bayer matrix — breaks up banding before quantisation.
  float bayer(vec2 pixel) {
    int x = int(mod(pixel.x, 4.0));
    int y = int(mod(pixel.y, 4.0));
    int index = x + y * 4;
    float m[16];
    m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
    m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
    m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
    m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
    float v = 0.0;
    for (int i = 0; i < 16; i++) { if (i == index) v = m[i]; }
    return v / 16.0 - 0.5;
  }

  void main() {
    vec2 pixel = vUv * uLowRes;
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.4;

    // --- sky --------------------------------------------------------------
    // Height above the horizon: bright at the shoreline, darkening upward.
    // (An earlier ramp ran the other way and washed the top of frame to cream.)
    float sky = smoothstep(-0.40, 1.20, p.y);
    vec3 col = mix(vec3(0.97, 0.62, 0.32), vec3(0.42, 0.20, 0.28),
                   smoothstep(0.0, 0.55, sky));
    col = mix(col, vec3(0.16, 0.09, 0.20), smoothstep(0.45, 1.0, sky));

    // Sun that swells with the low end.
    float sun = sdCircle(p - vec2(0.65, 0.55), 0.15 + uBass * 0.05);
    col = mix(col, vec3(0.98, 0.88, 0.70), smoothstep(0.01, -0.01, sun));

    // --- parallax hills ---------------------------------------------------
    for (int layer = 0; layer < 2; layer++) {
      float fl = float(layer);
      float speed = mix(0.06, 0.16, fl);
      float height = mix(-0.30, -0.12, fl);
      float h = fbm(vec2(p.x * 0.9 + uScroll * speed + fl * 10.0, fl * 3.0)) * 0.28;
      float hill = smoothstep(0.02, -0.02, p.y - (height + h));
      vec3 hillCol = mix(vec3(0.32, 0.22, 0.26), vec3(0.42, 0.29, 0.23), fl);
      col = mix(col, hillCol, hill);
    }

    // --- water ------------------------------------------------------------
    float waterTop = -0.56;
    float inWater = smoothstep(0.01, -0.01, p.y - waterTop);
    vec3 water = mix(vec3(0.14, 0.30, 0.32), vec3(0.235, 0.498, 0.478),
                     0.5 + 0.5 * sin(p.x * 4.0 + uTime * 1.2));
    col = mix(col, water, inWater);

    // Sparkle concentrated near the surface. Earlier attempts used step() over
    // a quantised coordinate, which drew hard blocks that read as artifacts;
    // a smooth wave lets the palette quantiser do the pixelating instead.
    float nearSurface = smoothstep(-0.30, 0.0, p.y - waterTop);
    float rip = sin(p.x * 5.0 + uTime * 1.6 + (waterTop - p.y) * 14.0);
    col = mix(col, vec3(0.957, 0.878, 0.753),
              inWater * nearSurface * smoothstep(0.45, 0.95, rip) * (0.22 + uHigh * 0.25));

    // --- shoreline the parade walks along ---------------------------------
    float groundTop = -0.40;
    float onGround = smoothstep(0.01, -0.01, p.y - groundTop) * (1.0 - inWater);
    vec3 ground = mix(vec3(0.420, 0.290, 0.227), vec3(0.330, 0.225, 0.190),
                      fbm(vec2(p.x * 3.0 + uScroll * 0.45, p.y * 6.0)));
    col = mix(col, ground, onGround);

    // --- the parade -------------------------------------------------------
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uCount) break;
      float fi = float(i);

      // Evenly spaced, marching leftward, wrapping so the line never runs out.
      // Span must exceed the visible width or the wrap point becomes visible
      // as animals popping in at the edge — on a 16:9 TV that is ±2.13 units.
      float span = max(3.2, uAspect * 2.4 + 1.0);
      float lane = mod(uScroll * 0.45 + fi * (span / uCount), span) - span * 0.5;
      float scale = 0.26;

      // Animation steps on the beat rather than continuously — the two-frame
      // waddle is what sells it as sprite animation.
      float step2 = mod(uBeatCount + fi, 2.0);
      float hop = step2 * 0.022 + uPunch * 0.035;
      float squash = 1.0 + (step2 - 0.5) * 0.10 + uPunch * 0.15;

      // Feet land on the shoreline.
      vec2 centre = vec2(lane, groundTop + 0.13 + hop);
      vec2 q = (p - centre) / scale;

      float d = sdCapybara(q, squash) * scale;
      float face = sdCapybaraFace(q, squash) * scale;

      float body = smoothstep(0.004, -0.004, d);
      vec3 fur = mix(vec3(0.549, 0.384, 0.224), vec3(0.784, 0.624, 0.420),
                     smoothstep(-0.3, 0.4, q.y));
      col = mix(col, fur, body);

      // Hard dark outline, the way a sprite would be drawn.
      float outline = smoothstep(0.014, 0.003, abs(d));
      col = mix(col, vec3(0.102, 0.071, 0.125), outline * 0.7);

      col = mix(col, vec3(0.102, 0.071, 0.125), smoothstep(0.004, -0.004, face));
    }

    // --- quantise ---------------------------------------------------------
    // Light dither only: at 0.055 the sky turned into visual static once it
    // hit the 8-colour ramp.
    col += bayer(pixel) * 0.028;
    col *= 1.0 + uLevel * 0.12;
    gl_FragColor = vec4(quantise(col), 1.0);
  }
`

const UPSCALE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uSource;
  void main() {
    gl_FragColor = texture2D(uSource, vUv);
  }
`

export class PixelCapyParade implements CapyScene {
  readonly id = 'pixelCapyParade'
  readonly name = 'Pixel Capy Parade'
  readonly tags = ['pixel', 'procedural', '2d'] as const

  readonly params: readonly ParamSpec[] = [
    { key: 'count', label: 'Capybaras', min: 1, max: 6, step: 1, default: 4 },
    { key: 'speed', label: 'March speed', min: 0, max: 2, step: 0.05, default: 1 },
  ]

  private lowScene = new THREE.Scene()
  private upScene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private target!: THREE.WebGLRenderTarget
  private paradeMaterial!: THREE.ShaderMaterial
  private upscaleMaterial!: THREE.ShaderMaterial
  private geometry!: THREE.PlaneGeometry
  private scroll = 0

  async load(ctx: SceneContext): Promise<void> {
    const aspect = ctx.width / ctx.height
    const lowHeight = Math.max(1, Math.round(LOW_WIDTH / aspect))

    this.target = new THREE.WebGLRenderTarget(LOW_WIDTH, lowHeight, {
      // Nearest on both filters is the whole point — anything else blurs the
      // pixels back into mush when this is blown up to a TV.
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    })
    this.target.texture.colorSpace = THREE.SRGBColorSpace

    this.geometry = new THREE.PlaneGeometry(2, 2)

    this.paradeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: aspect },
        uBass: { value: 0 },
        uHigh: { value: 0 },
        uLevel: { value: 0 },
        uPunch: { value: 0 },
        uBeatCount: { value: 0 },
        uScroll: { value: 0 },
        uCount: { value: 4 },
        uLowRes: { value: new THREE.Vector2(LOW_WIDTH, lowHeight) },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: PARADE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.lowScene.add(new THREE.Mesh(this.geometry, this.paradeMaterial))

    this.upscaleMaterial = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: this.target.texture } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: UPSCALE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    })
    this.upScene.add(new THREE.Mesh(this.geometry, this.upscaleMaterial))
  }

  update(frame: AudioFrame, params: Record<string, number>): void {
    // Scroll advances with the music so the parade stalls when the track does.
    this.scroll += frame.dt * (0.35 + frame.level * 0.9) * (params.speed ?? 1)

    const u = this.paradeMaterial.uniforms
    u.uTime!.value = frame.t
    u.uBass!.value = frame.bass
    u.uHigh!.value = frame.high
    u.uLevel!.value = frame.level
    u.uPunch!.value = frame.sinceBeat
    u.uBeatCount!.value = frame.beatCount
    u.uScroll!.value = this.scroll
    u.uCount!.value = params.count ?? 4
  }

  render(renderer: THREE.WebGLRenderer): void {
    // Preserve whatever the compositor bound, draw small, then blow it up.
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    renderer.render(this.lowScene, this.camera)
    renderer.setRenderTarget(previous)
    renderer.render(this.upScene, this.camera)
  }

  resize(width: number, height: number): void {
    const aspect = width / height
    const lowHeight = Math.max(1, Math.round(LOW_WIDTH / aspect))
    this.target.setSize(LOW_WIDTH, lowHeight)
    this.paradeMaterial.uniforms.uAspect!.value = aspect
    this.paradeMaterial.uniforms.uLowRes!.value.set(LOW_WIDTH, lowHeight)
  }

  dispose(): void {
    this.target.dispose()
    this.geometry.dispose()
    this.paradeMaterial.dispose()
    this.upscaleMaterial.dispose()
    this.lowScene.clear()
    this.upScene.clear()
  }
}
