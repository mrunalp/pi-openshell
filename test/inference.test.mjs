import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { createModels } from "@earendil-works/pi-ai/models";
import { createOpenShellFetch, createOpenShellOpenAIProvider } from "../dist/index.js";
import { LocalSandboxClient } from "./local-client.mjs";

const binding = { id: "inference-uuid", name: "inference", workspace: "default" };
const placeholder = "opaque-workload-placeholder";

async function setup(t, handler, environment = { OPENAI_API_KEY: placeholder }) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req);
    try {
      await handler(req, res);
    } catch (error) {
      res.destroy(error);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new LocalSandboxClient(binding, environment);
  const options = {
    client,
    binding,
    nodePath: process.execPath,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    allowHttp: true,
  };
  const fetch = createOpenShellFetch(options);
  t.after(async () => {
    await fetch.cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(client.children.size, 0);
  });
  return { fetch, client, options, requests };
}

test("HTTP bridge uses only workload credentials and preserves HTTP errors and binary bodies", async (t) => {
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const { fetch, options, client } = await setup(t, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${placeholder}`);
    assert.equal(req.headers["x-api-key"], undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["x-request-id"], "safe-header");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(body, '{"model":"test"}');
    res.writeHead(429, { "content-type": "application/octet-stream", "content-encoding": "gzip" });
    res.end(gzipSync(bytes));
  });
  const response = await fetch(`${options.baseUrl}/responses`, {
    method: "POST",
    body: '{"model":"test"}',
    headers: {
      authorization: "Bearer host-secret",
      "x-api-key": "host-secret",
      cookie: "host-cookie",
      "x-request-id": "safe-header",
    },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(client.executions[0].options.environment, undefined);
});

test("rejects missing providers, stale bindings, URL escapes and oversized request bodies", async (t) => {
  const { fetch, options, client, requests } = await setup(t, (_req, res) => res.end("unexpected"), {});
  await assert.rejects(fetch(`${options.baseUrl}/responses`), /Attach the model provider/);
  const launched = client.executions.length;
  for (const url of [
    "http://example.com/v1/responses",
    `${options.baseUrl}/../outside`,
    `${options.baseUrl}evil/responses`,
  ])
    await assert.rejects(fetch(url), /outside the configured/);
  assert.equal(client.executions.length, launched);
  const limited = createOpenShellFetch({ ...options, maxRequestBytes: 3 });
  t.after(() => limited.cleanup());
  await assert.rejects(
    limited(`${options.baseUrl}/responses`, { method: "POST", body: "1234" }),
    /byte limit/,
  );
  client.binding = { ...binding, id: "replacement-uuid" };
  await assert.rejects(fetch(`${options.baseUrl}/responses`), /binding no longer matches/);
  assert.equal(requests.length, 0);
});

test("streams response bodies before EOF and cancels the upstream request", async (t) => {
  let ended = false;
  let finish;
  const disconnected = new Promise((resolve) => {
    finish = resolve;
  });
  const { fetch, options } = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", () => {
      ended = true;
      finish();
    });
  });
  const controller = new AbortController();
  const response = await fetch(`${options.baseUrl}/responses`, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
  assert.equal(ended, false);
  controller.abort();
  await assert.rejects(reader.read());
  await disconnected;
});

test("redirects do not forward provider credentials to another endpoint", async (t) => {
  const { fetch, options, requests } = await setup(t, (_req, res) => {
    res.writeHead(307, { location: "http://example.com/steal" });
    res.end();
  });
  const response = await fetch(`${options.baseUrl}/responses`);
  assert.equal(response.status, 307);
  await response.text();
  assert.equal(requests.length, 1);
});

test("HEAD responses drain RPC completion and cleanup rejects new requests", async (t) => {
  const { fetch, options } = await setup(t, (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const response = await fetch(`${options.baseUrl}/responses`, { method: "HEAD" });
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  await fetch.cleanup();
  await assert.rejects(fetch(`${options.baseUrl}/responses`), /cleaned up/);
});

test("cleanup aborts buffered request uploads before any remote helper launches", async (t) => {
  const { fetch, options, client, requests } = await setup(t, (_req, res) => res.end("unexpected"));
  let started;
  const buffering = new Promise((resolve) => {
    started = resolve;
  });
  const body = new ReadableStream({
    pull() {
      started();
    },
  });
  const pending = fetch(`${options.baseUrl}/responses`, { method: "POST", body, duplex: "half" });
  await buffering;
  await fetch.cleanup();
  await assert.rejects(pending, /cleaned up/);
  assert.equal(client.executions.length, 0);
  assert.equal(requests.length, 0);
});

test("Pi's real OpenAI Responses provider uses the bridge without host auth or transport fallback", async (t) => {
  const text = "OpenShell model response";
  const { options } = await setup(t, async (req, res) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, `Bearer ${placeholder}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-4.1-mini");
    assert.equal(payload.stream, true);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    for (const event of [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          output: [item],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const provider = createOpenShellOpenAIProvider(options);
  t.after(() => provider.cleanup());
  const models = createModels({
    authContext: {
      async env() {
        throw new Error("Must not read host credentials");
      },
      async fileExists() {
        throw new Error("Must not read host auth files");
      },
    },
  });
  models.setProvider(provider);
  const model = models.getModel("openai", "gpt-4.1-mini");
  assert.ok(model);
  const result = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
    {
      apiKey: "host-secret-to-discard",
      transport: "websocket",
      fetch() {
        throw new Error("Host fetch must not run");
      },
    },
  );
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.equal(result.content[0].text, text);
});
