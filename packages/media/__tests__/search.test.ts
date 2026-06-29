import { describe, it, expect } from 'vitest';
import { buildSearchQuery, sanitizeSearchQuery } from '../src/search';
import type { SearchFilters } from '../src/search';

describe('sanitizeSearchQuery', () => {
  it('returns plain sanitized text (no tsquery operators)', () => {
    expect(sanitizeSearchQuery('red car')).toBe('red car');
  });

  it('returns an empty string for an empty input', () => {
    expect(sanitizeSearchQuery('')).toBe('');
  });

  it('returns an empty string when input is only punctuation/whitespace', () => {
    expect(sanitizeSearchQuery('!!! ??? ***')).toBe('');
  });

  it('collapses repeated whitespace', () => {
    expect(sanitizeSearchQuery('  red    car  ')).toBe('red car');
  });

  it('strips disallowed characters but keeps word/space/dash/at/dot', () => {
    expect(sanitizeSearchQuery('foo@bar.com')).toBe('foo@bar.com');
  });

  it('replaces disallowed characters with a space, splitting words', () => {
    expect(sanitizeSearchQuery('foo/bar')).toBe('foo bar');
  });

  it('keeps single-character words unchanged', () => {
    expect(sanitizeSearchQuery('a red')).toBe('a red');
  });

  it('preserves hyphenated terms as one token', () => {
    expect(sanitizeSearchQuery('high-res')).toBe('high-res');
  });
});

describe('buildSearchQuery', () => {
  const ORG = 'org-123';

  it('always scopes by org_id (via bucket) and excludes soft-deleted rows', () => {
    const { sql, params } = buildSearchQuery(ORG, '', {});
    expect(sql).toContain('b.org_id = $1');
    expect(sql).toContain('o.deleted_at IS NULL');
    expect(params).toEqual([ORG]);
  });

  it('produces the documented column projection and joins', () => {
    const { sql } = buildSearchQuery(ORG, '', {});
    expect(sql).toContain('FROM objects o');
    expect(sql).toContain('JOIN buckets b ON b.id = o.bucket_id');
    expect(sql).toContain('LEFT JOIN search_index sidx ON sidx.object_id = o.id');
    expect(sql).toContain('LEFT JOIN media_assets ma ON ma.object_id = o.id');
    expect(sql).toContain('ORDER BY o.created_at DESC');
  });

  it('adds a tsquery condition with a sanitized param when q is non-empty', () => {
    const { sql, params } = buildSearchQuery(ORG, 'red car', {});
    expect(sql).toContain("sidx.tsv @@ plainto_tsquery('english', $2)");
    expect(params).toEqual([ORG, 'red car']);
  });

  it('skips the tsquery condition when q is only whitespace', () => {
    const { sql, params } = buildSearchQuery(ORG, '   ', {});
    expect(sql).not.toContain('plainto_tsquery');
    expect(params).toEqual([ORG]);
  });

  it('skips the tsquery condition when q sanitizes to empty', () => {
    const { sql, params } = buildSearchQuery(ORG, '!!!', {});
    expect(sql).not.toContain('plainto_tsquery');
    expect(params).toEqual([ORG]);
  });

  it('adds a kind filter', () => {
    const { sql, params } = buildSearchQuery(ORG, '', { kind: 'image' });
    expect(sql).toContain('ma.kind = $2');
    expect(params).toEqual([ORG, 'image']);
  });

  it('adds a tags EXISTS filter with the array param', () => {
    const tags = ['nature', 'sky'];
    const { sql, params } = buildSearchQuery(ORG, '', { tags });
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM object_tags ot JOIN tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id AND t.slug = ANY($2::text[]))',
    );
    expect(params).toEqual([ORG, tags]);
  });

  it('ignores an empty tags array', () => {
    const { sql, params } = buildSearchQuery(ORG, '', { tags: [] });
    expect(sql).not.toContain('object_tags');
    expect(params).toEqual([ORG]);
  });

  it('adds a categories EXISTS filter', () => {
    const categories = ['landscape'];
    const { sql, params } = buildSearchQuery(ORG, '', { categories });
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM object_categories oc JOIN categories c ON c.id = oc.category_id WHERE oc.object_id = o.id AND c.slug = ANY($2::text[]))',
    );
    expect(params).toEqual([ORG, categories]);
  });

  it('adds size range filters', () => {
    const { sql, params } = buildSearchQuery(ORG, '', { sizeMin: 100, sizeMax: 5000 });
    expect(sql).toContain('o.size >= $2');
    expect(sql).toContain('o.size <= $3');
    expect(params).toEqual([ORG, 100, 5000]);
  });

  it('treats sizeMin of 0 as present (undefined check, not falsy)', () => {
    const { sql, params } = buildSearchQuery(ORG, '', { sizeMin: 0 });
    expect(sql).toContain('o.size >= $2');
    expect(params).toEqual([ORG, 0]);
  });

  it('adds casted date range filters', () => {
    const { sql, params } = buildSearchQuery(ORG, '', {
      dateMin: '2026-01-01',
      dateMax: '2026-12-31',
    });
    expect(sql).toContain('o.created_at >= $2::timestamptz');
    expect(sql).toContain('o.created_at <= $3::timestamptz');
    expect(params).toEqual([ORG, '2026-01-01', '2026-12-31']);
  });

  it('adds bucket, set and storyboard filters', () => {
    const { sql, params } = buildSearchQuery(ORG, '', {
      bucketId: 'b1',
      setId: 's1',
      storyboardId: 'sb1',
    });
    expect(sql).toContain('o.bucket_id = $2');
    expect(sql).toContain('EXISTS (SELECT 1 FROM set_items si WHERE si.object_id = o.id AND si.set_id = $3)');
    expect(sql).toContain('EXISTS (SELECT 1 FROM storyboard_clips sc WHERE sc.object_id = o.id AND sc.storyboard_id = $4)');
    expect(params).toEqual([ORG, 'b1', 's1', 'sb1']);
  });

  it('numbers placeholders sequentially across q and multiple filters', () => {
    const filters: SearchFilters = {
      kind: 'video',
      tags: ['a'],
      sizeMin: 10,
    };
    const { sql, params } = buildSearchQuery(ORG, 'cat', filters);
    // $1 org, $2 tsquery, $3 kind, $4 tags, $5 sizeMin
    expect(params).toEqual([ORG, 'cat', 'video', ['a'], 10]);
    expect(sql).toContain("sidx.tsv @@ plainto_tsquery('english', $2)");
    expect(sql).toContain('ma.kind = $3');
    expect(sql).toContain('ANY($4::text[])');
    expect(sql).toContain('o.size >= $5');
  });
});
