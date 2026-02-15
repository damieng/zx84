/**
 * Signal + localStorage sync helper.
 */

import { type Signal, effect } from '@preact/signals';
import { persistSetting } from '@/store/settings.ts';

export function usePersisted(sig: Signal<number | string>, key: string): void {
  effect(() => {
    persistSetting(key, sig.value);
  });
}
