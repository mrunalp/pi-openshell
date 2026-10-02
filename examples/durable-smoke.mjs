import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createOpenShellEnvResolver, OpenShellExecutionEnv, SandboxDoc } from "../dist/index.js";
import { connect } from "./connect.mjs";

// The model is deterministic; the SDK, sandbox, harness, and coding tools are real.
const context = BACKGROUND_CONTEXT;
const { client, binding, cwd, nodePath } = await connect();
const env = new OpenShellExecutionEnv({ client: client.sandbox, binding, cwd, nodePath });
function value(result) {
  if (!result.ok) throw result.error;
  return result.value;
}
const dir = value(await env.createTempDir("pi-openshell-durable-", context));
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(CodingTools);
const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
faux.setResponses([
  tool("write", { path: "note.txt", content: "hello\n" }),
  tool("edit", { path: "note.txt", oldText: "hello", newText: "goodbye" }),
  tool("read", { path: "note.txt" }),
  tool("bash", { command: "cat note.txt" }),
  fauxAssistantMessage("Done."),
  tool("write", { path: "should-not-exist", content: "forbidden" }),
  fauxAssistantMessage("No environment."),
]);
let harness;
try {
  harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: createOpenShellEnvResolver({ client: client.sandbox, nodePath }) },
    context,
  );
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: "faux-1" } },
      init: async (tx, id) => Object.assign(await tx.doc(SandboxDoc, id), { binding, cwd: dir }),
    },
    context,
  );
  const settled = await (
    await conversation.submit({ type: "input", content: "Edit and read the note." }, context)
  ).wait(context);
  assert.equal(settled.status, "done");
  const transcript = await conversation.context(context);
  const results = transcript.messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.equal(
    results.every((message) => !message.isError),
    true,
  );
  assert.equal(value(await env.readTextFile(`${dir}/note.txt`, context)), "goodbye\n");
  const fork = await conversation.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
  assert.equal((await harness.snapshot(SandboxDoc, fork.id, context))?.binding, undefined);
  await (await fork.submit({ type: "input", content: "Write a file." }, context)).wait(context);
  const forkTranscript = await fork.context(context);
  const forkResults = forkTranscript.messages.filter((message) => message.role === "toolResult");
  assert.equal(forkResults.at(-1)?.isError, true);
  assert.equal(value(await env.exists(`${dir}/should-not-exist`, context)), false);
  console.log(
    `Pi Durable read/write/edit/bash and unbound fork passed against ${binding.workspace}/${binding.name}`,
  );
} finally {
  if (harness) await harness.close(context);
  await env.cleanup(context);
  value(await env.remove(dir, { recursive: true, force: true }, context));
}
