// Preloaded with `node --import` into spawned Debrief processes: any attempt to open a
// network connection, resolve a name or fetch a URL is logged to $DEBRIEF_NETWORK_LOG and
// fails. Stdio pipes are not network connections and are unaffected.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const log = process.env.DEBRIEF_NETWORK_LOG;
function blocked(what) {
  return function () {
    if (log) appendFileSync(log, `${what}\n`);
    throw new Error(`network access blocked in test: ${what}`);
  };
}
net.Socket.prototype.connect = blocked("net.Socket.connect");
net.connect = net.createConnection = blocked("net.connect");
tls.connect = blocked("tls.connect");
http.request = http.get = blocked("http.request");
https.request = https.get = blocked("https.request");
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns[fn] = blocked(`dns.${fn}`);
for (const fn of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) dns.promises[fn] = blocked(`dns.promises.${fn}`);
http2.connect = blocked("http2.connect");
globalThis.fetch = blocked("fetch");
