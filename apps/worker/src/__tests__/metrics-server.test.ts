import { describe, it, expect } from 'vitest';
import { renderPrometheus, renderDashboard } from '../metrics-format';

const snapshot = [
  { queue: 'media:probe', counts: { waiting: 3, active: 1, completed: 10, failed: 2, delayed: 4, paused: 0 } },
  { queue: 'usage:rollup', counts: { waiting: 0, active: 0, completed: 5, failed: 0, delayed: 0, paused: 0 } },
];

describe('worker metrics-server rendering', () => {
  it('renders Prometheus exposition with per-queue per-state gauges', () => {
    const out = renderPrometheus(snapshot);
    expect(out).toContain('# TYPE medialocker_queue_jobs gauge');
    expect(out).toContain('medialocker_worker_up 1');
    expect(out).toContain('medialocker_queue_jobs{queue="media:probe",state="waiting"} 3');
    expect(out).toContain('medialocker_queue_jobs{queue="media:probe",state="failed"} 2');
    // backlog = waiting + delayed = 3 + 4 = 7
    expect(out).toContain('medialocker_queue_backlog{queue="media:probe"} 7');
    expect(out).toContain('medialocker_queue_backlog{queue="usage:rollup"} 0');
  });

  it('defaults missing states to 0 rather than NaN/undefined', () => {
    const out = renderPrometheus([{ queue: 'media:variant', counts: {} }]);
    expect(out).toContain('medialocker_queue_jobs{queue="media:variant",state="active"} 0');
    expect(out).toContain('medialocker_queue_backlog{queue="media:variant"} 0');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('undefined');
  });

  it('renders an HTML dashboard listing every queue and highlights failures', () => {
    const html = renderDashboard(snapshot);
    expect(html).toContain('<title>MediaLocker — Queue Dashboard</title>');
    expect(html).toContain('media:probe');
    expect(html).toContain('usage:rollup');
    // failed=2 on media:probe → warn class applied
    expect(html).toContain('class="warn">2</td>');
    expect(html).toContain('http-equiv="refresh"');
  });

  it('escapes HTML in queue names', () => {
    const html = renderDashboard([{ queue: '<script>x', counts: { failed: 0 } }]);
    expect(html).toContain('&lt;script&gt;x');
    expect(html).not.toContain('<script>x');
  });
});
