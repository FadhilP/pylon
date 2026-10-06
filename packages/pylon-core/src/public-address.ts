import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");

/**
 * Whether an IP literal is publicly routable: not private, loopback, link-local, reserved,
 * documentation, or IPv4-mapped. Brackets and zone ids are stripped before checking.
 */
export function isPublicAddress(address: string, family?: 4 | 6): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").split("%")[0];
  const actual = isIP(normalized);
  if ((family ?? actual) === 4 && actual === 4) return !blockedV4.check(normalized, "ipv4");
  if ((family ?? actual) !== 6 || actual !== 6) return false;
  if (normalized.toLowerCase().startsWith("::ffff:")) return false;
  return globalV6.check(normalized, "ipv6") && !blockedV6.check(normalized, "ipv6");
}
