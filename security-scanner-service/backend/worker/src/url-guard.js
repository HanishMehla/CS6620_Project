// Blocks pentest scans that target private or internal IP addresses (SSRF protection).
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const ipv4ToInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const inRange = (ip, base, bits) => {
  const size = 2 ** (32 - bits);
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
};

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
];

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some(([base, bits]) => inRange(ip, base, bits));
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  return lower === '::1' || lower === '::' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

// Resolve hostname at scan time to catch DNS rebinding
export async function assertSafeTarget(targetUrl, resolve = (host) => lookup(host, { all: true })) {
  const { protocol, hostname } = new URL(targetUrl);
  if (!['http:', 'https:'].includes(protocol)) throw new PermanentError('Only http and https are allowed');
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host);
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new PermanentError(`Target resolves to a blocked address: ${address}`);
  }
}

export class PermanentError extends Error {}
