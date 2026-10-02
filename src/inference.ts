import type { SandboxBinding, SandboxClient } from "./client.js";
import { decodeBase64 } from "./protocol.js";
import { OpenShellTransport } from "./transport.js";

export interface OpenShellFetchOptions {
  client: SandboxClient;
  binding: SandboxBinding;
  /** Native endpoint authorized by the attached OpenShell provider profile. */
  baseUrl: string;
  credentialEnv?: string;
  nodePath?: string;
  /** For explicitly configured local HTTP services. Hosted providers should use HTTPS. */
  allowHttp?: boolean;
  maxRequestBytes?: number;
  timeoutMs?: number;
}

export type OpenShellFetch = typeof globalThis.fetch & { cleanup(): Promise<void> };

/** Streaming HTTP transport; the provider placeholder never leaves the workload. */
export function createOpenShellFetch(options: OpenShellFetchOptions): OpenShellFetch {
  const endpoint = new URL(options.baseUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" && !(options.allowHttp && endpoint.protocol === "http:"))
  )
    throw new Error("Configure a native HTTPS provider endpoint (or explicitly allow local HTTP)");
  const prefix = endpoint.pathname.replace(/\/$/, "");
  const credentialEnv = options.credentialEnv ?? "OPENAI_API_KEY";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialEnv)) throw new Error("Invalid credential environment name");
  const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 64 * 1024 * 1024)
    throw new Error("maxRequestBytes must be between 1 byte and 64 MiB");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error("timeoutMs must be a positive timer duration");
  const transport = new OpenShellTransport(
    options.client,
    Object.freeze({ ...options.binding }),
    options.nodePath ?? "/usr/bin/node",
    {
      maxFileBytes: maxRequestBytes,
      maxLineBytes: 1024 * 1024,
      maxDirectoryEntries: 10_000,
    },
  );
  const lifecycle = new AbortController();
  let closed = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (closed) throw new Error("OpenShell fetch has been cleaned up");
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== endpoint.origin ||
      (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Model request is outside the configured provider endpoint");
    const signal = AbortSignal.any([request.signal, lifecycle.signal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    // Model payloads are buffered with a hard bound; response/SSE bodies stream.
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      const abort = () => {
        void reader.cancel(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxRequestBytes) throw new Error("Model request body exceeds byte limit");
          chunks.push(chunk.value);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
      }
    }
    const headers = new Headers(request.headers);
    for (const name of [
      "authorization",
      "proxy-authorization",
      "x-api-key",
      "api-key",
      "cookie",
      "host",
      "content-length",
    ])
      headers.delete(name);
    const stream = await transport.start(
      {
        op: "http",
        cwd: "/",
        url: url.href,
        baseUrl: endpoint.href,
        credentialEnv,
        allowHttp: options.allowHttp ?? false,
        method: request.method,
        headers: [...headers],
        body: request.body === null ? null : Buffer.concat(chunks, size).toString("base64"),
      },
      signal,
    );
    let terminal = false;
    try {
      const first = await stream.next();
      if (first.done || first.value.type !== "http-response") {
        if (!first.done && first.value.type === "error") throw new Error(first.value.error.message);
        throw new Error("Missing model HTTP response");
      }
      const metadata = first.value;
      const responseHeaders = new Headers(metadata.headers);
      // Node fetch decompressed the body inside the workload.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.delete("transfer-encoding");
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            for (;;) {
              const item = await stream.next();
              if (item.done) {
                if (!terminal) throw new Error("Incomplete model response");
                controller.close();
                return;
              }
              const frame = item.value;
              if (frame.type === "output" && frame.stream === "stdout" && !terminal) {
                controller.enqueue(decodeBase64(frame.data));
                return;
              }
              if (frame.type === "result" && !terminal) {
                terminal = true;
                continue;
              }
              if (frame.type === "error") throw new Error(frame.error.message);
              throw new Error("Unexpected model response frame");
            }
          } catch (error) {
            await stream.cancel();
            controller.error(error);
          }
        },
        async cancel() {
          await stream.cancel();
        },
      });
      if (request.method === "HEAD" || [204, 205, 304].includes(metadata.status)) {
        // Consume the terminal frame and RPC status even when HTTP has no body.
        await new Response(body).arrayBuffer();
        return new Response(null, {
          status: metadata.status,
          statusText: metadata.statusText,
          headers: responseHeaders,
        });
      }
      return new Response(body, {
        status: metadata.status,
        statusText: metadata.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      await stream.cancel();
      throw error;
    }
  };
  return Object.assign(fetch, {
    async cleanup() {
      closed = true;
      lifecycle.abort(new DOMException("OpenShell fetch has been cleaned up", "AbortError"));
      await transport.cleanup();
    },
  });
}
