/**
 * Tiny Prometheus-compatible metrics registry. Hand-rolled on purpose —
 * same signals as an OTEL metrics stack (event-loop lag, memory, CPU,
 * request histogram) with zero dependencies and zero collector needed.
 *
 * Served as Prometheus text format at /metrics, plus a human-readable
 * JSON summary at /diagnostics.
 */

/** Histogram with fixed upper-bound buckets. Tracks count/sum for
 *  percentile + rate computation on scrape. */
export class Histogram {
  private readonly buckets: Record<number, number>;
  private totalCount = 0;
  private totalSum = 0;

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly bounds: number[] = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  ) {
    this.buckets = {};
    for (const b of bounds) this.buckets[b] = 0;
  }

  /** Record an observation (seconds for durations). */
  observe(value: number): void {
    this.totalCount++;
    this.totalSum += value;
    for (const b of this.bounds) {
      if (value <= b) this.buckets[b]++;
    }
  }

  get count(): number {
    return this.totalCount;
  }

  /** Approximate quantile (seconds). Bucket counts are cumulative
   *  (le = less-than-or-equal), so the crossing is interpolated against
   *  the *delta* between adjacent cumulative counts. */
  quantile(q: number): number {
    if (this.totalCount === 0) return 0;
    const target = q * this.totalCount;
    let prevBound = 0;
    let prevCumulative = 0;
    for (const b of this.bounds) {
      const c = this.buckets[b];
      if (target <= c) {
        const inBucket = c - prevCumulative;
        const frac = inBucket === 0 ? 0 : (target - prevCumulative) / inBucket;
        return prevBound + frac * (b - prevBound);
      }
      prevBound = b;
      prevCumulative = c;
    }
    return this.bounds[this.bounds.length - 1];
  }

  text(): string {
    const out: string[] = [];
    const type = '# TYPE ' + this.name + ' histogram';
    const help = '# HELP ' + this.name + ' ' + this.help;
    out.push(help);
    out.push(type);
    for (const b of this.bounds) {
      out.push(`${this.name}_bucket{le="${b}"} ${this.buckets[b]}`);
    }
    out.push(`${this.name}_bucket{le="+Inf"} ${this.totalCount}`);
    out.push(`${this.name}_sum ${this.totalSum}`);
    out.push(`${this.name}_count ${this.totalCount}`);
    return out.join('\n');
  }
}

interface GaugeSpec {
  value: number;
  help: string;
}

interface CounterSpec {
  value: number;
  help: string;
}

interface ErrorRecord {
  ts: string;
  tool: string;
  error: string;
}

export class Metrics {
  private readonly gauges = new Map<string, GaugeSpec>();
  private readonly counters = new Map<string, CounterSpec>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly lastErrors: ErrorRecord[] = [];
  private readonly maxErrors = 20;
  private startedAt = Date.now();

  gauge(name: string, value: number, help = ''): void {
    this.gauges.set(name, { value, help });
  }

  counterInc(name: string, help = ''): void {
    const cur = this.counters.get(name)?.value ?? 0;
    this.counters.set(name, { value: cur + 1, help });
  }

  histogram(name: string, help: string, bounds?: number[]): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, bounds);
      this.histograms.set(name, h);
    }
    return h;
  }

  /** Ring buffer of recent tool errors — feeds /diagnostics. */
  recordError(tool: string, error: string): void {
    this.lastErrors.push({ ts: new Date().toISOString(), tool, error });
    if (this.lastErrors.length > this.maxErrors) this.lastErrors.shift();
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** Prometheus text format — served at /metrics. */
  text(): string {
    const out: string[] = [];
    out.push('# HELP vscode_mcp_uptime_seconds Uptime of the MCP server process');
    out.push('# TYPE vscode_mcp_uptime_seconds gauge');
    out.push(`vscode_mcp_uptime_seconds ${this.uptimeSeconds}`);
    for (const [name, spec] of this.gauges) {
      out.push(`# HELP ${name} ${spec.help || name}`);
      out.push('# TYPE ' + name + ' gauge');
      out.push(`${name} ${spec.value}`);
    }
    for (const [name, spec] of this.counters) {
      out.push(`# HELP ${name} ${spec.help || name}`);
      out.push('# TYPE ' + name + ' counter');
      out.push(`${name} ${spec.value}`);
    }
    for (const h of this.histograms.values()) out.push(h.text());
    return out.join('\n') + '\n';
  }

  /** Human-readable JSON — served at /diagnostics. */
  diagnostics(): Record<string, unknown> {
    const histSummary: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
    for (const [name, h] of this.histograms) {
      histSummary[name] = { count: h.count, p50: h.quantile(0.5), p95: h.quantile(0.95), p99: h.quantile(0.99) };
    }
    const gauges: Record<string, number> = {};
    for (const [name, spec] of this.gauges) gauges[name] = spec.value;
    const counters: Record<string, number> = {};
    for (const [name, spec] of this.counters) counters[name] = spec.value;
    return {
      uptimeSeconds: this.uptimeSeconds,
      gauges,
      counters,
      histograms: histSummary,
      recentErrors: this.lastErrors,
    };
  }
}