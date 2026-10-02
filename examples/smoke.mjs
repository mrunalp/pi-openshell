import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { OpenShellExecutionEnv } from "../dist/index.js";
import { connect } from "./connect.mjs";

const context = BACKGROUND_CONTEXT;
const { client, binding, cwd, nodePath } = await connect();
const setup = new OpenShellExecutionEnv({ client: client.sandbox, binding, cwd, nodePath });
function value(result) {
  if (!result.ok) throw result.error;
  return result.value;
}
const dir = value(await setup.createTempDir("pi-openshell-smoke-", context));
const env = new OpenShellExecutionEnv({ client: client.sandbox, binding, cwd: dir, nodePath, tempRoot: dir });
try {
  value(await env.writeFile(`${dir}/note.txt`, "hello\nsecond line", context));
  assert.equal(value(await env.readTextFile(`${dir}/note.txt`, context)), "hello\nsecond line");
  assert.deepEqual(value(await env.readTextLines(`${dir}/note.txt`, { maxLines: 1 }, context)), ["hello"]);
  const bytes = new Uint8Array([0, 10, 128, 255]);
  value(await env.writeFile(`${dir}/binary`, bytes, context));
  assert.deepEqual(value(await env.readBinaryFile(`${dir}/binary`, context)), Buffer.from(bytes));
  const large = Buffer.alloc(2 * 1024 * 1024, 0xa5);
  value(await env.writeFile(`${dir}/large ' file`, large, context));
  assert.deepEqual(value(await env.readBinaryFile(`${dir}/large ' file`, context)), large);
  const stdinOutput = [];
  const stdin = value(
    await env.exec(
      "if IFS= read -r line; then exit 1; else printf eof; fi",
      { timeout: 5, onOutput: (text) => stdinOutput.push(text) },
      context,
    ),
  );
  assert.equal(stdin.exitCode, 0);
  assert.equal(stdinOutput.join(""), "eof");
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
  const controller = new AbortController();
  const cancelled = await env.exec(
    "echo started; (sleep 2; touch cancelled-leak) & wait",
    { cwd: dir, onOutput: () => controller.abort(), timeout: 10 },
    { ...context, abortSignal: controller.signal },
  );
  assert.equal(cancelled.ok, false);
  if (cancelled.ok) throw new Error("Expected cancellation");
  assert.equal(cancelled.error.code, "aborted");
  const callbackFailed = await env.exec(
    "echo started; (sleep 2; touch callback-leak) & wait",
    {
      timeout: 10,
      onOutput: () => {
        throw new Error("consumer failed");
      },
    },
    context,
  );
  assert.equal(callbackFailed.ok, false);
  if (callbackFailed.ok) throw new Error("Expected callback failure");
  assert.equal(callbackFailed.error.code, "callback_error");
  const cleaned = await env.exec(
    "echo started; (sleep 2; touch cleanup-leak) & wait",
    {
      timeout: 10,
      onOutput: () => {
        void env.cleanup(context);
      },
    },
    context,
  );
  assert.equal(cleaned.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(value(await env.exists(`${dir}/timeout-leak`, context)), false);
  assert.equal(value(await env.exists(`${dir}/cancelled-leak`, context)), false);
  assert.equal(value(await env.exists(`${dir}/callback-leak`, context)), false);
  assert.equal(value(await env.exists(`${dir}/cleanup-leak`, context)), false);
  console.log(`OpenShell adapter smoke passed against ${binding.workspace}/${binding.name}`);
} finally {
  await env.cleanup(context);
  value(await env.remove(dir, { recursive: true, force: true }, context));
  await setup.cleanup(context);
}
