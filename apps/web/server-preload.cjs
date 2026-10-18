"use strict";
/**
 * Preload for the Next.js server: `node -r ./server-preload.cjs server.js`.
 * Rewrites X-Forwarded-For on every incoming request BEFORE Next.js sees it, so the
 * /api proxy forwards a trustworthy client address to the API (see forwarded-for.cjs).
 * Also drops `Forwarded` / `X-Real-IP` from clients. Configure WEB_TRUSTED_PROXY_HOPS=N
 * only when N trusted reverse proxies (that append to XFF) sit in front of the web server.
 */
const http = require("node:http");
const path = require("node:path");
const { normalizeForwardedFor, parseTrustedHops } = require(path.join(__dirname, "forwarded-for.cjs"));

const hops = parseTrustedHops(process.env.WEB_TRUSTED_PROXY_HOPS);
const MARK = Symbol.for("smartcity.xffNormalized");

if (!http.Server.prototype[MARK]) {
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(event, req, ...rest) {
    if (event === "request" && req && req.headers && req.socket) {
      req.headers["x-forwarded-for"] = normalizeForwardedFor(req.headers["x-forwarded-for"], req.socket.remoteAddress, hops);
      delete req.headers["forwarded"];
      delete req.headers["x-real-ip"];
    }
    return origEmit.call(this, event, req, ...rest);
  };
  http.Server.prototype[MARK] = true;
}
// Lets the /api proxy check (same process) that client XFF has been replaced.
globalThis.__smartcityXffNormalized = true;
