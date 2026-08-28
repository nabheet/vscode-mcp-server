import { describe, it, expect } from 'vitest';
import { Histogram, Metrics } from '../utils/metrics';

describe('Histogram', () => {
  it('records observations and computes quantiles', () => {
    const h = new Histogram('test_ms', 'help');
    for (let i = 1; i <= 100; i++) h.observe(i / 1000); // 0.001..0.100s
    expect(h.count).toBe(100);
    const p50 = h.quantile(0.5);
    const p99 = h.quantile(0.99);
    expect(p50).toBeGreaterThan(0.048);
    expect(p50).toBeLessThan(0.052);
    expect(p99).toBeGreaterThan(0.098);
    expect(p99).toBeLessThan(0.102);
  });

  it('emits Prometheus text format', () => {
    const h = new Histogram('req_dur', 'request duration');
    h.observe(0.05);
    const t = h.text();
    expect(t).toContain('# TYPE req_dur histogram');
    expect(t).toContain('req_dur_bucket{le="0.1"} 1');
    expect(t).toContain('req_dur_count 1');
    expect(t).toContain('req_dur_sum 0.05');
  });

  it('returns 0 quantile on empty histogram', () => {
    const h = new Histogram('empty', 'help');
    expect(h.quantile(0.95)).toBe(0);
    expect(h.count).toBe(0);
  });
});

describe('Metrics', () => {
  it('aggregates gauges, counters, histograms, errors', () => {
    const m = new Metrics();
    m.gauge('mem_rss', 12345, 'rss');
    m.counterInc('tool_total');
    m.counterInc('tool_total');
    const h = m.histogram('tool_dur', 'tool duration');
    h.observe(0.2);
    m.recordError('debug', 'boom');

    const text = m.text();
    expect(text).toContain('mem_rss 12345');
    expect(text).toContain('tool_total 2');
    expect(text).toContain('tool_dur_count 1');

    const d = m.diagnostics();
    expect(d.counters.tool_total).toBe(2);
    expect(d.gauges.mem_rss).toBe(12345);
    expect(d.histograms.tool_dur.count).toBe(1);
    expect(d.recentErrors).toHaveLength(1);
    expect(d.recentErrors[0].tool).toBe('debug');
    expect(d.recentErrors[0].error).toBe('boom');
  });
});
