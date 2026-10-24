// Transport — the single place where the plugin touches the network.
//
//   * Desktop ("node"): Node's http/https, exactly as before. Runs in the
//     Electron renderer with Node integration, so there is no browser CORS and
//     loopback requests ignore the system proxy.
//   * Mobile ("fetch"): window.fetch with a streamed response body, so replies
//     still arrive token by token. This needs the gateway to allow the Obsidian
//     app origin via CORS (API_SERVER_CORS_ORIGINS, e.g. capacitor://localhost).
//     If fetch fails outright (CORS not configured, network error) the request
//     is retried once through Obsidian's requestUrl, which needs no CORS but
//     cannot stream: the reply then arrives in one piece.
//
// Node modules are only required lazily inside the desktop transport, so this
// file loads fine on iOS/Android where they do not exist.

import { requestUrl } from "obsidian";

export interface HttpRequestOptions {
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** UTF-8 request body (JSON). Content-Length is added by the transport. */
  body?: string;
  /** Idle timeout in ms: fail when no response bytes arrive for this long. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Response headers with lower-cased names. */
  headers: Record<string, string>;
  body: string;
}

export interface StreamHandlers {
  onResponse(status: number, headers: Record<string, string>): void;
  onData(text: string): void;
  onEnd(): void;
  onError(err: Error): void;
}

export interface Abortable {
  /** Cancel the request. No handler is called afterwards. */
  destroy(): void;
}

export interface Transport {
  readonly name: "node" | "fetch";
  stream(url: string, opts: HttpRequestOptions, handlers: StreamHandlers): Abortable;
}

/** Error raised when a request exceeds its idle timeout. */
export function isTimeoutError(err: unknown): boolean {
  return (err as Error | undefined)?.name === "TimeoutError";
}

function timeoutError(): Error {
  const err = new Error("request timed out");
  err.name = "TimeoutError";
  return err;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function lowerKeys(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** Collect a whole (non-streaming) response. */
export function requestOnce(
  transport: Transport,
  url: string,
  opts: HttpRequestOptions
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    transport.stream(url, opts, {
      onResponse: (s, h) => {
        status = s;
        headers = h;
      },
      onData: (t) => {
        body += t;
      },
      onEnd: () => resolve({ status, headers, body }),
      onError: reject
    });
  });
}

// ---- desktop: Node http/https ---------------------------------------------

type NodeHttp = typeof import("http");

export function createNodeTransport(): Transport {
  const load = (url: string): NodeHttp =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (url.startsWith("https") ? require("https") : require("http")) as NodeHttp;

  return {
    name: "node",
    stream(url, opts, h) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body, "utf-8"));
      let done = false;
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        h.onError(err);
      };
      const req = load(url).request(
        url,
        { method: opts.method, headers, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) },
        (res) => {
          if (done) return;
          h.onResponse(res.statusCode || 0, lowerKeys(res.headers as Record<string, unknown>));
          res.on("data", (chunk: Buffer) => {
            if (!done) h.onData(chunk.toString());
          });
          res.on("end", () => {
            if (done) return;
            done = true;
            h.onEnd();
          });
          res.on("error", (err) => fail(err));
        }
      );
      req.on("error", (err) => fail(err));
      req.on("timeout", () => {
        req.destroy();
        fail(timeoutError());
      });
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
      return {
        destroy: () => {
          done = true;
          req.destroy();
        }
      };
    }
  };
}

// ---- mobile: fetch (streaming) with requestUrl fallback ---------------------

export function createFetchTransport(): Transport {
  return {
    name: "fetch",
    stream(url, opts, h) {
      const ctrl = new AbortController();
      let done = false;
      let timer: number | undefined;

      const clear = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      };
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clear();
        fn();
      };
      const arm = () => {
        if (!opts.timeoutMs || done) return;
        clear();
        timer = window.setTimeout(() => {
          if (done) return;
          ctrl.abort();
          finish(() => h.onError(timeoutError()));
        }, opts.timeoutMs);
      };

      const viaRequestUrl = async () => {
        // No CORS and no streaming: the whole body arrives at once.
        clear();
        try {
          const r = await requestUrl({
            url,
            method: opts.method,
            headers: opts.headers,
            ...(opts.body !== undefined ? { body: opts.body, contentType: "application/json" } : {}),
            throw: false
          });
          if (done) return;
          h.onResponse(r.status, lowerKeys(r.headers));
          if (r.text) h.onData(r.text);
          finish(() => h.onEnd());
        } catch (e) {
          finish(() => h.onError(asError(e)));
        }
      };

      void (async () => {
        arm();
        let res: Response;
        try {
          res = await fetch(url, {
            method: opts.method,
            headers: opts.headers,
            ...(opts.body !== undefined ? { body: opts.body } : {}),
            signal: ctrl.signal
          });
        } catch {
          if (done) return;
          await viaRequestUrl();
          return;
        }
        if (done) return;
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        h.onResponse(res.status, headers);
        arm();
        try {
          if (!res.body) {
            const text = await res.text();
            if (!done && text) h.onData(text);
            finish(() => h.onEnd());
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done: eof } = await reader.read();
            if (done) return;
            if (eof) break;
            arm();
            const text = decoder.decode(value, { stream: true });
            if (text) h.onData(text);
          }
          const tail = decoder.decode();
          if (tail && !done) h.onData(tail);
          finish(() => h.onEnd());
        } catch (e) {
          finish(() => h.onError(asError(e)));
        }
      })();

      return {
        destroy: () => {
          done = true;
          clear();
          ctrl.abort();
        }
      };
    }
  };
}
