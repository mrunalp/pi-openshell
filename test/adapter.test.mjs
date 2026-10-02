import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { OpenShellExecutionEnv } from "../dist/index.js";
import { LocalSandboxClient } from "./local-client.mjs";

const context = BACKGROUND_CONTEXT;

function value(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-openshell-test-"));
  const binding = { workspace: "default", name: "worker", id: "test-worker-id" };
  const client = new LocalSandboxClient(binding, { SANDBOX_SENTINEL: "worker-value" });
  const env = new OpenShellExecutionEnv({
    client,
    binding,
    cwd,
    tempRoot: cwd,
    nodePath: process.execPath,
    ...options,
  });
  t.after(async () => {
    await env.cleanup(context);
    await delay(30);
    await rm(cwd, { recursive: true, force: true });
  });
  return { env, client, cwd, binding };
}

test("file operations preserve binary data and treat shell metacharacters as paths", async (t) => {
  const { env, client } = await fixture(t);
  const path = "nested/it's $(touch SHOULD_NOT_EXIST); `false`.bin";
  const bytes = new Uint8Array([0, 1, 10, 127, 128, 255]);
  value(await env.writeFile(path, bytes, context));
  assert.deepEqual(value(await env.readBinaryFile(path, context)), Buffer.from(bytes));
  value(await env.appendFile(path, new Uint8Array([42]), context));
  value(await env.truncateFile(path, 3, context));
  value(await env.flushFile(path, context));
  value(await env.renameFile(path, "nested/renamed.bin", context));
  assert.equal(value(await env.fileInfo("nested/renamed.bin", context)).size, 3);
  assert.equal(value(await env.exists("SHOULD_NOT_EXIST", context)), false);
  assert.equal(
    client.executions.every(({ options }) => options.tty === false && options.noLoginShell === true),
    true,
  );
});

test("directory metadata, canonical paths and temporary files stay in the remote namespace", async (t) => {
  const { env, cwd } = await fixture(t);
  value(await env.createDir("dir", undefined, context));
  value(await env.writeFile("dir/file.txt", "hello", context));
  await symlink(join(cwd, "dir/file.txt"), join(cwd, "link"));
  assert.equal(value(await env.fileInfo("link", context)).kind, "symlink");
  assert.equal(value(await env.canonicalPath("link", context)), join(cwd, "dir/file.txt"));
  assert.equal(value(await env.listDir("dir", context))[0].name, "file.txt");
  const file = value(await env.createTempFile({ prefix: "out-", suffix: ".log" }, context));
  const dir = value(await env.createTempDir("scratch-", context));
  assert.ok(file.startsWith(cwd));
  assert.ok(dir.startsWith(cwd));
  value(await env.remove("dir", { recursive: true }, context));
  assert.equal(value(await env.exists("dir", context)), false);
  assert.equal((await env.createTempFile({ prefix: "../../escape" }, context)).ok, false);
});

test("multi-megabyte binary transfers survive chunked stdin and stdout", async (t) => {
  const { env } = await fixture(t);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0xff);
  value(await env.writeFile("large-binary", bytes, context));
  assert.deepEqual(value(await env.readBinaryFile("large-binary", context)), bytes);
});

test("streaming line reader preserves CRLF and final newline state", async (t) => {
  const { env } = await fixture(t);
  const text = `${"x".repeat(65535)}🙂\r\nsecond\nunterminated`;
  value(await env.writeFile("lines", text, context));
  const reader = value(await env.openTextLineReader("lines", context));
  assert.deepEqual(value(await reader.readLine(context)), {
    text: `${"x".repeat(65535)}🙂\r`,
    terminated: true,
  });
  assert.deepEqual(value(await reader.readLine(context)), { text: "second", terminated: true });
  assert.deepEqual(value(await reader.readLine(context)), { text: "unterminated", terminated: false });
  assert.equal(value(await reader.readLine(context)), undefined);
  assert.equal(value(await reader.readLine(context)), undefined);
  await reader.close(context);
  assert.equal((await reader.readLine(context)).error.code, "invalid");
  assert.deepEqual(value(await env.readTextLines("lines", { maxLines: 1 }, context)), [
    `${"x".repeat(65535)}🙂\r`,
  ]);
});

test("remote filesystem failures are typed and transfers are bounded", async (t) => {
  const { env } = await fixture(t, { maxFileBytes: 1024, maxLineBytes: 10 });
  assert.equal((await env.readTextFile("missing", context)).error.code, "not_found");
  value(await env.createDir("dir", undefined, context));
  assert.equal((await env.readTextFile("dir", context)).error.code, "is_directory");
  assert.equal((await env.writeFile("large", "x".repeat(1025), context)).error.code, "invalid");
  value(await env.exec("head -c 1025 /dev/zero > large", undefined, context));
  assert.equal((await env.readBinaryFile("large", context)).error.code, "invalid");
  value(await env.writeFile("line", "01234567890", context));
  const reader = value(await env.openTextLineReader("line", context));
  assert.equal((await reader.readLine(context)).error.code, "invalid");
});

test("shell output streams before completion and preserves nonzero exits", async (t) => {
  const { env } = await fixture(t);
  let output = "";
  let observedBeforeExit = false;
  const running = env.exec(
    "printf 'first'; sleep 0.2; printf 'second' >&2; exit 7",
    {
      onOutput: (chunk) => {
        output += chunk;
        if (chunk.includes("first")) observedBeforeExit = true;
      },
    },
    context,
  );
  await delay(120);
  assert.equal(observedBeforeExit, true);
  assert.equal(value(await running).exitCode, 7);
  assert.equal(output, "firstsecond");
});

test("only the sandbox environment is inherited, with explicit overrides and clean mode", async (t) => {
  const { env } = await fixture(t);
  process.env.PI_HOST_SECRET = "never-forward";
  t.after(() => {
    delete process.env.PI_HOST_SECRET;
  });
  const outputs = [];
  value(
    await env.exec(
      'printf \'%s|%s|%s\' "$SANDBOX_SENTINEL" "$PI_HOST_SECRET" "$OVERRIDE"',
      {
        env: { OVERRIDE: "extra" },
        onOutput: (chunk) => outputs.push(chunk),
      },
      context,
    ),
  );
  assert.equal(outputs.join(""), "worker-value||extra");
  outputs.length = 0;
  value(
    await env.exec(
      'printf \'%s|%s\' "$SANDBOX_SENTINEL" "$OVERRIDE"',
      {
        inheritEnv: false,
        env: { OVERRIDE: "clean" },
        onOutput: (chunk) => outputs.push(chunk),
      },
      context,
    ),
  );
  assert.equal(outputs.join(""), "|clean");
});

test("spill files contain complete raw output and stay readable through the adapter", async (t) => {
  const { env, cwd } = await fixture(t);
  const output = [];
  const result = value(
    await env.exec(
      "printf 'alpha\nbeta\ngamma\n'",
      {
        spill: { afterBytes: 5, afterLines: 1 },
        onOutput: (chunk) => output.push(chunk),
      },
      context,
    ),
  );
  assert.ok(result.spillPath.startsWith(cwd));
  assert.equal(value(await env.readTextFile(result.spillPath, context)), "alpha\nbeta\ngamma\n");
  assert.equal(output.join(""), "alpha\nbeta\ngamma\n");
});

test("timeout terminates descendants and retains the spill path", async (t) => {
  const { env, cwd } = await fixture(t);
  const result = await env.exec(
    "printf 'before-timeout'; (sleep 1; touch escaped) & wait",
    {
      timeout: 0.1,
      spill: { afterBytes: 1, afterLines: 1 },
    },
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.ok(result.error.spillPath.startsWith(cwd));
  await delay(1100);
  assert.equal(value(await env.exists("escaped", context)), false);
  assert.equal(value(await env.readTextFile(result.error.spillPath, context)), "before-timeout");
});

test("cancellation and cleanup stop remote work", async (t) => {
  const { env } = await fixture(t);
  const controller = new AbortController();
  const started = new Promise((resolve) => {
    const running = env.exec(
      "echo started; (sleep 1; touch cancelled-leak) & wait",
      {
        onOutput: () => {
          controller.abort();
          resolve(running);
        },
      },
      { ...context, abortSignal: controller.signal },
    );
  });
  assert.equal((await started).error.code, "aborted");
  const second = env.exec(
    "echo ready; (sleep 1; touch cleanup-leak) & wait",
    {
      onOutput: () => {
        void env.cleanup(context);
      },
    },
    context,
  );
  assert.equal((await second).ok, false);
  await delay(1100);
  assert.equal(value(await env.exists("cancelled-leak", context)), false);
  assert.equal(value(await env.exists("cleanup-leak", context)), false);
});

test("callback errors terminate remote execution", async (t) => {
  const { env } = await fixture(t);
  const result = await env.exec(
    "echo started; (sleep 1; touch callback-leak) & wait",
    {
      onOutput: () => {
        throw new Error("consumer failed");
      },
    },
    context,
  );
  assert.equal(result.error.code, "callback_error");
  await delay(1100);
  assert.equal(value(await env.exists("callback-leak", context)), false);
});

test("a stale sandbox binding never launches a helper", async (t) => {
  const { env, client } = await fixture(t);
  client.binding = { ...client.binding, id: "replacement" };
  assert.equal((await env.writeFile("file", "data", context)).ok, false);
  assert.equal(client.executions.length, 0);
});

test("namespace identity is stable across working directories", async (t) => {
  const { env, client, binding, cwd } = await fixture(t);
  const other = new OpenShellExecutionEnv({ client, binding, cwd: join(cwd, "subdirectory") });
  assert.equal(env.id, other.id);
  assert.equal(value(await env.absolutePath("../file", context)), join(cwd, "../file"));
});

test("transport loss and malformed responses never report successful execution", async () => {
  for (const response of [
    [{ version: 1, type: "result", value: null }],
    [
      { version: 1, type: "result", value: null },
      { version: 1, type: "result", value: null },
    ],
    [{ version: 99, type: "result", value: null }],
  ]) {
    const client = {
      async get() {
        return { id: "id", name: "worker", workspace: "default" };
      },
      async execInteractive() {
        return {
          output: (async function* () {
            yield {
              stream: "stdout",
              data: Buffer.from(response.map((frame) => JSON.stringify(frame)).join("\n") + "\n"),
            };
          })(),
          done: Promise.resolve(0),
          write() {},
          closeInput() {},
          cancel() {},
        };
      },
    };
    const env = new OpenShellExecutionEnv({
      client,
      binding: { id: "id", name: "worker", workspace: "default" },
      cwd: "/sandbox",
    });
    assert.equal((await env.writeFile("file", "data", context)).ok, false);
  }
});

test("already-aborted calls do not launch work", async (t) => {
  const { env, client } = await fixture(t);
  const aborted = { ...context, abortSignal: AbortSignal.abort() };
  assert.equal((await env.exec("touch unexpected", undefined, aborted)).error.code, "aborted");
  assert.equal((await env.readTextFile("file", aborted)).error.code, "aborted");
  assert.equal(client.executions.length, 0);
});
