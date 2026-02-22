/**
 * WebGL display renderer — two-pass pipeline.
 *
 * Pass 1 (upscale): Renders the emulator pixel buffer to an FBO at display
 *   resolution with nearest-neighbor (or user-controlled smoothing).
 *
 * Pass 2 (CRT): Samples the upscaled FBO with barrel distortion (LINEAR
 *   filtering for smooth curves), then applies scanlines, dot mask,
 *   brightness/contrast, and vignette.
 */

import type { IScreenRenderer } from '@/display/display.ts';
import hq2xLutUrl from '@/display/hq2x-lut.png';  // 256×64 RGBA LUT for HQ2x blend weights
import hq3xLutUrl from '@/display/hq3x-lut.png';  // 256×144 RGBA LUT for HQ3x blend weights
import hq4xLutUrl from '@/display/hq4x-lut.png';  // 256×256 RGBA LUT for HQ4x blend weights
import { FRAG_HQ2X, FRAG_HQ3X, FRAG_HQ4X } from '@/display/shaders/hqx.ts';
import { FRAG_XBR_LV2, FRAG_XBR_LV3 } from '@/display/shaders/xbr.ts';
import { UPSCALE_HEAD } from '@/display/shaders/upscale-head.ts';

const VERT_SRC = `
  attribute vec2 a_pos;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

// ── Pass 1 shaders: pixel upscaling algorithms ──
//
// Each shader reads from the emulator source texture (NEAREST filtered)
// and writes to the FBO at display resolution. All shaders receive:
//   u_tex      — source texture
//   u_texSize  — source dimensions (e.g. 352, 288)
//   u_smoothing — 0..1 blending parameter (used by modes 0 and 1)

// 0: Nearest / Bilinear (original shader, controlled by smoothing slider)
const FRAG_UPSCALE = UPSCALE_HEAD + `
  void main() {
    if (u_smoothing <= 0.0) {
      gl_FragColor = texture2D(u_tex, v_uv);
      return;
    }
    vec2 texel = v_uv * u_texSize - 0.5;
    vec2 f = fract(texel);
    vec2 base = (floor(texel) + 0.5) / u_texSize;
    vec2 step = 1.0 / u_texSize;
    vec4 tl = texture2D(u_tex, base);
    vec4 tr = texture2D(u_tex, base + vec2(step.x, 0.0));
    vec4 bl = texture2D(u_tex, base + vec2(0.0, step.y));
    vec4 br = texture2D(u_tex, base + step);
    vec4 bilinear = mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
    vec4 nearest = texture2D(u_tex, v_uv);
    gl_FragColor = mix(nearest, bilinear, u_smoothing);
  }
`;


// Array of all upscale fragment shaders, indexed by scaling mode
const UPSCALE_SHADERS = [
  FRAG_UPSCALE,    // 0: Nearest / Bilinear
  FRAG_HQ2X,       // 1: HQ2x
  FRAG_HQ3X,       // 2: HQ3x
  FRAG_HQ4X,       // 3: HQ4x
  FRAG_XBR_LV2,    // 4: xBR-lv2
  FRAG_XBR_LV3,    // 5: xBR-lv3
];

// ── Pass 2: CRT effects (curvature, scanlines, dot mask, brightness) ──
const FRAG_CRT = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;       // upscaled FBO (LINEAR filtering)
  uniform vec2 u_resolution;
  uniform vec2 u_texSize;        // original emulator resolution (for scanline scale)
  uniform float u_curvature;     // 0 = flat, up to 0.15
  uniform float u_scanlines;     // 0 = off, 1 = full gap
  uniform int   u_maskType;      // 0=none, 1=shadow mask, 2=aperture grille, 3=slot mask
  uniform float u_dotPitch;      // mask cell size in pixels (3-8)
  uniform int   u_curvatureMode; // 0=spherical, 1=cylindrical
  uniform float u_brightness;    // -1 to 1, default 0
  uniform float u_contrast;      // 0 to 2, default 1
  uniform float u_noise;         // 0 = off, up to 1 = heavy noise
  uniform float u_frame;         // frame counter for varying noise
  uniform float u_scale;         // integer device-pixel scale (passed from CPU)

  // Hash-based pseudo-random noise (returns 0..1)
  float hash(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  vec2 barrel(vec2 uv, float k) {
    vec2 c = uv - 0.5;
    if (u_curvatureMode == 1) {
      // Cylindrical: curve X only (Trinitron-style)
      float r2 = c.x * c.x;
      return uv + vec2(c.x * r2 * k, 0.0);
    }
    float r2 = dot(c, c);
    return uv + c * r2 * k;
  }

  void main() {
    vec2 uv = v_uv;

    // Barrel distortion
    if (u_curvature > 0.0) {
      uv = barrel(uv, u_curvature);
    }

    // Soft edge: fade to black over 1 pixel at the curved boundary
    vec2 px = 1.0 / u_resolution;
    float edgeAlpha = smoothstep(0.0, px.x, uv.x) * smoothstep(0.0, px.x, 1.0 - uv.x)
                    * smoothstep(0.0, px.y, uv.y) * smoothstep(0.0, px.y, 1.0 - uv.y);

    if (edgeAlpha <= 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // Sample the upscaled FBO — LINEAR filtering gives smooth barrel curves
    vec3 col = texture2D(u_tex, uv).rgb * edgeAlpha;

    // -- Scanlines: darken every Nth physical pixel row (pure counting) --
    float scanFactor = 0.0;
    if (u_scanlines > 0.0) {
      float scale = u_scale;
      if (scale > 1.0) {
        float row = mod(floor(gl_FragCoord.y), scale);
        float isGap = step(scale - 1.0, row);
        scanFactor = isGap * u_scanlines;
        col *= 1.0 - scanFactor;
      }
    }

    // -- Parameterized dot mask --
    float maskFactor = 0.0;
    if (u_maskType > 0) {
      col = max(col, vec3(0.03));  // CRT phosphors always glow faintly
      float pitch = u_dotPitch;
      // pitch 1 = fine (1px per channel, 3px triad), pitch 4 = coarse screen-door
      float base = mix(0.75, 0.45, (pitch - 1.0) / 3.0);
      float highlight = 1.0 - base;
      float fpx = floor(gl_FragCoord.x);
      float fpy = floor(gl_FragCoord.y);
      float triad = pitch * 3.0;

      if (u_maskType == 1) {
        // Shadow mask: round phosphor dots in delta/triangular arrangement
        float rowH = pitch * 1.5;
        float row = floor(fpy / rowH);
        // 3-phase stagger (0, pitch, 2*pitch) gives true triangular layout
        float stagger = mod(row, 3.0) * pitch;
        float lx = mod(fpx + stagger, triad);
        float ly = mod(fpy, rowH);
        float cy = rowH * 0.5;

        // Wrapped horizontal distance to each phosphor dot centre
        float dxR = abs(lx - 0.5 * pitch); dxR = min(dxR, triad - dxR);
        float dxG = abs(lx - 1.5 * pitch); dxG = min(dxG, triad - dxG);
        float dxB = abs(lx - 2.5 * pitch); dxB = min(dxB, triad - dxB);
        float dy = ly - cy;

        // Euclidean distance to each dot centre
        float distR = length(vec2(dxR, dy));
        float distG = length(vec2(dxG, dy));
        float distB = length(vec2(dxB, dy));

        // Soft circular phosphor profile
        float r = pitch * 0.55;
        float edge = max(0.7, pitch * 0.25);
        vec3 dots = vec3(
          smoothstep(r, r - edge, distR),
          smoothstep(r, r - edge, distG),
          smoothstep(r, r - edge, distB)
        );
        col *= base + highlight * dots;
      } else if (u_maskType == 2) {
        // Aperture grille: vertical RGB stripes (Trinitron-style), no horizontal gaps
        float ch = floor(mod(fpx, triad) / pitch);
        vec3 mask = vec3(base);
        mask += highlight * vec3(1.0 - min(ch, 1.0), 1.0 - abs(ch - 1.0), max(ch - 1.0, 0.0));
        col *= mask;
      } else if (u_maskType == 3) {
        // Slot mask: vertical RGB slots with horizontal gap every few rows
        float stagger = mod(fpy, 2.0) * (triad * 0.5);
        float ch = floor(mod(fpx + stagger, triad) / pitch);
        vec3 mask = vec3(base);
        mask += highlight * vec3(1.0 - min(ch, 1.0), 1.0 - abs(ch - 1.0), max(ch - 1.0, 0.0));
        // Horizontal slot gap every 3 rows
        float slotGap = step(2.0, mod(fpy, 3.0));
        mask *= 1.0 - slotGap * 0.3;
        col *= mask;
      } else if (u_maskType == 4) {
        // LCD grid: darken 1px gap at cell boundaries in both axes
        float sc = u_scale;
        float gapX = step(sc - 1.0, mod(fpx, sc));
        float gapY = step(sc - 1.0, mod(fpy, sc));
        float grid = max(gapX, gapY);
        col *= 1.0 - grid * 0.55;
      } else if (u_maskType == 5) {
        // Attr mask: LCD pixel grid + checkerboard tint on 8x8 attribute cells
        float sc = u_scale;
        // Per-pixel LCD grid lines
        float gapX = step(sc - 1.0, mod(fpx, sc));
        float gapY = step(sc - 1.0, mod(fpy, sc));
        float grid = max(gapX, gapY);
        col *= 1.0 - grid * 0.45;
        // Checkerboard on 8x8 attr cells
        float borderX = (u_texSize.x - 256.0) / 2.0;
        float borderY = (u_texSize.y - 192.0) / 2.0;
        float srcX = uv.x * u_texSize.x - borderX;
        float srcY = uv.y * u_texSize.y - borderY;
        if (srcX >= 0.0 && srcX < 256.0 && srcY >= 0.0 && srcY < 192.0) {
          float cellX = floor(srcX / 8.0);
          float cellY = floor(srcY / 8.0);
          float checker = mod(cellX + cellY, 2.0);
          col *= 0.55 + checker * 0.45;
        }
      }
      maskFactor = u_maskType == 4 || u_maskType == 5 ? 0.25 : highlight;
    }

    // -- Brightness compensation --
    if (maskFactor > 0.0 || scanFactor > 0.0) {
      col *= 1.0 + (maskFactor + scanFactor) * 1.5;
    }

    // -- Vignette (scales with curvature) --
    if (u_curvature > 0.0) {
      vec2 vig = uv - 0.5;
      col *= 1.0 - dot(vig, vig) * u_curvature * 3.0;
    }

    // -- Noise (brightness perturbation) --
    if (u_noise > 0.0) {
      float n = hash(vec3(gl_FragCoord.xy, u_frame)) * 2.0 - 1.0; // -1..1
      col += n * u_noise * 0.15;
    }

    // -- Brightness / Contrast --
    col = (col - 0.5) * u_contrast + 0.5 + u_brightness;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class WebGLRenderer implements IScreenRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  width: number;
  height: number;

  // Pass 1 (upscale) — one program per scaling algorithm
  private upscalePrograms: WebGLProgram[] = [];
  private upscaleUniforms: { texSize: WebGLUniformLocation | null; smoothing: WebGLUniformLocation | null; lut: WebGLUniformLocation | null }[] = [];
  private scalingMode = 0;
  private lutTextures: (WebGLTexture | null)[] = [];  // per-mode LUT textures
  private fbo: WebGLFramebuffer;
  private fboTex: WebGLTexture;

  // Pass 2 (CRT)
  private progCRT: WebGLProgram;

  scale = 2;
  private buffer: WebGLBuffer;     // quad with flipped UVs (for source texture)
  private bufferFBO: WebGLBuffer;  // quad with standard UVs (for FBO)
  private glDirty = true;

  // Effect parameters
  private smoothing = 0;
  private curvature = 0;
  private scanlines = 0;
  private maskType = 0;
  private dotPitch = 1;
  private curvatureMode = 0;
  private brightness = 0;
  private contrast = 1;
  private noise = 0;
  private frameCount = 0;

  // Cached uniform locations — pass 2
  private u2Resolution: WebGLUniformLocation | null = null;
  private u2TexSize: WebGLUniformLocation | null = null;
  private u2Curvature: WebGLUniformLocation | null = null;
  private u2Scanlines: WebGLUniformLocation | null = null;
  private u2MaskType: WebGLUniformLocation | null = null;
  private u2DotPitch: WebGLUniformLocation | null = null;
  private u2CurvatureMode: WebGLUniformLocation | null = null;
  private u2Brightness: WebGLUniformLocation | null = null;
  private u2Contrast: WebGLUniformLocation | null = null;
  private u2Noise: WebGLUniformLocation | null = null;
  private u2Frame: WebGLUniformLocation | null = null;
  private u2Scale: WebGLUniformLocation | null = null;
  private deviceScale = 2;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Quad with flipped UVs for pass 1 (source texture is top-down pixel data)
    const verts = new Float32Array([
      // pos       uv
      -1, -1,     0, 1,
       1, -1,     1, 1,
      -1,  1,     0, 0,
       1,  1,     1, 0,
    ]);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // Quad with standard UVs for pass 2 (FBO is already in GL orientation)
    const vertsFBO = new Float32Array([
      // pos       uv
      -1, -1,     0, 0,
       1, -1,     1, 0,
      -1,  1,     0, 1,
       1,  1,     1, 1,
    ]);
    this.bufferFBO = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufferFBO);
    gl.bufferData(gl.ARRAY_BUFFER, vertsFBO, gl.STATIC_DRAW);

    // ── Pass 1 programs (one per scaling algorithm) ──
    for (const src of UPSCALE_SHADERS) {
      const prog = this.buildProgram(VERT_SRC, src);
      this.upscalePrograms.push(prog);
      this.upscaleUniforms.push({
        texSize: gl.getUniformLocation(prog, 'u_texSize'),
        smoothing: gl.getUniformLocation(prog, 'u_smoothing'),
        lut: gl.getUniformLocation(prog, 'u_lut'),
      });
    }

    // ── Load HQ4x LUT texture asynchronously ──
    this.loadLUT();

    // ── Pass 2 program (CRT) ──
    this.progCRT = this.buildProgram(VERT_SRC, FRAG_CRT);
    this.u2Resolution = gl.getUniformLocation(this.progCRT, 'u_resolution');
    this.u2TexSize = gl.getUniformLocation(this.progCRT, 'u_texSize');
    this.u2Curvature = gl.getUniformLocation(this.progCRT, 'u_curvature');
    this.u2Scanlines = gl.getUniformLocation(this.progCRT, 'u_scanlines');
    this.u2MaskType = gl.getUniformLocation(this.progCRT, 'u_maskType');
    this.u2DotPitch = gl.getUniformLocation(this.progCRT, 'u_dotPitch');
    this.u2CurvatureMode = gl.getUniformLocation(this.progCRT, 'u_curvatureMode');
    this.u2Brightness = gl.getUniformLocation(this.progCRT, 'u_brightness');
    this.u2Contrast = gl.getUniformLocation(this.progCRT, 'u_contrast');
    this.u2Noise = gl.getUniformLocation(this.progCRT, 'u_noise');
    this.u2Frame = gl.getUniformLocation(this.progCRT, 'u_frame');
    this.u2Scale = gl.getUniformLocation(this.progCRT, 'u_scale');

    // ── Source texture (emulator pixels, NEAREST) ──
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // ── FBO texture (upscaled, LINEAR for smooth barrel sampling) ──
    this.fboTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ── Framebuffer ──
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Apply default 2x scale (also sizes the FBO texture)
    this.applyScale();
  }

  private buildProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = this.compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));
    }
    return program;
  }

  private compileShader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  private loadLUT(): void {
    // Load LUT textures for each HQx mode that needs one.
    // Map: UPSCALE_SHADERS index → LUT URL (null = no LUT needed)
    const lutMap: (string | null)[] = UPSCALE_SHADERS.map(() => null);
    lutMap[1] = hq2xLutUrl;   // HQ2x
    lutMap[2] = hq3xLutUrl;   // HQ3x
    lutMap[3] = hq4xLutUrl;   // HQ4x

    const gl = this.gl;
    this.lutTextures = lutMap.map(() => null);

    for (let i = 0; i < lutMap.length; i++) {
      const url = lutMap[i];
      if (!url) continue;
      const idx = i;
      const img = new Image();
      img.onload = () => {
        const tex = gl.createTexture()!;
        gl.activeTexture(gl.TEXTURE2);  // scratch unit
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.activeTexture(gl.TEXTURE0);
        this.lutTextures[idx] = tex;
        this.glDirty = true;
      };
      img.src = url;
    }
  }

  private bindAttributes(program: WebGLProgram, buf?: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf || this.buffer);

    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);

    const aUV = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
  }

  private applyScale(): void {
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    this.deviceScale = Math.round(this.scale * dpr);
    const w = this.width * this.deviceScale;
    const h = this.height * this.deviceScale;

    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = (w / dpr) + 'px';
    this.canvas.style.height = (h / dpr) + 'px';

    // Resize FBO texture to match display resolution
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Canvas resize invalidates GL state; defer full restore to next draw
    this.glDirty = true;
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.applyScale();
  }

  setSmoothing(v: number): void {
    this.smoothing = Math.max(0, Math.min(1, v));
    this.glDirty = true;
  }

  setCurvature(v: number): void {
    this.curvature = Math.max(0, Math.min(0.15, v));
    this.glDirty = true;
  }

  setScanlines(v: number): void {
    this.scanlines = Math.max(0, Math.min(1, v));
    this.glDirty = true;
  }

  setMaskType(v: number): void {
    this.maskType = v;
    this.glDirty = true;
  }

  setDotPitch(v: number): void {
    this.dotPitch = Math.max(1, Math.min(4, v));
    this.glDirty = true;
  }

  setCurvatureMode(v: number): void {
    this.curvatureMode = v;
    this.glDirty = true;
  }

  setBrightness(v: number): void {
    this.brightness = Math.max(-1, Math.min(1, v));
    this.glDirty = true;
  }

  setContrast(v: number): void {
    this.contrast = Math.max(0, Math.min(2, v));
    this.glDirty = true;
  }

  setNoise(v: number): void {
    this.noise = Math.max(0, Math.min(1, v));
    this.glDirty = true;
  }

  setScalingMode(v: number): void {
    const mode = Math.max(0, Math.min(UPSCALE_SHADERS.length - 1, v | 0));
    if (mode !== this.scalingMode) {
      this.scalingMode = mode;
      this.glDirty = true;
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.applyScale();
  }

  /**
   * Upload pixel buffer and draw (two-pass).
   */
  updateTexture(pixels: Uint8Array): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dirty = this.glDirty;

    // Upload emulator pixels to source texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (dirty) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // ── Pass 1: upscale to FBO ──
    const prog = this.upscalePrograms[this.scalingMode];
    const unis = this.upscaleUniforms[this.scalingMode];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    this.bindAttributes(prog);
    // Source texture is already bound
    if (dirty) {
      gl.uniform2f(unis.texSize, this.width, this.height);
    }
    gl.uniform1f(unis.smoothing, this.smoothing);
    // Bind LUT texture for HQx modes
    const lutTex = this.lutTextures[this.scalingMode];
    if (unis.lut !== null && lutTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.uniform1i(unis.lut, 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── Pass 2: CRT effects to screen ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progCRT);
    this.bindAttributes(this.progCRT, this.bufferFBO);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    if (dirty) {
      gl.uniform2f(this.u2Resolution, w, h);
      gl.uniform2f(this.u2TexSize, this.width, this.height);
      gl.uniform1f(this.u2Curvature, this.curvature);
      gl.uniform1f(this.u2Scanlines, this.scanlines);
      gl.uniform1i(this.u2MaskType, this.maskType);
      gl.uniform1f(this.u2DotPitch, this.dotPitch);
      gl.uniform1i(this.u2CurvatureMode, this.curvatureMode);
      gl.uniform1f(this.u2Brightness, this.brightness);
      gl.uniform1f(this.u2Contrast, this.contrast);
      gl.uniform1f(this.u2Scale, this.deviceScale);
    }
    // u_noise and u_frame must stay in sync every frame when noise is active:
    // u_frame drives per-frame variation; u_noise must be current when it changes.
    if (this.noise > 0) {
      gl.uniform1f(this.u2Noise, this.noise);
      gl.uniform1f(this.u2Frame, this.frameCount);
    } else if (dirty) {
      gl.uniform1f(this.u2Noise, 0.0);
    }
    this.frameCount = (this.frameCount + 1) & 0x7FFFFFFF;
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.glDirty = false;
  }
}
