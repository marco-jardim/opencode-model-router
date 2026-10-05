import { createServer, type AddressInfo, type Server } from "node:net";

// Undici's Fetch badPorts list, retrieved 2026-10-05:
// https://github.com/nodejs/undici/blob/main/lib/web/fetch/constants.js
// https://fetch.spec.whatwg.org/#port-blocking
export const FETCH_BAD_PORTS = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
] as const;
const badPorts = new Set<number>(FETCH_BAD_PORTS);

export const isFetchSafePort = (port: number): boolean =>
  Number.isInteger(port) && port > 0 && port <= 65535 && !badPorts.has(port);

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(port, "127.0.0.1"); } catch (error) { onError(error); }
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe, 0);
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

// Port 0 is used only for the temporary probe, never as a Fetch destination or
// a host CLI argument. The injectable source makes blocked-port retries testable.
export async function pickFetchSafePort(source: () => Promise<number> = freePort): Promise<number> {
  for (let attempt = 0; attempt < 128; attempt++) {
    const port = await source();
    if (isFetchSafePort(port)) return port;
  }
  throw new Error("Could not find a Fetch-safe free port after 128 probes");
}

export async function listenOnFetchSafePort(server: Server, source = pickFetchSafePort): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = await source();
    if (!isFetchSafePort(port)) throw new Error(`Refusing Fetch-blocked or invalid port ${port}`);
    try {
      return await listen(server, port);
    } catch (error) {
      // Another process may acquire the port between the probe and the bind.
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
  }
  throw new Error("Could not bind a Fetch-safe port after 16 attempts");
}
