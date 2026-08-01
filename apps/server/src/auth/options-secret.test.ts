process.env.BETTER_AUTH_SECRET = 'test-secret-for-options-unit';

import { describe, expect, test } from 'bun:test';

const { assertAuthSecret } = await import('./options');

describe('BETTER_AUTH_SECRET', () => {
  test('refuses missing or insecure default', () => {
    expect(() => assertAuthSecret(undefined)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => assertAuthSecret('')).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => assertAuthSecret('dev-only-insecure-secret-please-change-me')).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  test('accepts a real secret', () => {
    expect(() => assertAuthSecret('a-real-secret-at-least-32-chars!!')).not.toThrow();
  });
});
