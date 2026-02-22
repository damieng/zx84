// Shared preamble for all upscale fragment shaders.
// Each shader reads from the emulator source texture (NEAREST filtered)
// and writes to the FBO at display resolution. All shaders receive:
//   u_tex      — source texture
//   u_texSize  — source dimensions (e.g. 352, 288)
//   u_smoothing — 0..1 blending parameter (used by modes 0 and 1)
export const UPSCALE_HEAD = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_texSize;
  uniform float u_smoothing;
`;
