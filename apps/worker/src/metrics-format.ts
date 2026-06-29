// P3.11: pure formatting helpers for the worker metrics surface. Kept free of
// any BullMQ/Redis imports so they are unit-testable without backing services.

// States reported by BullMQ's getJobCounts(); kept explicit so the Prometheus
// series set is stable regardless of which states currently have jobs.
export const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

export type QueueCounts = { queue: string; counts: Record<string, number> };

export function renderPrometheus(snapshot: QueueCounts[]): string {
  const lines: string[] = [];
  lines.push('# HELP medialocker_worker_up Worker metrics server is up (always 1 while scrapeable).');
  lines.push('# TYPE medialocker_worker_up gauge');
  lines.push('medialocker_worker_up 1');
  lines.push('# HELP medialocker_queue_jobs Number of BullMQ jobs in a queue by state.');
  lines.push('# TYPE medialocker_queue_jobs gauge');
  for (const { queue, counts } of snapshot) {
    for (const state of JOB_STATES) {
      const value = counts[state] ?? 0;
      lines.push(`medialocker_queue_jobs{queue="${queue}",state="${state}"} ${value}`);
    }
  }
  // Backlog = waiting + delayed: the single most useful worker-lag signal.
  lines.push('# HELP medialocker_queue_backlog Pending jobs (waiting + delayed) per queue.');
  lines.push('# TYPE medialocker_queue_backlog gauge');
  for (const { queue, counts } of snapshot) {
    const backlog = (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0);
    lines.push(`medialocker_queue_backlog{queue="${queue}"} ${backlog}`);
  }
  return lines.join('\n') + '\n';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export function renderDashboard(snapshot: QueueCounts[]): string {
  const rows = snapshot
    .map(({ queue, counts }) => {
      const backlog = (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0);
      const failedClass = (counts['failed'] ?? 0) > 0 ? ' class="warn"' : '';
      return `<tr>
        <td>${escapeHtml(queue)}</td>
        <td>${counts['waiting'] ?? 0}</td>
        <td>${counts['active'] ?? 0}</td>
        <td>${counts['delayed'] ?? 0}</td>
        <td>${counts['completed'] ?? 0}</td>
        <td${failedClass}>${counts['failed'] ?? 0}</td>
        <td>${backlog}</td>
      </tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>MediaLocker — Queue Dashboard</title>
<meta http-equiv="refresh" content="5"/>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem;background:#0b0f14;color:#e6edf3}
  h1{font-size:1.2rem} table{border-collapse:collapse;width:100%;max-width:880px}
  th,td{padding:.5rem .75rem;text-align:right;border-bottom:1px solid #21262d}
  th:first-child,td:first-child{text-align:left}
  thead th{color:#7d8590;font-weight:600;text-transform:uppercase;font-size:.72rem;letter-spacing:.04em}
  td.warn{color:#ff7b72;font-weight:700} caption{color:#7d8590;font-size:.8rem;margin-bottom:.5rem;text-align:left}
</style></head><body>
<h1>MediaLocker Queue Dashboard</h1>
<table>
<caption>Auto-refreshes every 5s · ${escapeHtml(new Date().toISOString())}</caption>
<thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Completed</th><th>Failed</th><th>Backlog</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>`;
}
