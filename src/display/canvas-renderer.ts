/**
 * Canvas 2D display renderer — pixel-perfect nearest-neighbor scaling.
 *
 * Uses an offscreen canvas at emulator resolution, then draws it scaled
 * onto the visible canvas with imageSmoothingEnabled = false.
 */

import type { IScreenRenderer } from './display.ts';

export class CanvasRenderer implements IScreenRenderer {
  canvas: HTMLCanvasElement;
  scale = 2;

  private width: number;
  private height: number;
  private ctx: CanvasRenderingContext2D;
  private offscreen: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private imageData: ImageData;

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('Offscreen canvas 2D not supported');
    this.offCtx = offCtx;

    this.imageData = this.offCtx.createImageData(width, height);

    this.applyScale();
  }

  private applyScale(): void {
    const w = this.width * this.scale;
    const h = this.height * this.scale;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = '';
    this.canvas.style.height = '';
    this.ctx.imageSmoothingEnabled = false;
  }

  updateTexture(pixels: Uint8Array): void {
    this.imageData.data.set(pixels);
    this.offCtx.putImageData(this.imageData, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.offscreen,
      0, 0, this.width, this.height,
      0, 0, this.canvas.width, this.canvas.height,
    );
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.offscreen.width = width;
    this.offscreen.height = height;
    this.imageData = this.offCtx.createImageData(width, height);
    this.applyScale();
  }

  setScale(scale: number): void {
    this.scale = scale;
    this.applyScale();
  }

  // CRT-specific setters — no-ops for canvas renderer
  setSmoothing(_v: number): void {}
  setCurvature(_v: number): void {}
  setScanlines(_v: number): void {}
  setMaskType(_v: number): void {}
  setDotPitch(_v: number): void {}
  setCurvatureMode(_v: number): void {}
  setBrightness(_v: number): void {}
  setContrast(_v: number): void {}
}
