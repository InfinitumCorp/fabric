// The network an address sits in, for limits that one person could otherwise dodge by moving
// across neighbouring addresses: an IPv4 /24, or an IPv6 /48 (what one site is usually given).

import net from 'node:net';

/** Expand an IPv6 address to its 8 groups. */
function groups6(ip) {
  const [head, tail = null] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === null ? [] : (tail ? tail.split(':') : []);
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** '203.0.113.7' -> '203.0.113.0/24'; '2001:db8:5:1::9' -> '2001:db8:5::/48'; anything else as is. */
export function netblock(ip) {
  let a = String(ip || '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(a) && !a.includes('.')) return `${groups6(a).slice(0, 3).join(':')}::/48`;
  return a;
}

/** Loopback: tests, and a relay whose proxy isn't trusted, where every client looks the same. */
export function isLoopback(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}
