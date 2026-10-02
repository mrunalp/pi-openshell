import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createOpenShellEnvResolver, createOpenShellOpenAIProvider, SandboxDoc } from "../dist/index.js";
import { connect } from "./connect.mjs";

const context = BACKGROUND_CONTEXT;
const { client, binding, cwd, nodePath } = await connect();
const modelId = process.env.PI_MODEL;
if (!modelId) throw new Error("Set PI_MODEL to an OpenAI model ID and attach an OpenShell model provider");
const models = createModels();
const provider = createOpenShellOpenAIProvider({ client: client.sandbox, binding, nodePath });
models.setProvider(provider);
const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
  await openNodeSqliteStorage(process.env.PI_STORAGE ?? "./agent.sqlite"),
  {
    models,
    registry,
    env: createOpenShellEnvResolver({ client: client.sandbox, nodePath }),
  },
  context,
);

try {
  const conversation = await harness.root(context, {
    agent: { model: { provider: "openai", modelId } },
    init: async (tx, id) => {
      Object.assign(await tx.doc(SandboxDoc, id), { binding, cwd });
    },
  });
  // On reopen, existing documents are retained: refuse accidental rebinding.
  const recorded = await harness.snapshot(SandboxDoc, conversation.id, context);
  if (recorded?.binding?.id !== binding.id || recorded.binding.workspace !== binding.workspace) {
    throw new Error("Stored conversation belongs to another sandbox; use a different PI_STORAGE file");
  }
  const watch = await conversation.watch(context);
  watch.start(async (view) => {
    process.stdout.write(`${JSON.stringify(view)}\n`);
  });
  try {
    harness.resume();
    const prompt =
      process.argv.slice(2).join(" ") || "Inspect the working directory and report what you find.";
    const settled = await (await conversation.submit({ type: "input", content: prompt }, context)).wait(
      context,
    );
    console.log(`Submission ${settled.id}: ${settled.status}`);
  } finally {
    await watch.stop();
  }
} finally {
  try {
    await harness.close(context);
  } finally {
    await provider.cleanup();
  }
}
