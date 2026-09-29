// Preloaded with `node --import` into spawned Debrief processes: any attempt to open a
// network connection, resolve a name or fetch a URL is logged to $DEBRIEF_NETWORK_LOG and
// fails. Stdio pipes are not network connections and are unaffected.
//
// $DEBRIEF_NETWORK_ALLOW (comma-separated `host:port`) lets connections and fetches to exactly
// those endpoints through, and nothing else: the Jev tests allow the localhost stub of TypeSafe's
// API and prove that Debrief connects to it alone. Names are never resolved, so an entry is an IP.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const log = process.env.DEBRIEF_NETWORK_LOG;
const allowed = new Set((process.env.DEBRIEF_NETWORK_ALLOW ?? "").split(",").filter(Boolean));

function refuse(what) {
  if (log) appendFileSync(log, `${what}\n`);
  throw new Error(`network access blocked in test: ${what}`);
}
function blocked(what) {
  return function () {
    refuse(what);
  };
}
/** `host:port` of a net/tls connect call's arguments (an options object, `port, host`, or Node's normalized array), or null for an IPC path. */
function endpointOf(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") return first.path !== undefined ? null : `${first.host ?? "localhost"}:${first.port}`;
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) return `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
  return null;
}
/** Calls through for an allowed endpoint; refuses (and logs) everything else. */
function guarded(what, original) {
  return function (...args) {
    const endpoint = endpointOf(args);
    if (endpoint !== null && allowed.has(endpoint)) return original.apply(this, args);
    refuse(what);
  };
}

const originalFetch = globalThis.fetch;
net.Socket.prototype.connect = guarded("net.Socket.connect", net.Socket.prototype.connect);
net.connect = net.createConnection = guarded("net.connect", net.connect);
tls.connect = guarded("tls.connect", tls.connect);
http.request = http.get = blocked("http.request");
https.request = https.get = blocked("https.request");
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns[fn] = blocked(`dns.${fn}`);
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns.promises[fn] = blocked(`dns.promises.${fn}`);
http2.connect = blocked("http2.connect");
globalThis.fetch = function (input, init) {
  let endpoint = null;
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    endpoint = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    // Not a URL: refused below.
  }
  if (endpoint !== null && allowed.has(endpoint)) return originalFetch(input, init);
  refuse("fetch");
};
