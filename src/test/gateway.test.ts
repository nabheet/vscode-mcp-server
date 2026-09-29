import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildBindHosts,
  buildCrossBoundaryHosts,
  filterBridgeAddresses,
  parseProcNetRoute,
} from "../mcp/cluster/gateway";

describe("parseProcNetRoute", () => {
  it("returns the default-route gateway as dotted-quad (little-endian hex)", () => {
    const route = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    ].join("\n");
    expect(parseProcNetRoute(route)).toBe("172.17.0.1");
  });

  it("skips non-default routes and returns the default one", () => {
    const route = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t000101AC\t010011AC\t0003\t0\t0\t0\t00FFFFFF\t0\t0\t0",
      "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    ].join("\n");
    expect(parseProcNetRoute(route)).toBe("172.17.0.1");
  });

  it("handles an on-link default route (0.0.0.0 gateway) as null", () => {
    const route = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0",
    ].join("\n");
    expect(parseProcNetRoute(route)).toBeNull();
  });

  it("returns null for a header-only or empty listing", () => {
    expect(parseProcNetRoute("Iface\tDestination\tGateway \tFlags\n")).toBeNull();
    expect(parseProcNetRoute("")).toBeNull();
  });

  it("handles malformed gateway hex gracefully", () => {
    const route = ["eth0\t00000000\tnothex\t0003"].join("\n");
    expect(parseProcNetRoute(route)).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const route = "Iface\tDestination\tGateway \tFlags\r\neth0\t00000000\t010011AC\t0003\r\n";
    expect(parseProcNetRoute(route)).toBe("172.17.0.1");
  });
});

describe("buildCrossBoundaryHosts", () => {
  it("orders override → host.docker.internal → gateway, deduplicated", () => {
    expect(buildCrossBoundaryHosts("10.0.0.9", "172.17.0.1")).toEqual([
      "10.0.0.9",
      "host.docker.internal",
      "172.17.0.1",
    ]);
  });

  it("defaults to host.docker.internal with no override or gateway", () => {
    expect(buildCrossBoundaryHosts(undefined, null)).toEqual(["host.docker.internal"]);
    expect(buildCrossBoundaryHosts("", null)).toEqual(["host.docker.internal"]);
  });

  it("does not duplicate host.docker.internal as an override", () => {
    expect(buildCrossBoundaryHosts("host.docker.internal", "172.17.0.1")).toEqual([
      "host.docker.internal",
      "172.17.0.1",
    ]);
  });
});

describe("filterBridgeAddresses", () => {
  const ipv4 = (address: string): NetworkInterfaceInfo => ({
    address,
    family: "IPv4",
    netmask: "255.255.0.0",
    cidr: `${address}/16`,
    internal: false,
    mac: "02:42:ac:11:00:01",
    scopeid: undefined,
  });

  it("collects IPv4 addresses of docker0, br-*, and podman bridges", () => {
    const ifaces: Record<string, NetworkInterfaceInfo[]> = {
      lo: [ipv4("127.0.0.1")],
      docker0: [ipv4("172.17.0.1")],
      "br-0123456789ab": [ipv4("172.18.0.1")],
      "cni-podman0": [ipv4("10.89.0.1")],
      eth0: [ipv4("192.168.1.5")],
    };
    expect(filterBridgeAddresses(ifaces)).toEqual(["172.17.0.1", "172.18.0.1", "10.89.0.1"]);
  });

  it("keeps IPv4 bridge addresses, ignores IPv6 and LAN interfaces", () => {
    const ifaces: Record<string, NetworkInterfaceInfo[]> = {
      docker0: [{ ...ipv4("172.17.0.1"), family: "IPv6", address: "fe80::1" }, ipv4("172.17.0.1")],
      en0: [ipv4("192.168.1.5")],
    };
    expect(filterBridgeAddresses(ifaces)).toEqual(["172.17.0.1"]);
  });

  it("returns [] when no bridge interfaces exist", () => {
    expect(filterBridgeAddresses({ en0: [ipv4("192.168.1.5")] })).toEqual([]);
  });
});

describe("buildBindHosts", () => {
  it("keeps the primary host first, then bridges, deduplicated", () => {
    expect(buildBindHosts("127.0.0.1", ["172.17.0.1", "172.18.0.1"])).toEqual([
      "127.0.0.1",
      "172.17.0.1",
      "172.18.0.1",
    ]);
  });

  it("returns just the primary when there are no bridges", () => {
    expect(buildBindHosts("127.0.0.1", [])).toEqual(["127.0.0.1"]);
  });

  it("does not duplicate the primary as a bridge", () => {
    expect(buildBindHosts("127.0.0.1", ["127.0.0.1", "172.17.0.1"])).toEqual([
      "127.0.0.1",
      "172.17.0.1",
    ]);
  });
});
