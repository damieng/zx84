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

import { UPSCALE_HEAD } from '@/display/shaders/upscale-head.ts';

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

// HQ2x — LUT-based reference implementation (256×64 LUT)
export const FRAG_HQ2X = UPSCALE_HEAD + HQX_LUT_COMMON + `
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

// HQ3x — LUT-based reference implementation (256×144 LUT)
export const FRAG_HQ3X = UPSCALE_HEAD + HQX_LUT_COMMON + `
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

// HQ4x — LUT-based reference implementation (256×256 LUT)
export const FRAG_HQ4X = UPSCALE_HEAD + HQX_LUT_COMMON + `
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
