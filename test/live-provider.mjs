// Local-only integration test: creates and removes a synthetic provider and
// sandbox. The mock API holds no real model-provider credential or model.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createOpenShellOpenAIProvider, OpenShellExecutionEnv } from "../dist/index.js";
import { connectGateway } from "../examples/connect.mjs";

const client = await connectGateway();
const workspace = process.env.OPENSHELL_WORKSPACE ?? "default";
const workspaceScope = { selection: { case: "workspace", value: workspace } };
const name = `pi-prov-${Date.now().toString(36)}`;
const syntheticKey = `sk-test-${randomUUID()}`;
let received = 0;
let serverFailure;
const text = "OpenShell injected the provider credential";
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`);
    assert.equal(req.url, "/v1/responses");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-4.1-mini");
    assert.equal(payload.stream, true);
    received++;
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
  } catch (error) {
    serverFailure = error;
    res.destroy();
  }
});
server.listen(0, "0.0.0.0");
await once(server, "listening");
const host = "host.openshell.internal";
const port = server.address().port;
const baseUrl = `http://${host}:${port}/v1`;
let sandbox;
let provider;
let env;
let imported = false;
let created = false;
try {
  const importedProfile = await client.raw.importProviderProfiles({
    workspaceScope,
    profiles: [
      {
        profile: {
          id: name,
          displayName: "Pi local model test",
          category: 2,
          inferenceCapable: true,
          credentials: [
            {
              name: "api_key",
              envVars: ["OPENAI_API_KEY"],
              required: true,
              authStyle: "bearer",
              headerName: "authorization",
            },
          ],
          endpoints: [{ host, port, path: "/v1/**", protocol: "rest", access: 2, enforcement: 1 }],
          binaries: [{ path: "/usr/bin/node" }],
        },
      },
    ],
  });
  assert.equal(importedProfile.imported, true);
  imported = true;
  await client.raw.createProvider({
    workspaceScope,
    provider: {
      metadata: { name, workspace },
      type: name,
      profileWorkspace: workspace,
      credentials: { OPENAI_API_KEY: syntheticKey },
    },
  });
  created = true;
  sandbox = await client.sandbox.create({
    workspace,
    name,
    image:
      process.env.OPENSHELL_PROVIDER_TEST_IMAGE ?? "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    providers: [name],
    command: ["/bin/sleep", "infinity"],
    policy: {
      version: 1,
      filesystem: {
        includeWorkdir: true,
        readOnly: ["/usr", "/lib", "/lib64", "/bin", "/etc", "/proc"],
        readWrite: ["/sandbox", "/tmp"],
      },
      landlock: { compatibility: "hard_requirement" },
      process: { runAsUser: "sandbox", runAsGroup: "sandbox" },
    },
  });
  await client.sandbox.waitReady(name, 120, { workspace });
  const binding = { id: sandbox.id, name, workspace };
  env = new OpenShellExecutionEnv({ client: client.sandbox, binding, cwd: "/sandbox" });
  // Observe only a boolean, never return the placeholder or stored key.
  const check = await env.exec(
    `/usr/bin/node -e 'process.exit(process.env.OPENAI_API_KEY?.startsWith("openshell:resolve:env:") ? 0 : 1)'`,
    undefined,
    BACKGROUND_CONTEXT,
  );
  assert.ok(check.ok, check.error?.message);
  assert.equal(check.value.exitCode, 0, "Workload must receive a placeholder, not a stored key");
  provider = createOpenShellOpenAIProvider({
    client: client.sandbox,
    binding,
    baseUrl,
    allowHttp: true,
    timeoutMs: 30_000,
  });
  const models = createModels({
    authContext: {
      async env() {
        throw new Error("Host credential lookup prohibited");
      },
      async fileExists() {
        return false;
      },
    },
  });
  models.setProvider(provider);
  const model = models.getModel("openai", "gpt-4.1-mini");
  const result = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
  });
  if (serverFailure) throw serverFailure;
  assert.notEqual(result.stopReason, "error", result.errorMessage);
  assert.equal(result.content[0].text, text);
  assert.equal(received, 1);
  // Revocation must deny the next request, without reaching the upstream API.
  await client.sandbox.detachProvider(name, name, { workspace });
  for (let attempt = 0; attempt < 30; attempt++) {
    const absent = await env.exec('test -z "$OPENAI_API_KEY"', undefined, BACKGROUND_CONTEXT);
    if (absent.ok && absent.value.exitCode === 0) break;
    if (attempt === 29) throw new Error("Provider detachment did not apply");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const revoked = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello again", timestamp: Date.now() }],
  });
  assert.equal(revoked.stopReason, "error");
  assert.equal(received, 1);
  console.log("Live OpenShell provider injection, Pi Responses streaming and detach revocation passed.");
} finally {
  await provider?.cleanup();
  await env?.cleanup(BACKGROUND_CONTEXT);
  if (sandbox) {
    await client.sandbox.delete(name, { workspace });
    await client.sandbox.waitDeleted(name, 120, { workspace });
  }
  if (created) await client.raw.deleteProvider({ workspaceScope, name });
  if (imported) await client.raw.deleteProviderProfile({ workspaceScope, id: name });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log("Local provider test resources removed.");
}
