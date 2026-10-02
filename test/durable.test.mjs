import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createOpenShellEnvResolver, SandboxDoc } from "../dist/index.js";
import { LocalSandboxClient } from "./local-client.mjs";

test("Pi Durable's built-in read/write/edit/bash tools use the assigned sandbox", async (t) => {
  const context = BACKGROUND_CONTEXT;
  const cwd = await mkdtemp(join(tmpdir(), "pi-openshell-durable-"));
  const binding = { id: "id", name: "worker", workspace: "default" };
  const client = new LocalSandboxClient(binding);
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
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: createOpenShellEnvResolver({ client, nodePath: process.execPath, tempRoot: cwd }),
    },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    await rm(cwd, { recursive: true, force: true });
  });
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "faux", modelId: "faux-1" } },
      init: async (tx, id) => {
        Object.assign(await tx.doc(SandboxDoc, id), { binding, cwd });
      },
    },
    context,
  );
  const settled = await (
    await conversation.submit({ type: "input", content: "Edit and read the note." }, context)
  ).wait(context);
  assert.equal(settled.status, "done");
  const transcript = await conversation.context(context);
  const toolResults = transcript.messages.filter((message) => message.role === "toolResult");
  assert.equal(toolResults.length, 4);
  assert.equal(
    toolResults.every((message) => !message.isError),
    true,
  );
  const env = await createOpenShellEnvResolver({ client, nodePath: process.execPath, tempRoot: cwd })(
    {
      conversationId: conversation.id,
      read: harness,
    },
    context,
  );
  const contents = await env.readTextFile("note.txt", context);
  assert.equal(contents.ok, true);
  assert.equal(contents.value, "goodbye\n");
  const beforeFork = client.executions.length;
  const fork = await conversation.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
  const forkBinding = await harness.snapshot(SandboxDoc, fork.id, context);
  assert.equal(forkBinding?.binding, undefined);
  await (await fork.submit({ type: "input", content: "Write a file." }, context)).wait(context);
  assert.equal(client.executions.length, beforeFork);
});
