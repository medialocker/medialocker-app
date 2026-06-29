import { describe, it, expect } from 'vitest';
import { validateBucketName, buildBucketName } from '../src/tenancy.js';

describe('validateBucketName', () => {
  it('accepts a valid bucket name', () => {
    expect(validateBucketName('my-bucket')).toEqual({ valid: true });
  });

  it('accepts a minimal valid name (3 chars)', () => {
    expect(validateBucketName('a-b')).toEqual({ valid: true });
  });

  it('accepts a single-character name (a1)', () => {
    const result = validateBucketName('a1');
    // "a1" is 2 chars, which is < 3 → invalid
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('between 3 and 63');
  });

  it('accepts a valid name at the maximum length (63 chars)', () => {
    const name = 'a' + 'b'.repeat(61) + 'c';
    expect(name.length).toBe(63);
    expect(validateBucketName(name)).toEqual({ valid: true });
  });

  it('rejects a name shorter than 3 characters', () => {
    expect(validateBucketName('ab').valid).toBe(false);
    expect(validateBucketName('ab').reason).toContain('between 3 and 63');
  });

  it('rejects a name longer than 63 characters', () => {
    const long = 'a' + 'b'.repeat(62) + 'c';
    expect(long.length).toBe(64);
    const result = validateBucketName(long);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('between 3 and 63');
  });

  it('rejects a name that starts with a non-lowercase letter/number', () => {
    expect(validateBucketName('-bucket').valid).toBe(false);
    expect(validateBucketName('.bucket').valid).toBe(false);
    expect(validateBucketName('_bucket').valid).toBe(false);
    expect(validateBucketName('Bucket').valid).toBe(false);
  });

  it('rejects a name that ends with a non-lowercase letter/number', () => {
    expect(validateBucketName('bucket-').valid).toBe(false);
    expect(validateBucketName('bucket.').valid).toBe(false);
  });

  it('rejects names with uppercase letters', () => {
    expect(validateBucketName('My-Bucket').valid).toBe(false);
  });

  it('rejects names with invalid characters', () => {
    expect(validateBucketName('my_bucket').valid).toBe(false);
    expect(validateBucketName('my bucket').valid).toBe(false);
    expect(validateBucketName('my@bucket').valid).toBe(false);
  });

  it('accepts names with numbers and hyphens', () => {
    expect(validateBucketName('my-bucket-123')).toEqual({ valid: true });
  });

  it('accepts a numeric-only name', () => {
    expect(validateBucketName('123')).toEqual({ valid: true });
  });

  it('rejects names formatted as IP addresses', () => {
    expect(validateBucketName('192.168.1.1').valid).toBe(false);
    expect(validateBucketName('10.0.0.1').valid).toBe(false);
    expect(validateBucketName('1.1.1.1').valid).toBe(false);
  });

  it('rejects names starting with xn--', () => {
    expect(validateBucketName('xn--bucket').valid).toBe(false);
  });

  it('accepts xn-- in the middle of a name (not a prefix)', () => {
    expect(validateBucketName('my-xn--bucket')).toEqual({ valid: true });
  });
});

describe('buildBucketName', () => {
  it('always starts with ml-', () => {
    const name = buildBucketName('org-1', 'photos');
    expect(name.startsWith('ml-')).toBe(true);
  });

  it('does not exceed 63 characters', () => {
    const longBucket = 'a'.repeat(60) + '-b';
    const name = buildBucketName('org-1', longBucket);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('includes a 12-char hex hash suffix', () => {
    const name = buildBucketName('org-1', 'photos');
    const suffix = name.slice(-12);
    expect(/^[0-9a-f]{12}$/.test(suffix)).toBe(true);
  });

  it('produces globally unique names for different orgs + same bucket', () => {
    const a = buildBucketName('org-a', 'photos');
    const b = buildBucketName('org-b', 'photos');
    expect(a).not.toBe(b);
  });

  it('produces globally unique names for same org + different buckets', () => {
    const a = buildBucketName('org-1', 'photos');
    const b = buildBucketName('org-1', 'videos');
    expect(a).not.toBe(b);
  });

  it('is deterministic for the same inputs', () => {
    const a = buildBucketName('org-1', 'photos');
    const b = buildBucketName('org-1', 'photos');
    expect(a).toBe(b);
  });

  it('lowercases the bucket name portion', () => {
    const name = buildBucketName('org-1', 'MyBucket');
    expect(name).toContain('mybucket');
  });

  it('replaces non-alphanumeric chars with hyphens', () => {
    const name = buildBucketName('org-1', 'my_bucket@test');
    expect(name).toContain('my-bucket-test');
  });

  it('strips leading and trailing hyphens from the slug', () => {
    const name = buildBucketName('org-1', '-my-bucket-');
    expect(name).toContain('my-bucket');
  });
});
