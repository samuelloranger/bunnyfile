import { describe, expect, it } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';

describe('router view transitions', () => {
  it('transitions path changes and leaves search-only changes immediate', async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost' } },
      });
      const { createRouter } = await import('./router');

      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { supports: () => false },
      });
      expect(createRouter({ queryClient: {} as QueryClient }).options.defaultViewTransition).toBe(
        false,
      );

      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { supports: () => true },
      });
      const router = createRouter({ queryClient: {} as QueryClient });
      const transition = router.options.defaultViewTransition;

      expect(transition).toEqual({
        types: expect.any(Function),
      });

      if (!transition || typeof transition !== 'object' || typeof transition.types !== 'function') {
        throw new Error('missing view transition type resolver');
      }
      const types = transition.types;
      const location = (index: number) => ({ state: { __TSR_index: index } });
      const change = (pathChanged: boolean, fromIndex: number, toIndex: number) =>
        ({
          pathChanged,
          fromLocation: location(fromIndex),
          toLocation: location(toIndex),
        }) as Parameters<typeof types>[0];

      expect(types(change(true, 1, 2))).toEqual(['route-forward']);
      expect(types(change(true, 2, 1))).toEqual(['route-back']);
      expect(types(change(false, 1, 2))).toBe(false);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });
});
