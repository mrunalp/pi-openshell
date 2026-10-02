import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { OpenShellExecutionEnv } from "../dist/index.js";
import { connect } from "./connect.mjs";

const context = BACKGROUND_CONTEXT;
const { client, binding, cwd, nodePath } = await connect();
const env = new OpenShellExecutionEnv({ client: client.sandbox, binding, cwd, nodePath });
function value(result) {
  if (!result.ok) throw result.error;
  return result.value;
}
const dir = value(await env.createTempDir("pi-openshell-smoke-", context));
try {
  value(await env.writeFile(`${dir}/note.txt`, "hello\nsecond line", context));
  assert.equal(value(await env.readTextFile(`${dir}/note.txt`, context)), "hello\nsecond line");
  assert.deepEqual(value(await env.readTextLines(`${dir}/note.txt`, { maxLines: 1 }, context)), ["hello"]);
  const bytes = new Uint8Array([0, 10, 128, 255]);
  value(await env.writeFile(`${dir}/binary`, bytes, context));
  assert.deepEqual(value(await env.readBinaryFile(`${dir}/binary`, context)), Buffer.from(bytes));
  const output = [];
  const shell = value(
    await env.exec(
      "printf 'streamed\noutput\n'; exit 7",
      {
        cwd: dir,
        timeout: 10,
        spill: { afterBytes: 1, afterLines: 1 },
        onOutput: (text) => output.push(text),
      },
      context,
    ),
  );
  assert.equal(shell.exitCode, 7);
  assert.equal(output.join(""), "streamed\noutput\n");
  assert.equal(value(await env.readTextFile(shell.spillPath, context)), "streamed\noutput\n");
  value(await env.remove(shell.spillPath, undefined, context));
  const timedOut = await env.exec(
    "(sleep 1; touch timeout-leak) & wait",
    { cwd: dir, timeout: 0.1 },
    context,
  );
  assert.equal(timedOut.ok, false);
  if (timedOut.ok) throw new Error("Expected timeout");
  assert.equal(timedOut.error.code, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(value(await env.exists(`${dir}/timeout-leak`, context)), false);
  console.log(`OpenShell adapter smoke passed against ${binding.workspace}/${binding.name}`);
} finally {
  await env.cleanup(context);
  value(await env.remove(dir, { recursive: true, force: true }, context));
}
