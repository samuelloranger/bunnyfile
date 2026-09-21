import { describe, expect, it } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';

describe('router view transitions', () => {
  it('leaves visual transition ownership to React component boundaries', async () => {
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

      expect(createRouter({ queryClient: {} as QueryClient }).options.defaultViewTransition).toBe(
        false,
      );
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });
});
