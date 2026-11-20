import { describe, expect, it } from 'bun:test';
import { canonicalQuery, canonicalUri, uriEncode } from './sigv4';

// Expected strings are written out by hand from the SigV4 rules (IAM user
// guide, "Create a signed AWS API request"), not computed with the code under test.
describe('SigV4 canonicalization', () => {
  it.each([
    ['unreserved characters stay as-is', 'AZaz09-._~', 'AZaz09-._~'],
    ['space is %20, not +', 'a b', 'a%20b'],
    ["!'()* are escaped", "!'()*", '%21%27%28%29%2A'],
    ['reserved characters are escaped', '/?&=+:', '%2F%3F%26%3D%2B%3A'],
    ['non-ASCII is UTF-8 percent-encoded with uppercase hex', 'é', '%C3%A9'],
  ])('UriEncode: %s', (_, input, expected) => {
    expect(uriEncode(input)).toBe(expected);
  });

  it.each([
    [
      'sorts by key in byte order (uppercase first)',
      '?x-id=Get&X-Amz-Date=1&a=2',
      'X-Amz-Date=1&a=2&x-id=Get',
    ],
    ['sorts a key before its longer extensions', '?a-b=1&a=2', 'a=2&a-b=1'],
    ['sorts duplicate keys by value', '?k=b&k=a', 'k=a&k=b'],
    ['valueless subresources become key=', '?uploads&prefix=x', 'prefix=x&uploads='],
    ['values are re-encoded after decoding', '?prefix=it%27s%20(1)', 'prefix=it%27s%20%281%29'],
  ])('query: %s', (_, search, expected) => {
    expect(canonicalQuery(new URL(`http://h/b${search}`))).toBe(expected);
  });

  it('omits only the signature parameter for presigned URLs', () => {
    const url = new URL('http://h/b/k?X-Amz-Signature=abc&X-Amz-Date=1');
    expect(canonicalQuery(url, 'X-Amz-Signature')).toBe('X-Amz-Date=1');
  });

  it('encodes each path segment once and keeps the slashes', () => {
    expect(canonicalUri('/api/s3/bucket/dir/a%20b(1).txt')).toBe(
      '/api/s3/bucket/dir/a%20b%281%29.txt',
    );
    expect(canonicalUri('/bucket//double/')).toBe('/bucket//double/');
  });
});
