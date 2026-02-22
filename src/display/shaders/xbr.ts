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

import { UPSCALE_HEAD } from '@/display/shaders/upscale-head.ts';

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

// xBR-lv2 — Hyllian's xBR level 2 (4-direction edge detection).
// Works at any integer scale.  Detects edges at 45°/30°/60° angles.
export const FRAG_XBR_LV2 = UPSCALE_HEAD + XBR_COMMON + `
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

// xBR-lv3 — Hyllian's xBR level 3 (6-direction edge detection).
// Works at any integer scale.  Adds 15° and 75° angles for smoother curves.
export const FRAG_XBR_LV3 = UPSCALE_HEAD + XBR_COMMON + `
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
