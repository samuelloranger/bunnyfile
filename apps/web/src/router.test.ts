import { describe, expect, it } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';

describe('router view transitions', () => {
  it('starts typed native transitions for route changes only', async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost' } },
      });
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { supports: () => true },
      });
      const { createRouter } = await import('./router');

      const transition = createRouter({ queryClient: {} as QueryClient }).options
        .defaultViewTransition;

      expect(transition).toEqual({
        types: expect.any(Function),
      });

      if (!transition || typeof transition !== 'object' || typeof transition.types !== 'function') {
        throw new Error('missing view transition type resolver');
      }

      const location = (index: number) => ({ state: { __TSR_index: index } });
      const change = (pathChanged: boolean, fromIndex: number, toIndex: number) =>
        ({
          pathChanged,
          fromLocation: location(fromIndex),
          toLocation: location(toIndex),
        }) as Parameters<typeof transition.types>[0];

      expect(transition.types(change(true, 1, 2))).toEqual(['route-forward']);
      expect(transition.types(change(true, 2, 1))).toEqual(['route-back']);
      expect(transition.types(change(false, 1, 2))).toBe(false);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });
});
