/**
 * WebGL display renderer.
 * Renders a pixel buffer as a textured fullscreen quad with nearest-neighbor filtering.
 * Supports integer scaling (1x/2x/3x/4x) and parameterized CRT-style effects:
 *   smoothing, curvature, scanlines, dotmask.
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

const FRAG_DISPLAY = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_resolution;
  uniform vec2 u_texSize;
  uniform float u_smoothing;   // 0 = nearest, 1 = full bilinear
  uniform float u_curvature;   // 0 = flat, up to 0.15
  uniform float u_scanlines;   // 0 = off, 1 = full gap
  uniform int   u_dotmask;     // 0=none, 1=shadow mask, 2=trinitron

  vec2 barrel(vec2 uv, float k) {
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    return uv + c * r2 * k;
  }

  vec4 sampleTex(vec2 uv) {
    if (u_smoothing <= 0.0) {
      return texture2D(u_tex, uv);
    }
    // Manual 4-tap bilinear (texture stays NEAREST)
    vec2 texel = uv * u_texSize - 0.5;
    vec2 f = fract(texel);
    vec2 base = (floor(texel) + 0.5) / u_texSize;
    vec2 step = 1.0 / u_texSize;
    vec4 tl = texture2D(u_tex, base);
    vec4 tr = texture2D(u_tex, base + vec2(step.x, 0.0));
    vec4 bl = texture2D(u_tex, base + vec2(0.0, step.y));
    vec4 br = texture2D(u_tex, base + step);
    vec4 bilinear = mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
    vec4 nearest = texture2D(u_tex, uv);
    return mix(nearest, bilinear, u_smoothing);
  }

  void main() {
    vec2 uv = v_uv;

    // Barrel distortion
    if (u_curvature > 0.0) {
      uv = barrel(uv, u_curvature);
    }

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec3 col = sampleTex(uv).rgb;

    float scale = floor(u_resolution.y / u_texSize.y + 0.5);

    // -- Scanlines: gap on last pixel-row of each scaled group --
    float scanFactor = 0.0;
    if (u_scanlines > 0.0 && scale > 1.0) {
      float pixelInRow = mod(floor(gl_FragCoord.y), scale);
      float isGap = step(scale - 0.5, pixelInRow + 0.5);
      scanFactor = isGap * u_scanlines;
      col *= 1.0 - scanFactor;
    }

    // -- Dot mask --
    float dotmaskFactor = 0.0;
    if (u_dotmask == 1) {
      // Shadow mask: staggered RGB triads
      float row = floor(gl_FragCoord.y);
      float col_x = floor(gl_FragCoord.x) + mod(row, 2.0) * 1.5;
      float stripe = mod(col_x, 3.0);
      vec3 mask = vec3(0.82);
      mask.r += 0.18 * step(stripe, 0.5);
      mask.g += 0.18 * step(0.5, stripe) * step(stripe, 1.5);
      mask.b += 0.18 * step(1.5, stripe);
      col *= mask;
      dotmaskFactor = 0.18;
    } else if (u_dotmask == 2) {
      // Trinitron: vertical RGB phosphor stripes
      float stripe = mod(floor(gl_FragCoord.x), 3.0);
      vec3 mask = vec3(0.82);
      mask.r += 0.18 * step(stripe, 0.5);
      mask.g += 0.18 * step(0.5, stripe) * step(stripe, 1.5);
      mask.b += 0.18 * step(1.5, stripe);
      col *= mask;
      dotmaskFactor = 0.18;
    }

    // -- Brightness compensation --
    if (dotmaskFactor > 0.0 || scanFactor > 0.0) {
      col *= 1.0 + (dotmaskFactor + scanFactor) * 1.5;
    }

    // -- Vignette (scales with curvature) --
    if (u_curvature > 0.0) {
      vec2 vig = uv - 0.5;
      col *= 1.0 - dot(vig, vig) * u_curvature * 8.75;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class Display {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  width: number;
  height: number;

  private program: WebGLProgram;
  private scale = 2;
  private buffer: WebGLBuffer;
  private glDirty = true;

  // Effect parameters
  private smoothing = 0;
  private curvature = 0;
  private scanlines = 0;
  private dotmask = 0;

  // Cached uniform locations
  private uResolution: WebGLUniformLocation | null = null;
  private uTexSize: WebGLUniformLocation | null = null;
  private uSmoothing: WebGLUniformLocation | null = null;
  private uCurvature: WebGLUniformLocation | null = null;
  private uScanlines: WebGLUniformLocation | null = null;
  private uDotmask: WebGLUniformLocation | null = null;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Build fullscreen quad buffer
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

    // Compile shader program
    this.program = this.buildProgram(VERT_SRC, FRAG_DISPLAY);
    gl.useProgram(this.program);
    this.bindAttributes(this.program);

    // Cache uniform locations
    this.uResolution = gl.getUniformLocation(this.program, 'u_resolution');
    this.uTexSize = gl.getUniformLocation(this.program, 'u_texSize');
    this.uSmoothing = gl.getUniformLocation(this.program, 'u_smoothing');
    this.uCurvature = gl.getUniformLocation(this.program, 'u_curvature');
    this.uScanlines = gl.getUniformLocation(this.program, 'u_scanlines');
    this.uDotmask = gl.getUniformLocation(this.program, 'u_dotmask');

    // Create texture with nearest-neighbor filtering
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Allocate initial texture
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    // Apply default 2x scale
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

  private bindAttributes(program: WebGLProgram): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);

    const aUV = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
  }

  /** Re-establish full GL pipeline state. Called on next updateTexture. */
  private restoreState(): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    this.bindAttributes(this.program);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    // Set all uniforms from cached values
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uTexSize, this.width, this.height);
    gl.uniform1f(this.uSmoothing, this.smoothing);
    gl.uniform1f(this.uCurvature, this.curvature);
    gl.uniform1f(this.uScanlines, this.scanlines);
    gl.uniform1i(this.uDotmask, this.dotmask);

    this.glDirty = false;
  }

  private applyScale(): void {
    const w = this.width * this.scale;
    const h = this.height * this.scale;

    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

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

  setDotmask(v: 0 | 1 | 2): void {
    this.dotmask = v;
    this.glDirty = true;
  }

  /**
   * Upload pixel buffer and draw.
   */
  updateTexture(pixels: Uint8Array): void {
    const gl = this.gl;
    if (this.glDirty) this.restoreState();
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
