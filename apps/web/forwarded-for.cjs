"use strict";
/**
 * X-Forwarded-For normalisation for the web server (P2-2: rate-limit spoofing).
 *
 * Next.js only sets `x-forwarded-for` when it is absent, so a client-supplied header would
 * pass through the /api proxy to the API (which rate-limits by the last XFF hop). This
 * function computes the single client address the API may trust:
 *   - trustedHops = 0 (default): the TCP peer address; any client XFF is discarded.
 *   - trustedHops = N > 0: the web server sits behind N trusted reverse proxies; each appends
 *     the address it received the request from. The chain is [...XFF, socket peer]; the last
 *     N entries are our proxies, the entry just before them is the client.
 * Invalid entries fall back to the socket peer. The result is always one address.
 */

const MAX_HOPS = 10;

function stripIpv4Mapped(ip) {
  return ip.startsWith("::ffff:") && /^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip.slice(7) : ip;
}

function isIp(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split(".").every((p) => Number(p) <= 255);
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

function parseTrustedHops(raw) {
  const n = Number.parseInt(String(raw ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_HOPS) : 0;
}

/**
 * @param {string | string[] | undefined} header incoming x-forwarded-for
 * @param {string | undefined} remoteAddress socket peer
 * @param {number} trustedHops number of trusted reverse proxies in front of this server
 * @returns {string} single client address ("unknown" if nothing usable)
 */
function normalizeForwardedFor(header, remoteAddress, trustedHops) {
  const peer = remoteAddress ? stripIpv4Mapped(String(remoteAddress).trim()) : "";
  const fallback = isIp(peer) ? peer : "unknown";
  const hops = parseTrustedHops(trustedHops);
  if (hops === 0) return fallback;
  const raw = Array.isArray(header) ? header.join(",") : String(header ?? "");
  const chain = raw
    .split(",")
    .map((s) => stripIpv4Mapped(s.trim()))
    .filter((s) => s.length > 0)
    .slice(-64);
  chain.push(peer);
  const idx = chain.length - 1 - hops;
  if (idx < 0) return fallback; // fewer hops than configured: do not trust anything client-controlled
  const client = chain[idx];
  return isIp(client) ? client : fallback;
}

module.exports = { normalizeForwardedFor, parseTrustedHops, isIp };
