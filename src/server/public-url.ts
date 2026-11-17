// Pages the backend fetches because a listing or a link named them (Find
// jobs' site check, a careers page read for its posting) are on the public
// internet, never on this computer or its network: a listing could otherwise
// name a router's admin page or a service on localhost, and have the backend
// open it (server-side request forgery). Every redirect is checked the same
// way, and so is every address the name resolves to, so a public name that
// points at a private address is refused too.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (hostname: string) => Promise<string[]>;
export const lookupAll: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

// Names that only ever mean this computer or its network.
const privateName = /(^|\.)(localhost|local|internal|intranet|lan|home|home\.arpa|corp|test|example|invalid)$/i;

// Whether an IPv4 address is on this computer, its network, or otherwise
// not on the public internet.
function privateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIPv6(address: string): boolean {
  const plain = address.toLowerCase().replace(/^\[|\]$/g, "");
  // An IPv4 address written as IPv6 ("::ffff:127.0.0.1", "::ffff:7f00:1").
  const mapped = plain.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return privateIPv4(mapped[1]);
    const high = parseInt(mapped[2], 16);
    const low = parseInt(mapped[3], 16);
    return privateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return (
    plain === "::" || plain === "::1" ||
    /^f[cd]/.test(plain) || // unique local
    /^fe[89ab]/.test(plain) || // link local
    /^ff/.test(plain) || // multicast
    /^64:ff9b::/.test(plain) // NAT64, which reaches IPv4 addresses
  );
}

export function privateAddress(address: string): boolean {
  const kind = isIP(address.replace(/^\[|\]$/g, ""));
  if (kind === 4) return privateIPv4(address);
  if (kind === 6) return privateIPv6(address);
  return true;
}

// The address if it is a public web page's (by its scheme and its name or
// literal address), else undefined. Nothing is looked up.
export function publicURL(raw: string, protocols: string[] = ["https:"]): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (!protocols.includes(url.protocol) || url.username || url.password) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? privateAddress(host) : privateName.test(host) || !host.includes(".")) return;
  return url;
}

// Whether every address the name resolves to is public. A literal address
// is judged as it is; a name that does not resolve is not public.
export async function resolvesPublic(url: URL, lookup: Lookup = lookupAll): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((address) => !privateAddress(address));
  } catch {
    return false;
  }
}

// Fetches a public page, following at most `hops` redirects, each one
// checked by name and by address before it is opened. Undefined when any
// step is not public, or a redirect has nowhere to go.
export async function fetchPublic(
  raw: string,
  init: RequestInit,
  options: { fetch?: typeof fetch; lookup?: Lookup; protocols?: string[]; hops?: number } = {},
): Promise<{ response: Response; url: URL } | undefined> {
  const fetcher = options.fetch || fetch;
  let url = publicURL(raw, options.protocols);
  for (let hop = 0; url && hop <= (options.hops ?? 3); hop++) {
    if (!(await resolvesPublic(url, options.lookup))) return;
    const response = await fetcher(url.href, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      url = location ? publicURL(new URL(location, url).href, options.protocols) : undefined;
      continue;
    }
    return { response, url };
  }
}
