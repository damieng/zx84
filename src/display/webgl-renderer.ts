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

// ── xBR shaders — Hyllian's xBR algorithm ──
//
// Ported from gizmo98/common-shaders (Hyllian, MIT license).
// Uses a 5×5 (21-pixel) neighborhood.  All 4 corners are processed
// simultaneously via vec4 swizzle rotations.
//
// The weighted luma values for the cardinal, diagonal, and extended
// neighbors are packed into vec4s where each component represents one
// of the 4 rotated views of the neighborhood.  Swizzle patterns
// (.yzwx, .wxyz, .zwxy) rotate the view by 90° each time.
//
//    A1 B1 C1
// A0  A  B  C C4
// D0  D  E  F F4
// G0  G  H  I I4
//    G5 H5 I5

const XBR_COMMON = `
  const float XBR_Y_WEIGHT = 48.0;
  const float XBR_EQ_THRESHOLD = 25.0;
  const float XBR_LV2_COEFFICIENT = 2.0;
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);

  vec4 T(vec2 p) { return texture2D(u_tex, (floor(p) + 0.5) / u_texSize); }

  float xdf(float a, float b) { return abs(a - b); }
  vec4 xdf4(vec4 A, vec4 B) { return abs(A - B); }
  bvec4 xeq(vec4 A, vec4 B) { return lessThan(xdf4(A, B), vec4(XBR_EQ_THRESHOLD)); }

  float c_df(vec3 c1, vec3 c2) {
    vec3 d = abs(c1 - c2);
    return d.r + d.g + d.b;
  }

  vec4 weighted_distance(vec4 a, vec4 b, vec4 c, vec4 d,
                         vec4 e, vec4 f, vec4 g, vec4 h) {
    return xdf4(a,b) + xdf4(a,c) + xdf4(d,e) + xdf4(d,f) + 4.0*xdf4(g,h);
  }
`;

// 5: xBR-lv2 — Hyllian's xBR level 2 (4-direction edge detection).
// Works at any integer scale.  Detects edges at 45°/30°/60° angles.
const FRAG_XBR_LV2 = UPSCALE_HEAD + XBR_COMMON + `
  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 fp = fract(pos);
    vec2 ip = floor(pos);

    // 5x5 neighborhood
    vec3 A1 = T(ip + vec2(-1,-2)).rgb; vec3 B1 = T(ip + vec2( 0,-2)).rgb; vec3 C1 = T(ip + vec2( 1,-2)).rgb;
    vec3 A  = T(ip + vec2(-1,-1)).rgb; vec3 B  = T(ip + vec2( 0,-1)).rgb; vec3 C  = T(ip + vec2( 1,-1)).rgb;
    vec3 D  = T(ip + vec2(-1, 0)).rgb; vec3 E  = T(ip + vec2( 0, 0)).rgb; vec3 F  = T(ip + vec2( 1, 0)).rgb;
    vec3 G  = T(ip + vec2(-1, 1)).rgb; vec3 H  = T(ip + vec2( 0, 1)).rgb; vec3 II = T(ip + vec2( 1, 1)).rgb;
    vec3 G5 = T(ip + vec2(-1, 2)).rgb; vec3 H5 = T(ip + vec2( 0, 2)).rgb; vec3 I5 = T(ip + vec2( 1, 2)).rgb;
    vec3 A0 = T(ip + vec2(-2,-1)).rgb; vec3 D0 = T(ip + vec2(-2, 0)).rgb; vec3 G0 = T(ip + vec2(-2, 1)).rgb;
    vec3 C4 = T(ip + vec2( 2,-1)).rgb; vec3 F4 = T(ip + vec2( 2, 0)).rgb; vec3 I4 = T(ip + vec2( 2, 1)).rgb;

    // Weighted luma — vec4 components = 4 rotations of the neighborhood
    vec3 Yw = XBR_Y_WEIGHT * Y;
    vec4 b = vec4(dot(B,Yw), dot(D,Yw), dot(H,Yw), dot(F,Yw));
    vec4 c = vec4(dot(C,Yw), dot(A,Yw), dot(G,Yw), dot(II,Yw));
    vec4 e = vec4(dot(E,Yw));
    vec4 d = b.yzwx;
    vec4 f = b.wxyz;
    vec4 g = c.zwxy;
    vec4 h = b.zwxy;
    vec4 i = c.wxyz;

    vec4 i4 = vec4(dot(I4,Yw), dot(C1,Yw), dot(A0,Yw), dot(G5,Yw));
    vec4 i5 = vec4(dot(I5,Yw), dot(C4,Yw), dot(A1,Yw), dot(G0,Yw));
    vec4 h5 = vec4(dot(H5,Yw), dot(F4,Yw), dot(B1,Yw), dot(D0,Yw));
    vec4 f4 = h5.yzwx;

    // Line inequations for sub-pixel position
    vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0);
    vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5);
    vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0);
    vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0);
    vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 By = vec4( 2.0,  0.5, -2.0,-0.5);
    vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5);
    vec4 Ci = vec4(0.25);

    vec4 fx      = Ao*fp.y + Bo*fp.x;
    vec4 fx_left = Ax*fp.y + Bx*fp.x;
    vec4 fx_up   = Ay*fp.y + By*fp.x;

    // Interpolation restrictions (CORNER_A mode)
    bvec4 interp_restriction_lv0 = bvec4(
      e.x != f.x && e.x != h.x,
      e.y != f.y && e.y != h.y,
      e.z != f.z && e.z != h.z,
      e.w != f.w && e.w != h.w);
    bvec4 interp_restriction_lv2_left = bvec4(
      e.x != g.x && d.x != g.x,
      e.y != g.y && d.y != g.y,
      e.z != g.z && d.z != g.z,
      e.w != g.w && d.w != g.w);
    bvec4 interp_restriction_lv2_up = bvec4(
      e.x != c.x && b.x != c.x,
      e.y != c.y && b.y != c.y,
      e.z != c.z && b.z != c.z,
      e.w != c.w && b.w != c.w);

    vec4 delta  = vec4(0.25);
    vec4 deltaL = vec4(0.125, 0.25, 0.125, 0.25);
    vec4 deltaU = deltaL.yxwz;

    vec4 fx45i = clamp((fx      + delta  - Co - Ci) / (2.0*delta ), 0.0, 1.0);
    vec4 fx45  = clamp((fx      + delta  - Co     ) / (2.0*delta ), 0.0, 1.0);
    vec4 fx30  = clamp((fx_left + deltaL - Cx     ) / (2.0*deltaL), 0.0, 1.0);
    vec4 fx60  = clamp((fx_up   + deltaU - Cy     ) / (2.0*deltaU), 0.0, 1.0);

    vec4 wd1 = weighted_distance(e, c, g, i, h5, f4, h, f);
    vec4 wd2 = weighted_distance(h, d, i5, f, i4, b, e, i);

    bvec4 edri = bvec4(
      wd1.x <= wd2.x && interp_restriction_lv0.x,
      wd1.y <= wd2.y && interp_restriction_lv0.y,
      wd1.z <= wd2.z && interp_restriction_lv0.z,
      wd1.w <= wd2.w && interp_restriction_lv0.w);

    bvec4 edr = bvec4(
      wd1.x < wd2.x && interp_restriction_lv0.x && (!edri.y || !edri.w),
      wd1.y < wd2.y && interp_restriction_lv0.y && (!edri.z || !edri.x),
      wd1.z < wd2.z && interp_restriction_lv0.z && (!edri.w || !edri.y),
      wd1.w < wd2.w && interp_restriction_lv0.w && (!edri.x || !edri.z));

    vec4 dFG = xdf4(f, g);
    vec4 dHC = xdf4(h, c);

    bvec4 edr_left = bvec4(
      XBR_LV2_COEFFICIENT*dFG.x <= dHC.x && interp_restriction_lv2_left.x && edr.x && !edri.y && xeq(e,c).x,
      XBR_LV2_COEFFICIENT*dFG.y <= dHC.y && interp_restriction_lv2_left.y && edr.y && !edri.z && xeq(e,c).y,
      XBR_LV2_COEFFICIENT*dFG.z <= dHC.z && interp_restriction_lv2_left.z && edr.z && !edri.w && xeq(e,c).z,
      XBR_LV2_COEFFICIENT*dFG.w <= dHC.w && interp_restriction_lv2_left.w && edr.w && !edri.x && xeq(e,c).w);

    bvec4 edr_up = bvec4(
      dFG.x >= XBR_LV2_COEFFICIENT*dHC.x && interp_restriction_lv2_up.x && edr.x && !edri.w && xeq(e,g).x,
      dFG.y >= XBR_LV2_COEFFICIENT*dHC.y && interp_restriction_lv2_up.y && edr.y && !edri.x && xeq(e,g).y,
      dFG.z >= XBR_LV2_COEFFICIENT*dHC.z && interp_restriction_lv2_up.z && edr.z && !edri.y && xeq(e,g).z,
      dFG.w >= XBR_LV2_COEFFICIENT*dHC.w && interp_restriction_lv2_up.w && edr.w && !edri.z && xeq(e,g).w);

    fx45i *= vec4(edri.x, edri.y, edri.z, edri.w);
    fx45  *= vec4(edr.x,  edr.y,  edr.z,  edr.w);
    fx30  *= vec4(edr_left.x, edr_left.y, edr_left.z, edr_left.w);
    fx60  *= vec4(edr_up.x,   edr_up.y,   edr_up.z,   edr_up.w);

    bvec4 px = bvec4(
      xdf(e.x,f.x) <= xdf(e.x,h.x),
      xdf(e.y,f.y) <= xdf(e.y,h.y),
      xdf(e.z,f.z) <= xdf(e.z,h.z),
      xdf(e.w,f.w) <= xdf(e.w,h.w));

    vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));

    vec3 res1 = E;
    res1 = mix(res1, px.x ? F : H, maximos.x);
    res1 = mix(res1, px.z ? D : B, maximos.z);

    vec3 res2 = E;
    res2 = mix(res2, px.y ? B : F, maximos.y);
    res2 = mix(res2, px.w ? H : D, maximos.w);

    vec3 res = mix(res1, res2, step(c_df(E, res1), c_df(E, res2)));
    gl_FragColor = vec4(res, 1.0);
  }
`;

// 6: xBR-lv3 — Hyllian's xBR level 3 (6-direction edge detection).
// Works at any integer scale.  Adds 15° and 75° angles for smoother curves.
const FRAG_XBR_LV3 = UPSCALE_HEAD + XBR_COMMON + `
  bvec4 xeq2(vec4 A, vec4 B) { return lessThan(xdf4(A, B), vec4(2.0*XBR_EQ_THRESHOLD)); }

  void main() {
    vec2 pos = v_uv * u_texSize;
    vec2 fp = fract(pos);
    vec2 ip = floor(pos);

    vec3 A1 = T(ip + vec2(-1,-2)).rgb; vec3 B1 = T(ip + vec2( 0,-2)).rgb; vec3 C1 = T(ip + vec2( 1,-2)).rgb;
    vec3 A  = T(ip + vec2(-1,-1)).rgb; vec3 B  = T(ip + vec2( 0,-1)).rgb; vec3 C  = T(ip + vec2( 1,-1)).rgb;
    vec3 D  = T(ip + vec2(-1, 0)).rgb; vec3 E  = T(ip + vec2( 0, 0)).rgb; vec3 F  = T(ip + vec2( 1, 0)).rgb;
    vec3 G  = T(ip + vec2(-1, 1)).rgb; vec3 H  = T(ip + vec2( 0, 1)).rgb; vec3 II = T(ip + vec2( 1, 1)).rgb;
    vec3 G5 = T(ip + vec2(-1, 2)).rgb; vec3 H5 = T(ip + vec2( 0, 2)).rgb; vec3 I5 = T(ip + vec2( 1, 2)).rgb;
    vec3 A0 = T(ip + vec2(-2,-1)).rgb; vec3 D0 = T(ip + vec2(-2, 0)).rgb; vec3 G0 = T(ip + vec2(-2, 1)).rgb;
    vec3 C4 = T(ip + vec2( 2,-1)).rgb; vec3 F4 = T(ip + vec2( 2, 0)).rgb; vec3 I4 = T(ip + vec2( 2, 1)).rgb;

    vec3 Yw = XBR_Y_WEIGHT * Y;
    vec4 b = vec4(dot(B,Yw), dot(D,Yw), dot(H,Yw), dot(F,Yw));
    vec4 c = vec4(dot(C,Yw), dot(A,Yw), dot(G,Yw), dot(II,Yw));
    vec4 e = vec4(dot(E,Yw));
    vec4 d = b.yzwx;
    vec4 f = b.wxyz;
    vec4 g = c.zwxy;
    vec4 h = b.zwxy;
    vec4 i = c.wxyz;

    vec4 i4 = vec4(dot(I4,Yw), dot(C1,Yw), dot(A0,Yw), dot(G5,Yw));
    vec4 i5 = vec4(dot(I5,Yw), dot(C4,Yw), dot(A1,Yw), dot(G0,Yw));
    vec4 h5 = vec4(dot(H5,Yw), dot(F4,Yw), dot(B1,Yw), dot(D0,Yw));
    vec4 f4 = h5.yzwx;

    vec4 c1 = i4.yzwx;
    vec4 g0 = i5.wxyz;
    vec4 b1 = h5.zwxy;
    vec4 d0 = h5.wxyz;

    vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0);
    vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5);
    vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0);
    vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0);
    vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0);
    vec4 By = vec4( 2.0,  0.5, -2.0,-0.5);
    vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5);
    vec4 Az = vec4( 6.0, -2.0, -6.0, 2.0);
    vec4 Bz = vec4( 2.0,  6.0, -2.0,-6.0);
    vec4 Cz = vec4( 5.0,  3.0, -3.0,-1.0);
    vec4 Aw = vec4( 2.0, -6.0, -2.0, 6.0);
    vec4 Bw = vec4( 6.0,  2.0, -6.0,-2.0);
    vec4 Cw = vec4( 5.0, -1.0, -3.0, 3.0);

    vec4 delta  = vec4(0.25);

    vec4 fx      = Ao*fp.y + Bo*fp.x;
    vec4 fx_left = Ax*fp.y + Bx*fp.x;
    vec4 fx_up   = Ay*fp.y + By*fp.x;
    vec4 fx3_left= Az*fp.y + Bz*fp.x;
    vec4 fx3_up  = Aw*fp.y + Bw*fp.x;

    // Interpolation restrictions (CORNER_C mode — default for lv3)
    bvec4 interp_restriction_lv1 = bvec4(
      (e.x!=f.x && e.x!=h.x) && (!xeq(f,b).x && !xeq(f,c).x || !xeq(h,d).x && !xeq(h,g).x || xeq(e,i).x && (!xeq(f,f4).x && !xeq(f,i4).x || !xeq(h,h5).x && !xeq(h,i5).x) || xeq(e,g).x || xeq(e,c).x),
      (e.y!=f.y && e.y!=h.y) && (!xeq(f,b).y && !xeq(f,c).y || !xeq(h,d).y && !xeq(h,g).y || xeq(e,i).y && (!xeq(f,f4).y && !xeq(f,i4).y || !xeq(h,h5).y && !xeq(h,i5).y) || xeq(e,g).y || xeq(e,c).y),
      (e.z!=f.z && e.z!=h.z) && (!xeq(f,b).z && !xeq(f,c).z || !xeq(h,d).z && !xeq(h,g).z || xeq(e,i).z && (!xeq(f,f4).z && !xeq(f,i4).z || !xeq(h,h5).z && !xeq(h,i5).z) || xeq(e,g).z || xeq(e,c).z),
      (e.w!=f.w && e.w!=h.w) && (!xeq(f,b).w && !xeq(f,c).w || !xeq(h,d).w && !xeq(h,g).w || xeq(e,i).w && (!xeq(f,f4).w && !xeq(f,i4).w || !xeq(h,h5).w && !xeq(h,i5).w) || xeq(e,g).w || xeq(e,c).w));
    bvec4 interp_restriction_lv2_left = bvec4(
      e.x!=g.x && d.x!=g.x, e.y!=g.y && d.y!=g.y, e.z!=g.z && d.z!=g.z, e.w!=g.w && d.w!=g.w);
    bvec4 interp_restriction_lv2_up = bvec4(
      e.x!=c.x && b.x!=c.x, e.y!=c.y && b.y!=c.y, e.z!=c.z && b.z!=c.z, e.w!=c.w && b.w!=c.w);
    bvec4 interp_restriction_lv3_left = bvec4(
      xeq2(g,g0).x && !xeq2(d0,g0).x, xeq2(g,g0).y && !xeq2(d0,g0).y,
      xeq2(g,g0).z && !xeq2(d0,g0).z, xeq2(g,g0).w && !xeq2(d0,g0).w);
    bvec4 interp_restriction_lv3_up = bvec4(
      xeq2(c,c1).x && !xeq2(b1,c1).x, xeq2(c,c1).y && !xeq2(b1,c1).y,
      xeq2(c,c1).z && !xeq2(b1,c1).z, xeq2(c,c1).w && !xeq2(b1,c1).w);

    vec4 fx45  = smoothstep(Co - delta, Co + delta, fx);
    vec4 fx30  = smoothstep(Cx - delta, Cx + delta, fx_left);
    vec4 fx60  = smoothstep(Cy - delta, Cy + delta, fx_up);
    vec4 fx15  = smoothstep(Cz - delta, Cz + delta, fx3_left);
    vec4 fx75  = smoothstep(Cw - delta, Cw + delta, fx3_up);

    vec4 wd1 = weighted_distance(e, c, g, i, h5, f4, h, f);
    vec4 wd2 = weighted_distance(h, d, i5, f, i4, b, e, i);

    vec4 dFG = xdf4(f, g);
    vec4 dHC = xdf4(h, c);

    bvec4 edr = bvec4(
      wd1.x < wd2.x && interp_restriction_lv1.x,
      wd1.y < wd2.y && interp_restriction_lv1.y,
      wd1.z < wd2.z && interp_restriction_lv1.z,
      wd1.w < wd2.w && interp_restriction_lv1.w);
    bvec4 edr_left = bvec4(
      XBR_LV2_COEFFICIENT*dFG.x <= dHC.x && interp_restriction_lv2_left.x,
      XBR_LV2_COEFFICIENT*dFG.y <= dHC.y && interp_restriction_lv2_left.y,
      XBR_LV2_COEFFICIENT*dFG.z <= dHC.z && interp_restriction_lv2_left.z,
      XBR_LV2_COEFFICIENT*dFG.w <= dHC.w && interp_restriction_lv2_left.w);
    bvec4 edr_up = bvec4(
      dFG.x >= XBR_LV2_COEFFICIENT*dHC.x && interp_restriction_lv2_up.x,
      dFG.y >= XBR_LV2_COEFFICIENT*dHC.y && interp_restriction_lv2_up.y,
      dFG.z >= XBR_LV2_COEFFICIENT*dHC.z && interp_restriction_lv2_up.z,
      dFG.w >= XBR_LV2_COEFFICIENT*dHC.w && interp_restriction_lv2_up.w);

    bvec4 nc45 = bvec4(edr.x && fx45.x > 0.0, edr.y && fx45.y > 0.0, edr.z && fx45.z > 0.0, edr.w && fx45.w > 0.0);
    bvec4 nc30 = bvec4(edr.x && edr_left.x && fx30.x > 0.0, edr.y && edr_left.y && fx30.y > 0.0, edr.z && edr_left.z && fx30.z > 0.0, edr.w && edr_left.w && fx30.w > 0.0);
    bvec4 nc60 = bvec4(edr.x && edr_up.x && fx60.x > 0.0, edr.y && edr_up.y && fx60.y > 0.0, edr.z && edr_up.z && fx60.z > 0.0, edr.w && edr_up.w && fx60.w > 0.0);
    bvec4 nc15 = bvec4(edr.x && edr_left.x && interp_restriction_lv3_left.x && fx15.x > 0.0, edr.y && edr_left.y && interp_restriction_lv3_left.y && fx15.y > 0.0, edr.z && edr_left.z && interp_restriction_lv3_left.z && fx15.z > 0.0, edr.w && edr_left.w && interp_restriction_lv3_left.w && fx15.w > 0.0);
    bvec4 nc75 = bvec4(edr.x && edr_up.x && interp_restriction_lv3_up.x && fx75.x > 0.0, edr.y && edr_up.y && interp_restriction_lv3_up.y && fx75.y > 0.0, edr.z && edr_up.z && interp_restriction_lv3_up.z && fx75.z > 0.0, edr.w && edr_up.w && interp_restriction_lv3_up.w && fx75.w > 0.0);

    bvec4 px = bvec4(
      xdf(e.x,f.x) <= xdf(e.x,h.x), xdf(e.y,f.y) <= xdf(e.y,h.y),
      xdf(e.z,f.z) <= xdf(e.z,h.z), xdf(e.w,f.w) <= xdf(e.w,h.w));

    bvec4 nc = bvec4(nc75.x||nc15.x||nc30.x||nc60.x||nc45.x,
                      nc75.y||nc15.y||nc30.y||nc60.y||nc45.y,
                      nc75.z||nc15.z||nc30.z||nc60.z||nc45.z,
                      nc75.w||nc15.w||nc30.w||nc60.w||nc45.w);

    vec4 final45 = vec4(nc45.x,nc45.y,nc45.z,nc45.w) * fx45;
    vec4 final30 = vec4(nc30.x,nc30.y,nc30.z,nc30.w) * fx30;
    vec4 final60 = vec4(nc60.x,nc60.y,nc60.z,nc60.w) * fx60;
    vec4 final15 = vec4(nc15.x,nc15.y,nc15.z,nc15.w) * fx15;
    vec4 final75 = vec4(nc75.x,nc75.y,nc75.z,nc75.w) * fx75;

    vec4 maximo = max(max(max(final15, final75), max(final30, final60)), final45);

    vec3 pix1 = E; float blend1 = 0.0;
    vec3 pix2 = E; float blend2 = 0.0;

    if      (nc.x) { pix1 = px.x ? F : H; blend1 = maximo.x; }
    else if (nc.y) { pix1 = px.y ? B : F; blend1 = maximo.y; }
    else if (nc.z) { pix1 = px.z ? D : B; blend1 = maximo.z; }
    else if (nc.w) { pix1 = px.w ? H : D; blend1 = maximo.w; }

    if      (nc.w) { pix2 = px.w ? H : D; blend2 = maximo.w; }
    else if (nc.z) { pix2 = px.z ? D : B; blend2 = maximo.z; }
    else if (nc.y) { pix2 = px.y ? B : F; blend2 = maximo.y; }
    else if (nc.x) { pix2 = px.x ? F : H; blend2 = maximo.x; }

    vec3 res1 = mix(E, pix1, blend1);
    vec3 res2 = mix(E, pix2, blend2);
    vec3 res = mix(res1, res2, step(c_df(E, res1), c_df(E, res2)));
    gl_FragColor = vec4(res, 1.0);
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
      gl.uniform1f(this.u2Noise, this.noise);
      gl.uniform1f(this.u2Scale, this.deviceScale);
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
