/**
 * Signal + localStorage sync helper.
 */

import { type Accessor, createEffect } from 'solid-js';
import { persistSetting } from '@/store/settings.ts';

export function usePersisted(sig: Accessor<number | string>, key: string): void {
  createEffect(() => {
    persistSetting(key, sig());
  });
}
