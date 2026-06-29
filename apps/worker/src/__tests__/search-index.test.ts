import { describe, it, expect, beforeEach } from 'vitest';
import { refreshSearchIndex } from '../search-index';
import { createMockSql } from './helpers/mock-sql';

/**
 * search_index refresh builds a weighted tsvector from the object's filename
 * (basename of key, weight A), its tag names (weight B), and its user-metadata
 * values (weight C), then UPSERTs on the unique object_id constraint.
 */
describe('refreshSearchIndex', () => {
  let mock: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mock = createMockSql();
  });

  it('issues a single statement parameterised by object id', async () => {
    await refreshSearchIndex(mock.sql, 'obj-123');

    expect(mock.sql).toHaveBeenCalledTimes(1);
    expect(mock.queries).toHaveLength(1);
    // The query now has 3 language params + objectId.
    expect(mock.queries[0]?.params).toEqual(['english', 'english', 'english', 'obj-123']);
  });

  it('UPSERTs into search_index with an ON CONFLICT update of tsv', async () => {
    await refreshSearchIndex(mock.sql, 'obj-123');

    const text = mock.queries[0]?.text ?? '';
    expect(text).toContain('INSERT INTO search_index (object_id, tsv)');
    expect(text).toContain('ON CONFLICT (object_id) DO UPDATE SET tsv = EXCLUDED.tsv');
  });

  it('derives the filename (weight A) from the basename of the object key', async () => {
    await refreshSearchIndex(mock.sql, 'obj-123');

    const text = mock.queries[0]?.text ?? '';
    // basename via regexp_replace stripping everything up to the last slash.
    expect(text).toContain("regexp_replace(o.key, '^.*/', '')");
    expect(text).toContain("setweight(");
    expect(text).toMatch(/setweight\([\s\S]*?'A'\s*\)/);
  });

  it('includes tag names (weight B) and user-metadata values (weight C)', async () => {
    await refreshSearchIndex(mock.sql, 'obj-123');

    const text = mock.queries[0]?.text ?? '';
    // Tags sub-select, weight B.
    expect(text).toContain('FROM object_tags ot');
    expect(text).toContain('JOIN tags t ON t.id = ot.tag_id');
    expect(text).toMatch(/'B'/);
    // User metadata sub-select, weight C.
    expect(text).toContain('FROM object_user_metadata oum');
    expect(text).toContain('string_agg(oum.value');
    expect(text).toMatch(/'C'/);
  });

  it('uses to_tsvector with the english config for all three sources', async () => {
    await refreshSearchIndex(mock.sql, 'obj-123');
    const text = mock.queries[0]?.text ?? '';
    // With parameterized language, the text uses `?` placeholders for each
    // language param (we check params contain 3 × 'english' instead).
    const params = mock.queries[0]?.params ?? [];
    const englishCount = params.filter((p) => p === 'english').length;
    expect(englishCount).toBe(3);
  });
});
