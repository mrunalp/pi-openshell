// Local-only integration test: creates and removes a synthetic provider and
// two-worker deployment. The mock API holds no real provider credential or model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  createOpenShellEnvResolver,
  createOpenShellOpenAIProvider,
  OpenShellExecutionEnv,
  SandboxDoc,
} from "../dist/index.js";
import { connectGateway, connectManaged } from "../examples/connect.mjs";
import { deleteDeployment } from "../examples/deployment.mjs";

const client = await connectGateway();
const workspace = process.env.OPENSHELL_WORKSPACE ?? "default";
const workspaceScope = { selection: { case: "workspace", value: workspace } };
const name = `pi-prov-${Date.now().toString(36)}`;
const syntheticKey = `sk-test-${randomUUID()}`;
let received = 0;
let attempts = 0;
let serverFailure;
const text = "OpenShell injected the provider credential";
const server = createServer(async (req, res) => {
  try {
    attempts++;
    assert.equal(req.headers.authorization, `Bearer ${syntheticKey}`);
    assert.equal(req.url, "/v1/responses");
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-4.1-mini");
    assert.equal(payload.stream, true);
    const index = received++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tools = [
      ["write", { path: "note.txt", content: "hello\n" }],
      ["edit", { path: "note.txt", oldText: "hello", newText: "goodbye" }],
      ["read", { path: "note.txt" }],
      ["bash", { command: "cat note.txt" }],
    ];
    const tool = tools[index - 1];
    const item = tool
      ? {
          id: `fc_${index}`,
          type: "function_call",
          call_id: `call_${index}`,
          name: tool[0],
          arguments: JSON.stringify(tool[1]),
          status: "completed",
        }
      : {
          id: "msg_test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
    for (const event of [
      { type: "response.created", response: { id: "resp_test" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: tool ? { ...item, arguments: "" } : { ...item, content: [] },
      },
      tool
        ? { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }
        : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
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
const directory = await mkdtemp(join(tmpdir(), "pi-openshell-deployment-"));
const deploymentFile = join(directory, "deployment.json");
const previousDeployment = process.env.OPENSHELL_DEPLOYMENT;
const commandEnv = {
  ...process.env,
  OPENSHELL_DEPLOYMENT: deploymentFile,
  OPENSHELL_INFERENCE_PROVIDER: name,
  OPENSHELL_WORKSPACE: workspace,
};
delete commandEnv.OPENAI_API_KEY;
delete commandEnv.OPENSHELL_SANDBOX;
delete commandEnv.OPENSHELL_INFERENCE_SANDBOX;
if (process.env.OPENSHELL_PROVIDER_TEST_IMAGE) {
  commandEnv.OPENSHELL_CODING_IMAGE = process.env.OPENSHELL_PROVIDER_TEST_IMAGE;
  commandEnv.OPENSHELL_INFERENCE_IMAGE = process.env.OPENSHELL_PROVIDER_TEST_IMAGE;
}
const deployScript = fileURLToPath(new URL("../examples/deploy.mjs", import.meta.url));
let deployment;
let provider;
let env;
let harness;
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
  execFileSync(process.execPath, [deployScript, "create"], { env: commandEnv, stdio: "inherit" });
  deployment = JSON.parse(await readFile(deploymentFile, "utf8"));
  assert.throws(
    () => execFileSync(process.execPath, [deployScript, "create"], { env: commandEnv, stdio: "pipe" }),
    /EEXIST/,
  );
  // Exercise the actual saved-file connection path used to restart the example.
  process.env.OPENSHELL_DEPLOYMENT = deploymentFile;
  const restored = await connectManaged();
  assert.deepEqual(restored.coding, deployment.coding);
  assert.deepEqual(restored.inference, deployment.inference);
  const { coding, inference } = deployment;
  env = new OpenShellExecutionEnv({ client: client.sandbox, ...coding });
  const inferExec = (command) =>
    client.sandbox.exec(inference.binding.name, [inference.nodePath, "--input-type=module", "-e", command], {
      workspace,
      workdir: "/",
      noLoginShell: true,
    });
  // Observe only a boolean, never return the placeholder or stored key.
  const check = await inferExec(
    'process.exit(process.env.OPENAI_API_KEY?.startsWith("openshell:resolve:env:") ? 0 : 1)',
  );
  assert.equal(check.exitCode, 0, "Inference workload must receive a placeholder, not a stored key");
  assert.equal((await client.sandbox.listAllProviders(coding.binding.name, { workspace })).length, 0);
  assert.equal((await client.sandbox.listAllProviders(inference.binding.name, { workspace })).length, 1);
  const noKey = await env.exec('test -z "$OPENAI_API_KEY"', undefined, BACKGROUND_CONTEXT);
  assert.ok(noKey.ok, noKey.error?.message);
  assert.equal(noKey.value.exitCode, 0);
  const blocked = await env.exec(
    `/usr/bin/node --input-type=module -e 'try {await fetch(${JSON.stringify(`${baseUrl}/responses`)}, {signal: AbortSignal.timeout(5000)}); process.exit(1);} catch {}'`,
    { timeout: 10 },
    BACKGROUND_CONTEXT,
  );
  assert.ok(blocked.ok, blocked.error?.message);
  assert.equal(blocked.value.exitCode, 0, "Coding worker must not reach the model endpoint");
  assert.equal(attempts, 0, "Coding request must not reach the upstream API");
  const privateWorkspace = await inferExec(
    'import {readdirSync} from "node:fs"; try {readdirSync("/sandbox"); process.exit(1);} catch (e) {process.exit(["EACCES", "EPERM"].includes(e.code) ? 0 : 2);}',
  );
  assert.equal(privateWorkspace.exitCode, 0, "Inference policy must exclude the coding workspace path");
  provider = createOpenShellOpenAIProvider({
    client: client.sandbox,
    binding: inference.binding,
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
  const registry = createRegistry();
  registry.install(CodingTools);
  harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: createOpenShellEnvResolver({ client: client.sandbox, nodePath: coding.nodePath }),
    },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: "gpt-4.1-mini" } },
      init: async (tx, id) =>
        Object.assign(await tx.doc(SandboxDoc, id), { binding: coding.binding, cwd: coding.cwd }),
    },
    BACKGROUND_CONTEXT,
  );
  const settled = await (
    await conversation.submit(
      { type: "input", content: "Write, edit, read and print the note." },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done");
  const transcript = await conversation.context(BACKGROUND_CONTEXT);
  const results = transcript.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.equal(
    results.every((result) => !result.isError),
    true,
  );
  assert.equal((await env.readTextFile("note.txt", BACKGROUND_CONTEXT)).value, "goodbye\n");
  assert.equal(received, 6);
  assert.equal(attempts, 6);
  if (serverFailure) throw serverFailure;
  await harness.close(BACKGROUND_CONTEXT);
  harness = undefined;
  // Revocation must deny the next request, without reaching the upstream API.
  await client.sandbox.detachProvider(inference.binding.name, name, { workspace });
  for (let attempt = 0; attempt < 30; attempt++) {
    const absent = await inferExec("process.exit(process.env.OPENAI_API_KEY ? 1 : 0)");
    if (absent.exitCode === 0) break;
    if (attempt === 29) throw new Error("Provider detachment did not apply");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const revoked = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello again", timestamp: Date.now() }],
  });
  assert.equal(revoked.stopReason, "error");
  assert.equal(received, 6);
  assert.equal(attempts, 6);
  console.log(
    "Live two-worker deployment passed: coding network denial, inference filesystem isolation, provider injection, Pi model/tool round trips and revocation.",
  );
} finally {
  await harness?.close(BACKGROUND_CONTEXT);
  await provider?.cleanup();
  await env?.cleanup(BACKGROUND_CONTEXT);
  if (deployment) {
    try {
      execFileSync(process.execPath, [deployScript, "delete"], { env: commandEnv, stdio: "inherit" });
      await assert.rejects(readFile(deploymentFile), { code: "ENOENT" });
    } catch (error) {
      await deleteDeployment(client.sandbox, deployment);
      throw error;
    }
  }
  if (created) await client.raw.deleteProvider({ workspaceScope, name });
  if (imported) await client.raw.deleteProviderProfile({ workspaceScope, id: name });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  if (previousDeployment === undefined) delete process.env.OPENSHELL_DEPLOYMENT;
  else process.env.OPENSHELL_DEPLOYMENT = previousDeployment;
  console.log("Local provider test resources removed.");
}
