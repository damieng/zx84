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

const VERT_SRC = `
  attribute vec2 a_pos;
  attribute vec2 a_uv;
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

// ── Pass 1: upscale with optional smoothing ──
const FRAG_UPSCALE = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_texSize;
  uniform float u_smoothing;   // 0 = nearest, 1 = full bilinear

  void main() {
    if (u_smoothing <= 0.0) {
      gl_FragColor = texture2D(u_tex, v_uv);
      return;
    }
    // Manual 4-tap bilinear (texture stays NEAREST)
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
      float scale = floor(u_resolution.y / u_texSize.y + 0.5);
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
        // Shadow mask (dot trio): staggered RGB triads, per-row stagger
        float stagger = mod(fpy, 2.0) * (triad * 0.5);
        float ch = floor(mod(fpx + stagger, triad) / pitch);
        vec3 mask = vec3(base);
        mask += highlight * vec3(1.0 - min(ch, 1.0), 1.0 - abs(ch - 1.0), max(ch - 1.0, 0.0));
        col *= mask;
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
        float sc = floor(u_resolution.y / u_texSize.y + 0.5);
        float gapX = step(sc - 1.0, mod(fpx, sc));
        float gapY = step(sc - 1.0, mod(fpy, sc));
        float grid = max(gapX, gapY);
        col *= 1.0 - grid * 0.55;
      }
      maskFactor = u_maskType == 4 ? 0.25 : highlight;
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

    // -- Brightness / Contrast --
    col = (col - 0.5) * u_contrast + 0.5 + u_brightness;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class Display {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  width: number;
  height: number;

  // Pass 1 (upscale)
  private progUpscale: WebGLProgram;
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

  // Cached uniform locations — pass 1
  private u1TexSize: WebGLUniformLocation | null = null;
  private u1Smoothing: WebGLUniformLocation | null = null;

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

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
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

    // ── Pass 1 program (upscale) ──
    this.progUpscale = this.buildProgram(VERT_SRC, FRAG_UPSCALE);
    this.u1TexSize = gl.getUniformLocation(this.progUpscale, 'u_texSize');
    this.u1Smoothing = gl.getUniformLocation(this.progUpscale, 'u_smoothing');

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
    const w = this.width * this.scale;
    const h = this.height * this.scale;

    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = '';
    this.canvas.style.height = '';

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
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progUpscale);
    this.bindAttributes(this.progUpscale);
    // Source texture is already bound
    if (dirty) {
      gl.uniform2f(this.u1TexSize, this.width, this.height);
    }
    gl.uniform1f(this.u1Smoothing, this.smoothing);
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
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.glDirty = false;
  }
}
