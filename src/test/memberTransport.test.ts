import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "../mcp/cluster/memberTransport";

// Regression guard for CodeQL js/polynomial-redos on the old
// `baseUrl.replace(/\/+$/, "")`: an anchored `+` backtracks quadratically on a
// run of slashes that is NOT at the end of the string. Such an input is
// returned unchanged by BOTH implementations, so correctness alone cannot tell
// them apart — only elapsed time can. Measured on this machine, the old regex
// needs ~3.5s for the input below versus ~0.02ms for the scan, so a 1s bound
// fails the old code by two orders of magnitude while leaving the new code
// ~50,000x headroom against runner noise.
describe("normalizeBaseUrl", () => {
  it("leaves a URL without trailing slashes untouched", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:9876")).toBe("http://127.0.0.1:9876");
  });

  it("strips one trailing slash", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:9876/")).toBe("http://127.0.0.1:9876");
  });

  it("strips every trailing slash", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:9876////")).toBe("http://127.0.0.1:9876");
  });

  it("keeps slashes that are not trailing", () => {
    expect(normalizeBaseUrl("http://host//prefix/")).toBe("http://host//prefix");
  });

  it("handles IPv6 literals, whitespace and an empty string", () => {
    expect(normalizeBaseUrl("http://[::1]:9876/")).toBe("http://[::1]:9876");
    expect(normalizeBaseUrl(" http://127.0.0.1:9876/ ")).toBe(" http://127.0.0.1:9876/ ");
    expect(normalizeBaseUrl("")).toBe("");
  });

  it("degenerates to an empty string for an all-slash input", () => {
    expect(normalizeBaseUrl("///////")).toBe("");
  });

  it("does not backtrack on a long slash run that is not at the end", () => {
    const hostile = `${"/".repeat(100_000)}x`;
    const started = performance.now();
    expect(normalizeBaseUrl(hostile)).toBe(hostile);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
  });
});
