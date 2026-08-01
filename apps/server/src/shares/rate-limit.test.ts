import { describe, expect, test } from 'bun:test';
import { requestIp } from './rate-limit';

describe('requestIp', () => {
  test('ignores XFF when trust disabled', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(requestIp(req, '10.0.0.5', { trustProxy: false })).toBe('10.0.0.5');
  });

  test('uses first XFF hop when trustProxy true', () => {
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    });
    expect(requestIp(req, '10.0.0.5', { trustProxy: true })).toBe('1.2.3.4');
  });

  test('TRUSTED_PROXIES: ignore XFF unless peer is trusted', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(requestIp(req, '8.8.8.8', { trustProxy: true, trustedProxies: ['10.0.0.0/8'] })).toBe(
      '8.8.8.8',
    );
    expect(requestIp(req, '10.0.0.5', { trustProxy: true, trustedProxies: ['10.0.0.0/8'] })).toBe(
      '1.2.3.4',
    );
  });

  test('falls back to X-Real-IP when trusted and no XFF', () => {
    const req = new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } });
    expect(requestIp(req, '10.0.0.5', { trustProxy: true })).toBe('9.9.9.9');
  });
});
