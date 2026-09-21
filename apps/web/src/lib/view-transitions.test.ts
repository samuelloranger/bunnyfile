import { describe, expect, it } from 'bun:test';

describe('folder navigation view transitions', () => {
  it('uses a typed transition only when the browser supports transition types', async () => {
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');

    try {
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { supports: () => true },
      });
      const { folderNavigationViewTransition } = await import('./view-transitions');
      expect(folderNavigationViewTransition()).toEqual({ types: ['folder-navigation'] });

      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { supports: () => false },
      });
      expect(folderNavigationViewTransition()).toBe(false);
    } finally {
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
    }
  });
});
