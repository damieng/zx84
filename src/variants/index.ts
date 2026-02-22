/**
 * Variant factory — creates the appropriate MachineVariant for a given model.
 */

import type { SpectrumModel } from '@/models.ts';
import type { MachineVariant } from './machine-variant.ts';
import { spectrum48K } from './spectrum-48k.ts';
import { createFerranti128K } from './spectrum-ferranti.ts';
import { createAmstrad } from './spectrum-amstrad.ts';

export type { MachineVariant } from './machine-variant.ts';

export function createVariant(model: SpectrumModel): MachineVariant {
  switch (model) {
    case '48k':  return spectrum48K;
    case '128k': return createFerranti128K('128k');
    case '+2':   return createFerranti128K('+2');
    case '+2a':  return createAmstrad('+2a');
    case '+3':   return createAmstrad('+3');
  }
}
