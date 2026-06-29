import { vi } from 'vitest';

/** A single recorded tagged-template SQL invocation. */
export interface RecordedQuery {
  /** The static SQL fragments (TemplateStringsArray joined view kept raw). */
  strings: readonly string[];
  /** The interpolated parameters, in order. */
  params: unknown[];
  /** Convenience: the static fragments joined with `?` placeholders. */
  text: string;
}

export interface MockSql {
  /** The tagged-template callable to inject where `Sql` is expected. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sql: any;
  /** All queries issued, in order. */
  queries: RecordedQuery[];
  /**
   * Queue a result for the Nth (in order) query. Results are matched to
   * queries positionally as they are consumed.
   */
  queueResult: (rows: unknown[]) => void;
  /**
   * Register a matcher: when a query's joined text matches `substring`, the
   * given rows are returned regardless of order. Checked before the positional
   * queue.
   */
  onQuery: (substring: string, rows: unknown[]) => void;
  /**
   * Register a predicate matcher with full access to the recorded query
   * (text + params). The first registered predicate that returns rows wins.
   */
  onMatch: (
    fn: (q: RecordedQuery) => unknown[] | undefined,
  ) => void;
  /** Clear recorded queries AND all queued/registered matchers. */
  reset: () => void;
}

/**
 * Build a mock of the `postgres` tagged-template client (`Sql`).
 *
 * The real client is callable as `` sql`SELECT ...${p}` `` and returns a
 * thenable resolving to an array of rows. This mock records every invocation
 * (static fragments + params) and resolves to queued/matched rows so tests can
 * assert the exact SQL and parameters issued without a live database.
 */
export function createMockSql(): MockSql {
  const queries: RecordedQuery[] = [];
  const positional: unknown[][] = [];
  const matchers: Array<{ substring: string; rows: unknown[] }> = [];
  const predicates: Array<(q: RecordedQuery) => unknown[] | undefined> = [];

  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> => {
      const text = strings.join('?');
      const q: RecordedQuery = { strings: [...strings], params, text };
      queries.push(q);

      for (const p of predicates) {
        const rows = p(q);
        if (rows !== undefined) return Promise.resolve(rows);
      }
      const matcher = matchers.find((m) => text.includes(m.substring));
      if (matcher) {
        return Promise.resolve(matcher.rows);
      }
      const next = positional.shift();
      return Promise.resolve(next ?? []);
    },
  );

  return {
    sql,
    queries,
    queueResult: (rows) => positional.push(rows),
    onQuery: (substring, rows) => matchers.push({ substring, rows }),
    onMatch: (fn) => predicates.push(fn),
    reset: () => {
      queries.length = 0;
      positional.length = 0;
      matchers.length = 0;
      predicates.length = 0;
      sql.mockClear();
    },
  };
}

/** Minimal BullMQ-ish Job stub with the fields the processors read. */
export function makeJob<T>(data: T, id = 'job-1'): { id: string; data: T } {
  return { id, data };
}
