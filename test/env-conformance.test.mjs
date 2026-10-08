import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { OpenShellExecutionEnv } from "../dist/index.js";
import { LocalSandboxClient } from "./local-client.mjs";

const cases = createEnvConformance({
  assertions: {
    ok: assert.ok,
    strictEqual: assert.strictEqual,
    deepEqual: assert.deepStrictEqual,
    partialDeepEqual: assert.partialDeepStrictEqual,
    greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
    rejects: async (operation, messageIncludes) => {
      await assert.rejects(operation, (error) => error.message.includes(messageIncludes));
    },
  },
  withEnv: async (use) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-openshell-conformance-"));
    const binding = { workspace: "default", name: "worker", id: "conformance-worker" };
    const client = new LocalSandboxClient(binding);
    const env = new OpenShellExecutionEnv({
      client,
      binding,
      cwd,
      tempRoot: cwd,
      nodePath: process.execPath,
    });
    try {
      await use(env);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
      assert.equal(client.children.size, 0, "Cleanup must reap every remote helper");
      await rm(cwd, { recursive: true, force: true });
    }
  },
});

for (const entry of cases) {
  test(entry.name, { timeout: entry.timeoutMs ?? 30_000 }, entry.run);
}
