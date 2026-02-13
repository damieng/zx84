/**
 * WebGL display renderer.
 * Renders a pixel buffer as a textured fullscreen quad with nearest-neighbor filtering.
 * Supports integer scaling (1x/2x/3x) and an optional CRT shader effect.
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

const FRAG_SIMPLE = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  void main() {
    gl_FragColor = texture2D(u_tex, v_uv);
  }
`;

const FRAG_CRT = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_resolution;
  uniform vec2 u_texSize;

  vec2 barrel(vec2 uv) {
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    return uv + c * r2 * 0.04;
  }

  void main() {
    vec2 uv = barrel(v_uv);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec3 col = texture2D(u_tex, uv).rgb;

    // -- Scanlines: hard gap on last pixel row of each source-row group --
    float scale = floor(u_resolution.y / u_texSize.y + 0.5);
    float scanIntensity = clamp((scale - 1.0) * 0.3, 0.0, 0.5);
    float pixelInRow = mod(floor(gl_FragCoord.y), scale);
    float isGap = step(scale - 0.5, pixelInRow + 0.5);
    col *= 1.0 - isGap * scanIntensity;

    // -- Aperture grille: vertical RGB phosphor stripes --
    float stripe = mod(floor(gl_FragCoord.x), 3.0);
    vec3 mask = vec3(0.82);
    mask.r += 0.18 * step(stripe, 0.5);
    mask.g += 0.18 * step(0.5, stripe) * step(stripe, 1.5);
    mask.b += 0.18 * step(1.5, stripe);
    col *= mask;

    // -- Brightness boost (compensate for mask + scanline darkening) --
    col *= 1.3;

    // -- Vignette --
    vec2 vig = uv - 0.5;
    col *= 1.0 - dot(vig, vig) * 0.35;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class Display {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  texture: WebGLTexture;
  width: number;
  height: number;

  private simpleProgram: WebGLProgram;
  private crtProgram: WebGLProgram;
  private activeProgram: WebGLProgram;
  private scale = 2;
  private buffer: WebGLBuffer;
  private glDirty = true;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Build fullscreen quad buffer (shared by both programs)
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

    // Compile both shader programs
    this.simpleProgram = this.buildProgram(VERT_SRC, FRAG_SIMPLE);
    this.crtProgram = this.buildProgram(VERT_SRC, FRAG_CRT);
    this.activeProgram = this.simpleProgram;

    gl.useProgram(this.activeProgram);
    this.bindAttributes(this.activeProgram);

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
    gl.useProgram(this.activeProgram);
    this.bindAttributes(this.activeProgram);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const uRes = gl.getUniformLocation(this.activeProgram, 'u_resolution');
    if (uRes) gl.uniform2f(uRes, this.canvas.width, this.canvas.height);
    const uTex = gl.getUniformLocation(this.activeProgram, 'u_texSize');
    if (uTex) gl.uniform2f(uTex, this.width, this.height);

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

  setCRT(enabled: boolean): void {
    this.activeProgram = enabled ? this.crtProgram : this.simpleProgram;
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
