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

// Shared preamble for all upscale shaders
const UPSCALE_HEAD = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_texSize;
  uniform float u_smoothing;
`;

// Helper: sample a texel by integer pixel coordinate
const TEX_FETCH = `
  vec4 T(vec2 p) { return texture2D(u_tex, (floor(p) + 0.5) / u_texSize); }
`;

// Helper: luminance for color distance comparisons (xBR, Scale3x)
const LUMINANCE = `
  float luma(vec4 c) { return dot(c.rgb, vec3(0.299, 0.587, 0.114)); }
`;

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

// ── Shared helpers for HQ / Scale / xBR shaders ──

// YUV-weighted color distance — matches the original HQ2x algorithm's
// perceptual color comparison.  The weights emphasise luma differences
// and de-emphasise chroma, so edges are detected on brightness boundaries
// rather than hue boundaries.
const HQ_COMMON = TEX_FETCH + `
  float cdist(vec4 a, vec4 b) {
    vec3 d = a.rgb - b.rgb;
    float y = dot(d, vec3( 0.299,  0.587,  0.114));
    float u = dot(d, vec3(-0.169, -0.331,  0.500));
    float v = dot(d, vec3( 0.500, -0.419, -0.081));
    return y*y*48.0 + u*u*7.0 + v*v*6.0;
  }
  bool diff(vec4 a, vec4 b) { return cdist(a, b) > 0.6; }
`;

// ── HQx LUT-based shaders (Maxim Stepin / Cameron Zemek / Jules Blok) ──
//
// All HQx shaders share the same structure:
//   1. Determine quadrant → select 4 candidate pixels (center, diagonal, horiz, vert)
//   2. Convert 9 neighbors to YUV, build 8-bit diff pattern + 4-bit cross pattern
//   3. Compute sub-pixel index within the NxN output block
//   4. Look up RGBA blend weights from a pre-computed LUT texture
//   5. Normalize weights and blend the 4 candidate pixels
//
// Only the sub-pixel grid size (N) and LUT dimensions differ between 2x/3x/4x.

const HQX_LUT_COMMON = `
  uniform sampler2D u_lut;

  const vec3 yuv_threshold = vec3(48.0/255.0, 7.0/255.0, 6.0/255.0);

  vec3 toYUV(vec3 c) {
    return vec3(
      dot(c, vec3( 0.299,  0.587,  0.114)),
      dot(c, vec3(-0.169, -0.331,  0.500)),
      dot(c, vec3( 0.500, -0.419, -0.081))
    );
  }

  bool hqdiff(vec3 yuv1, vec3 yuv2) {
    vec3 d = abs(yuv1 - yuv2);
    return d.x > yuv_threshold.x || d.y > yuv_threshold.y || d.z > yuv_threshold.z;
  }

  vec4 T(vec2 p) { return texture2D(u_tex, (floor(p) + 0.5) / u_texSize); }
`;

// 1: HQ2x — LUT-based reference implementation (256×64 LUT)
const FRAG_HQ2X = UPSCALE_HEAD + HQX_LUT_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 fp = fract(pos);
    vec2 ip = floor(pos);

    vec2 quad = sign(-0.5 + fp);

    vec4 p1 = T(ip);
    vec4 p2 = T(ip + quad);
    vec4 p3 = T(ip + vec2(quad.x, 0.0));
    vec4 p4 = T(ip + vec2(0.0, quad.y));

    vec3 w1 = toYUV(T(ip + vec2(-1,-1)).rgb);
    vec3 w2 = toYUV(T(ip + vec2( 0,-1)).rgb);
    vec3 w3 = toYUV(T(ip + vec2( 1,-1)).rgb);
    vec3 w4 = toYUV(T(ip + vec2(-1, 0)).rgb);
    vec3 w5 = toYUV(p1.rgb);
    vec3 w6 = toYUV(T(ip + vec2( 1, 0)).rgb);
    vec3 w7 = toYUV(T(ip + vec2(-1, 1)).rgb);
    vec3 w8 = toYUV(T(ip + vec2( 0, 1)).rgb);
    vec3 w9 = toYUV(T(ip + vec2( 1, 1)).rgb);

    float pattern =
      (hqdiff(w5, w1) ? 1.0 : 0.0) +
      (hqdiff(w5, w2) ? 2.0 : 0.0) +
      (hqdiff(w5, w3) ? 4.0 : 0.0) +
      (hqdiff(w5, w4) ? 8.0 : 0.0) +
      (hqdiff(w5, w6) ? 16.0 : 0.0) +
      (hqdiff(w5, w7) ? 32.0 : 0.0) +
      (hqdiff(w5, w8) ? 64.0 : 0.0) +
      (hqdiff(w5, w9) ? 128.0 : 0.0);

    float cross =
      (hqdiff(w4, w2) ? 1.0 : 0.0) +
      (hqdiff(w2, w6) ? 2.0 : 0.0) +
      (hqdiff(w8, w4) ? 4.0 : 0.0) +
      (hqdiff(w6, w8) ? 8.0 : 0.0);

    // 2x2 sub-pixel grid: 4 positions
    vec2 spf = floor(fp * 2.0);
    float subpixel = spf.x + spf.y * 2.0;

    vec2 index = vec2(pattern, cross * 4.0 + subpixel);
    vec4 weights = texture2D(u_lut, (index + 0.5) * vec2(1.0/256.0, 1.0/64.0));

    float sum = dot(weights, vec4(1.0));
    weights /= sum;

    gl_FragColor = vec4(
      weights.x * p1.rgb + weights.y * p2.rgb +
      weights.z * p3.rgb + weights.w * p4.rgb, 1.0);
  }
`;

// 2: HQ3x — LUT-based reference implementation (256×144 LUT)
const FRAG_HQ3X = UPSCALE_HEAD + HQX_LUT_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 fp = fract(pos);
    vec2 ip = floor(pos);

    vec2 quad = sign(-0.5 + fp);

    vec4 p1 = T(ip);
    vec4 p2 = T(ip + quad);
    vec4 p3 = T(ip + vec2(quad.x, 0.0));
    vec4 p4 = T(ip + vec2(0.0, quad.y));

    vec3 w1 = toYUV(T(ip + vec2(-1,-1)).rgb);
    vec3 w2 = toYUV(T(ip + vec2( 0,-1)).rgb);
    vec3 w3 = toYUV(T(ip + vec2( 1,-1)).rgb);
    vec3 w4 = toYUV(T(ip + vec2(-1, 0)).rgb);
    vec3 w5 = toYUV(p1.rgb);
    vec3 w6 = toYUV(T(ip + vec2( 1, 0)).rgb);
    vec3 w7 = toYUV(T(ip + vec2(-1, 1)).rgb);
    vec3 w8 = toYUV(T(ip + vec2( 0, 1)).rgb);
    vec3 w9 = toYUV(T(ip + vec2( 1, 1)).rgb);

    float pattern =
      (hqdiff(w5, w1) ? 1.0 : 0.0) +
      (hqdiff(w5, w2) ? 2.0 : 0.0) +
      (hqdiff(w5, w3) ? 4.0 : 0.0) +
      (hqdiff(w5, w4) ? 8.0 : 0.0) +
      (hqdiff(w5, w6) ? 16.0 : 0.0) +
      (hqdiff(w5, w7) ? 32.0 : 0.0) +
      (hqdiff(w5, w8) ? 64.0 : 0.0) +
      (hqdiff(w5, w9) ? 128.0 : 0.0);

    float cross =
      (hqdiff(w4, w2) ? 1.0 : 0.0) +
      (hqdiff(w2, w6) ? 2.0 : 0.0) +
      (hqdiff(w8, w4) ? 4.0 : 0.0) +
      (hqdiff(w6, w8) ? 8.0 : 0.0);

    // 3x3 sub-pixel grid: 9 positions
    vec2 spf = floor(fp * 3.0);
    float subpixel = spf.x + spf.y * 3.0;

    vec2 index = vec2(pattern, cross * 9.0 + subpixel);
    vec4 weights = texture2D(u_lut, (index + 0.5) * vec2(1.0/256.0, 1.0/144.0));

    float sum = dot(weights, vec4(1.0));
    weights /= sum;

    gl_FragColor = vec4(
      weights.x * p1.rgb + weights.y * p2.rgb +
      weights.z * p3.rgb + weights.w * p4.rgb, 1.0);
  }
`;

// 3: Scale3x — edge-preserving 3x upscaler (hard selection, no blending).
// The user's favourite — clean, crisp edges with no anti-aliasing.
const FRAG_SCALE3X = UPSCALE_HEAD + HQ_COMMON + LUMINANCE + `
  bool eq(vec4 a, vec4 b) { return !diff(a, b); }
  bool ne(vec4 a, vec4 b) { return diff(a, b); }

  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    vec4 A = T(i + vec2(-1,-1));
    vec4 B = T(i + vec2( 0,-1));
    vec4 C = T(i + vec2( 1,-1));
    vec4 D = T(i + vec2(-1, 0));
    vec4 E = T(i);
    vec4 F = T(i + vec2( 1, 0));
    vec4 G = T(i + vec2(-1, 1));
    vec4 H = T(i + vec2( 0, 1));
    vec4 I = T(i + vec2( 1, 1));

    vec4 e0 = E, e1 = E, e2 = E;
    vec4 e3 = E, e4 = E, e5 = E;
    vec4 e6 = E, e7 = E, e8 = E;

    if (ne(D,F) && ne(B,H)) {
      if (eq(D,B)) e0 = D;
      if ((eq(D,B) && ne(E,C)) || (eq(B,F) && ne(E,A))) e1 = B;
      if (eq(B,F)) e2 = F;
      if ((eq(D,B) && ne(E,G)) || (eq(D,H) && ne(E,A))) e3 = D;
      if ((eq(B,F) && ne(E,I)) || (eq(H,F) && ne(E,C))) e5 = F;
      if (eq(D,H)) e6 = D;
      if ((eq(D,H) && ne(E,I)) || (eq(H,F) && ne(E,G))) e7 = H;
      if (eq(H,F)) e8 = F;
    }

    int sx = int(f.x * 3.0);
    int sy = int(f.y * 3.0);
    if (sx > 2) sx = 2;
    if (sy > 2) sy = 2;

    vec4 result = e4;
    if      (sy == 0 && sx == 0) result = e0;
    else if (sy == 0 && sx == 1) result = e1;
    else if (sy == 0 && sx == 2) result = e2;
    else if (sy == 1 && sx == 0) result = e3;
    else if (sy == 1 && sx == 1) result = e4;
    else if (sy == 1 && sx == 2) result = e5;
    else if (sy == 2 && sx == 0) result = e6;
    else if (sy == 2 && sx == 1) result = e7;
    else if (sy == 2 && sx == 2) result = e8;

    gl_FragColor = result;
  }
`;

// 4: HQ4x — LUT-based reference implementation (256×256 LUT)
const FRAG_HQ4X = UPSCALE_HEAD + HQX_LUT_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 fp = fract(pos);
    vec2 ip = floor(pos);

    vec2 quad = sign(-0.5 + fp);

    vec4 p1 = T(ip);
    vec4 p2 = T(ip + quad);
    vec4 p3 = T(ip + vec2(quad.x, 0.0));
    vec4 p4 = T(ip + vec2(0.0, quad.y));

    vec3 w1 = toYUV(T(ip + vec2(-1,-1)).rgb);
    vec3 w2 = toYUV(T(ip + vec2( 0,-1)).rgb);
    vec3 w3 = toYUV(T(ip + vec2( 1,-1)).rgb);
    vec3 w4 = toYUV(T(ip + vec2(-1, 0)).rgb);
    vec3 w5 = toYUV(p1.rgb);
    vec3 w6 = toYUV(T(ip + vec2( 1, 0)).rgb);
    vec3 w7 = toYUV(T(ip + vec2(-1, 1)).rgb);
    vec3 w8 = toYUV(T(ip + vec2( 0, 1)).rgb);
    vec3 w9 = toYUV(T(ip + vec2( 1, 1)).rgb);

    float pattern =
      (hqdiff(w5, w1) ? 1.0 : 0.0) +
      (hqdiff(w5, w2) ? 2.0 : 0.0) +
      (hqdiff(w5, w3) ? 4.0 : 0.0) +
      (hqdiff(w5, w4) ? 8.0 : 0.0) +
      (hqdiff(w5, w6) ? 16.0 : 0.0) +
      (hqdiff(w5, w7) ? 32.0 : 0.0) +
      (hqdiff(w5, w8) ? 64.0 : 0.0) +
      (hqdiff(w5, w9) ? 128.0 : 0.0);

    float cross =
      (hqdiff(w4, w2) ? 1.0 : 0.0) +
      (hqdiff(w2, w6) ? 2.0 : 0.0) +
      (hqdiff(w8, w4) ? 4.0 : 0.0) +
      (hqdiff(w6, w8) ? 8.0 : 0.0);

    // 4x4 sub-pixel grid: 16 positions
    vec2 spf = floor(fp * 4.0);
    float subpixel = spf.x + spf.y * 4.0;

    vec2 index = vec2(pattern, cross * 16.0 + subpixel);
    vec4 weights = texture2D(u_lut, (index + 0.5) * vec2(1.0/256.0, 1.0/256.0));

    float sum = dot(weights, vec4(1.0));
    weights /= sum;

    gl_FragColor = vec4(
      weights.x * p1.rgb + weights.y * p2.rgb +
      weights.z * p3.rgb + weights.w * p4.rgb, 1.0);
  }
`;

// 5: xBR — edge-directed interpolation with smooth blending.
// Detects whether a diagonal edge (\  or /) passes through each pixel
// by comparing the similarity of neighbor pairs along each direction.
// Sub-pixels on the "other side" of the edge get blended toward the
// neighbors on that side, producing smooth anti-aliased diagonals.
const FRAG_XBR = UPSCALE_HEAD + HQ_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    //   A B C
    //   D E F
    //   G H I
    vec4 A = T(i + vec2(-1,-1));
    vec4 B = T(i + vec2( 0,-1));
    vec4 C = T(i + vec2( 1,-1));
    vec4 D = T(i + vec2(-1, 0));
    vec4 E = T(i);
    vec4 F = T(i + vec2( 1, 0));
    vec4 G = T(i + vec2(-1, 1));
    vec4 H = T(i + vec2( 0, 1));
    vec4 I = T(i + vec2( 1, 1));

    // Edge direction detection via neighbor-pair similarity.
    //
    //   \  edge (NW-SE): separates {A,D,B} from {F,H,I}
    //      Evidence: D≈B (same side) and F≈H (same side) → d_bs is LOW
    //
    //   /  edge (NE-SW): separates {C,B,F} from {D,G,H}
    //      Evidence: B≈F (same side) and D≈H (same side) → d_fs is LOW
    //
    // Diagonal neighbors reinforce: A near D/B, I near F/H for \, etc.

    float d_bs = cdist(D,B) + cdist(F,H)
               + 0.5 * (cdist(A,D) + cdist(A,B) + cdist(I,F) + cdist(I,H));
    float d_fs = cdist(B,F) + cdist(D,H)
               + 0.5 * (cdist(C,B) + cdist(C,F) + cdist(G,D) + cdist(G,H));

    vec4 result = E;
    float total = d_bs + d_fs;

    if (total > 0.01) {
      // Edge strengths: 0 = no edge, approaches 1 = strong edge
      float bs = max(0.0, (d_fs - d_bs) / total);   // \  edge strength
      float fs = max(0.0, (d_bs - d_fs) / total);   // /  edge strength

      if (f.y < 0.5) {
        if (f.x < 0.5) {
          // TL sub-pixel: on \  edge, blend toward D/B (they're on this side)
          if (bs > 0.0) result = mix(E, mix(D, B, 0.5), bs * 0.75);
        } else {
          // TR sub-pixel: on /  edge, blend toward B/F
          if (fs > 0.0) result = mix(E, mix(B, F, 0.5), fs * 0.75);
        }
      } else {
        if (f.x < 0.5) {
          // BL sub-pixel: on /  edge, blend toward D/H
          if (fs > 0.0) result = mix(E, mix(D, H, 0.5), fs * 0.75);
        } else {
          // BR sub-pixel: on \  edge, blend toward F/H
          if (bs > 0.0) result = mix(E, mix(F, H, 0.5), bs * 0.75);
        }
      }
    }

    gl_FragColor = result;
  }
`;

// 6: AdvMAME2x — MAME's variant of Scale2x (EPX) with clean edge
// preservation.  Each source pixel maps to a 2x2 block.  If two
// adjacent cardinal neighbors match and the other two differ, the
// corner between the matching pair takes their color.  Otherwise
// all four sub-pixels keep the source color.  Clean, no blending.
const FRAG_ADVMAME2X = UPSCALE_HEAD + HQ_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    vec4 B = T(i + vec2( 0,-1));
    vec4 D = T(i + vec2(-1, 0));
    vec4 E = T(i);
    vec4 F = T(i + vec2( 1, 0));
    vec4 H = T(i + vec2( 0, 1));

    vec4 p0 = E, p1 = E, p2 = E, p3 = E;
    if (!diff(D,B) && diff(D,H) && diff(B,F)) p0 = D;
    if (!diff(B,F) && diff(B,D) && diff(F,H)) p1 = F;
    if (!diff(D,H) && diff(D,B) && diff(H,F)) p2 = D;
    if (!diff(H,F) && diff(H,D) && diff(F,B)) p3 = F;

    vec4 top = mix(p0, p1, step(0.5, f.x));
    vec4 bot = mix(p2, p3, step(0.5, f.x));
    gl_FragColor = mix(top, bot, step(0.5, f.y));
  }
`;

// 7: 2xSaI — Kreed's 2x Scale and Interpolation.
// Analyses a 4x4 neighborhood to detect edges and applies bilinear-style
// interpolation along detected edges while keeping flat areas sharp.
// The key difference from EPX: 2xSaI BLENDS colors rather than hard-selecting,
// producing characteristically smooth gradients at diagonal edges.
const FRAG_2XSAI = UPSCALE_HEAD + HQ_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    //  Extended neighborhood for 2xSaI:
    //     I  E0  E1
    //     N   A   B  K
    //     O   D   C  L
    //        M   F
    // We map: A=center, B=right, C=below-right, D=below
    // Standard naming: I=(-1,-1), E0=(0,-1), E1=(1,-1)
    //                  N=(-1,0), A=(0,0), B=(1,0), K=(2,0)
    //                  O=(-1,1), D=(0,1), C=(1,1), L=(2,1)
    //                  M=(0,2), F=(1,2)

    vec4 II = T(i + vec2(-1,-1));
    vec4 E0 = T(i + vec2( 0,-1));
    vec4 E1 = T(i + vec2( 1,-1));
    vec4 N  = T(i + vec2(-1, 0));
    vec4 A  = T(i);
    vec4 B  = T(i + vec2( 1, 0));
    vec4 K  = T(i + vec2( 2, 0));
    vec4 O  = T(i + vec2(-1, 1));
    vec4 D  = T(i + vec2( 0, 1));
    vec4 C  = T(i + vec2( 1, 1));
    vec4 L  = T(i + vec2( 2, 1));
    vec4 M  = T(i + vec2( 0, 2));
    vec4 F  = T(i + vec2( 1, 2));

    // The 2xSaI algorithm produces 4 output pixels per source pixel.
    // product2a = top-right, product1a = bottom-left,
    // product2b = top-left,  product1b = bottom-right

    vec4 p2a, p1a, p2b, p1b;

    // Top-left: always the source pixel
    p2b = A;

    // Top-right
    if (!diff(A,B) && diff(A,C)) {
      p2a = A;
    } else if (diff(A,B) && !diff(A,D)) {
      p2a = A;
    } else if (!diff(A,B) && !diff(A,D)) {
      p2a = A;
    } else if (!diff(B,E0) && !diff(D,O)) {
      p2a = A;
    } else {
      p2a = mix(A, B, 0.5);
    }

    // Bottom-left
    if (!diff(A,D) && diff(A,B)) {
      p1a = A;
    } else if (diff(A,D) && !diff(A,B)) {
      p1a = A;
    } else if (!diff(A,D) && !diff(A,B)) {
      p1a = A;
    } else if (!diff(D,N) && !diff(B,L)) {
      p1a = A;
    } else {
      p1a = mix(A, D, 0.5);
    }

    // Bottom-right (the most complex — determines diagonal blend)
    if (!diff(A,C) && diff(B,C) && diff(D,C)) {
      // A matches diagonal C but its neighbors don't — extend A into corner
      p1b = A;
    } else if (!diff(B,C) && !diff(D,C)) {
      // Both B and D match C — use diagonal color
      p1b = C;
    } else if (!diff(B,C) && diff(D,C)) {
      // B matches C — blend along horizontal
      p1b = mix(A, B, 0.5);
    } else if (diff(B,C) && !diff(D,C)) {
      // D matches C — blend along vertical
      p1b = mix(A, D, 0.5);
    } else {
      // No clear edge — average all four
      p1b = mix(mix(A, B, 0.5), mix(D, C, 0.5), 0.5);
    }

    // Select sub-pixel
    vec4 top = mix(p2b, p2a, step(0.5, f.x));
    vec4 bot = mix(p1a, p1b, step(0.5, f.x));
    gl_FragColor = mix(top, bot, step(0.5, f.y));
  }
`;

// 8: SAA5050 Diagonal Smoothing — the teletext character rounding algorithm.
//
// The SAA5050 chip doubled each pixel 2x and applied diagonal smoothing using
// these Boolean rules (from the datasheet):
//
//   Input:  A B C     Output:  1 2
//           D E F              3 4
//           G H I
//
//   1 = E | (A & B & !E & !D)   — fill top-left if A-B diagonal bridges gap
//   2 = E | (B & C & !E & !F)   — fill top-right if B-C diagonal
//   3 = E | (D & B & !A & !E)   — wait, original is row-based...
//
// The original operates on monochrome scan lines.  For color pixel art we
// adapt the concept: for each sub-pixel corner of E's 2×2 block, check if
// the diagonal neighbor matches E while the two bridging cardinal neighbors
// differ.  If so, E's corner should show a "half dot" blend toward the
// diagonal — exactly the gap-filling the SAA5050 performed.
//
// We also check the reverse: if the two cardinal neighbors match EACH OTHER
// but differ from E and from the diagonal, they form an anti-diagonal bridge
// that should be smoothed.
const FRAG_SAA5050 = UPSCALE_HEAD + HQ_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    //   A B C
    //   D E F
    //   G H I
    vec4 A = T(i + vec2(-1,-1));
    vec4 B = T(i + vec2( 0,-1));
    vec4 C = T(i + vec2( 1,-1));
    vec4 D = T(i + vec2(-1, 0));
    vec4 E = T(i);
    vec4 F = T(i + vec2( 1, 0));
    vec4 G = T(i + vec2(-1, 1));
    vec4 H = T(i + vec2( 0, 1));
    vec4 I = T(i + vec2( 1, 1));

    vec4 result = E;

    if (f.y < 0.5) {
      if (f.x < 0.5) {
        // TL sub-pixel: diagonal A, bridge pixels B and D
        // SAA5050 rule: fill if A≈E and the bridge (B,D) differs from both
        if (!diff(A,E) && diff(B,E) && diff(D,E))
          result = mix(E, A, 0.5);
        // Reverse: B≈D form anti-diagonal bridge, E and A both differ
        else if (!diff(B,D) && diff(B,E) && diff(B,A))
          result = mix(E, B, 0.5);
      } else {
        // TR sub-pixel: diagonal C, bridge pixels B and F
        if (!diff(C,E) && diff(B,E) && diff(F,E))
          result = mix(E, C, 0.5);
        else if (!diff(B,F) && diff(B,E) && diff(B,C))
          result = mix(E, B, 0.5);
      }
    } else {
      if (f.x < 0.5) {
        // BL sub-pixel: diagonal G, bridge pixels D and H
        if (!diff(G,E) && diff(D,E) && diff(H,E))
          result = mix(E, G, 0.5);
        else if (!diff(D,H) && diff(D,E) && diff(D,G))
          result = mix(E, D, 0.5);
      } else {
        // BR sub-pixel: diagonal I, bridge pixels F and H
        if (!diff(I,E) && diff(F,E) && diff(H,E))
          result = mix(E, I, 0.5);
        else if (!diff(F,H) && diff(F,E) && diff(F,I))
          result = mix(E, F, 0.5);
      }
    }

    gl_FragColor = result;
  }
`;

// 9: ScaleFX — Sp00kyFox's edge-interpolation algorithm.
// A modern single-pass approximation of the multi-pass ScaleFX shader.
// Uses a 3x3 neighborhood to detect edge orientation and applies smooth
// sub-pixel blending with 3x3 output granularity.  Produces very clean
// results — sharper than HQ but with smoother diagonals than Scale3x.
const FRAG_SCALEFX = UPSCALE_HEAD + HQ_COMMON + LUMINANCE + `
  // Weighted color distance using both luma and chroma
  float wd(vec4 a, vec4 b) {
    return cdist(a, b);
  }

  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 i = floor(pos);
    vec2 f = fract(pos);

    //   A B C
    //   D E F
    //   G H I
    vec4 A = T(i + vec2(-1,-1));
    vec4 B = T(i + vec2( 0,-1));
    vec4 C = T(i + vec2( 1,-1));
    vec4 D = T(i + vec2(-1, 0));
    vec4 E = T(i);
    vec4 F = T(i + vec2( 1, 0));
    vec4 G = T(i + vec2(-1, 1));
    vec4 H = T(i + vec2( 0, 1));
    vec4 I = T(i + vec2( 1, 1));

    // 3x3 output grid per source pixel
    int sx = int(f.x * 3.0);
    int sy = int(f.y * 3.0);
    if (sx > 2) sx = 2;
    if (sy > 2) sy = 2;

    // Center sub-pixel is always E
    vec4 result = E;

    // Edge detection: compare diagonal metrics
    float d_bs = wd(D,B) + wd(F,H);   // \  evidence
    float d_fs = wd(B,F) + wd(D,H);   // /  evidence
    float total = d_bs + d_fs;

    if (total > 0.01) {
      float bs = max(0.0, d_fs - d_bs) / total;  // \  strength
      float fs = max(0.0, d_bs - d_fs) / total;  // /  strength

      // Corner sub-pixels: strong blend
      if (sy == 0 && sx == 0) {
        // TL corner
        float s = max(bs, fs);
        if (bs > fs && !diff(D,B)) result = mix(E, mix(D,B,0.5), s * 0.8);
        else if (fs > bs && !diff(B,F) && !diff(D,H))
          result = mix(E, A, diff(E,A) ? s * 0.4 : 0.0);
      } else if (sy == 0 && sx == 2) {
        // TR corner
        float s = max(bs, fs);
        if (fs > bs && !diff(B,F)) result = mix(E, mix(B,F,0.5), s * 0.8);
        else if (bs > fs && !diff(D,B) && !diff(H,F))
          result = mix(E, C, diff(E,C) ? s * 0.4 : 0.0);
      } else if (sy == 2 && sx == 0) {
        // BL corner
        float s = max(bs, fs);
        if (fs > bs && !diff(D,H)) result = mix(E, mix(D,H,0.5), s * 0.8);
        else if (bs > fs && !diff(D,B) && !diff(H,F))
          result = mix(E, G, diff(E,G) ? s * 0.4 : 0.0);
      } else if (sy == 2 && sx == 2) {
        // BR corner
        float s = max(bs, fs);
        if (bs > fs && !diff(H,F)) result = mix(E, mix(H,F,0.5), s * 0.8);
        else if (fs > bs && !diff(D,H) && !diff(B,F))
          result = mix(E, I, diff(E,I) ? s * 0.4 : 0.0);
      }

      // Cardinal sub-pixels: mild blend for edge AA
      else if (sy == 0 && sx == 1) {
        // Top: blend toward B if there's a horizontal edge
        if (diff(E,B) && (!diff(D,B) || !diff(B,F)))
          result = mix(E, B, 0.25 * max(bs, fs));
      } else if (sy == 2 && sx == 1) {
        if (diff(E,H) && (!diff(D,H) || !diff(H,F)))
          result = mix(E, H, 0.25 * max(bs, fs));
      } else if (sy == 1 && sx == 0) {
        if (diff(E,D) && (!diff(D,B) || !diff(D,H)))
          result = mix(E, D, 0.25 * max(bs, fs));
      } else if (sy == 1 && sx == 2) {
        if (diff(E,F) && (!diff(B,F) || !diff(H,F)))
          result = mix(E, F, 0.25 * max(bs, fs));
      }
    }

    gl_FragColor = result;
  }
`;

// Array of all upscale fragment shaders, indexed by scaling mode
const UPSCALE_SHADERS = [
  FRAG_UPSCALE,    // 0: Nearest / Bilinear
  FRAG_HQ2X,       // 1: HQ2x
  FRAG_HQ3X,       // 2: HQ3x
  FRAG_SCALE3X,    // 3: Scale3x
  FRAG_HQ4X,       // 4: HQ4x
  FRAG_XBR,        // 5: xBR
  FRAG_ADVMAME2X,  // 6: AdvMAME2x
  FRAG_2XSAI,      // 7: 2xSaI
  FRAG_SAA5050,     // 8: SAA5050
  FRAG_SCALEFX,     // 9: ScaleFX
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
        float sc = floor(u_resolution.y / u_texSize.y + 0.5);
        float gapX = step(sc - 1.0, mod(fpx, sc));
        float gapY = step(sc - 1.0, mod(fpy, sc));
        float grid = max(gapX, gapY);
        col *= 1.0 - grid * 0.55;
      } else if (u_maskType == 5) {
        // Attr mask: LCD pixel grid + checkerboard tint on 8x8 attribute cells
        float sc = floor(u_resolution.y / u_texSize.y + 0.5);
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
    lutMap[4] = hq4xLutUrl;   // HQ4x

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
      gl.uniform1f(this.u2Noise, this.noise);
    }
    // Frame counter must update every frame for noise variation
    if (this.noise > 0) {
      gl.uniform1f(this.u2Frame, this.frameCount);
    }
    this.frameCount = (this.frameCount + 1) & 0x7FFFFFFF;
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.glDirty = false;
  }
}
