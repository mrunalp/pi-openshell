// This module is sent through gateway exec and runs only inside the sandbox.
// Pi's filesystem helpers are bundled at build time; no packages are needed in
// the sandbox, and this module never resolves a harness-host path.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const MAX_REQUEST_BYTES = 96 * 1024 * 1024;

async function emit(frame) {
  if (!process.stdout.write(`${JSON.stringify({ version: 1, ...frame })}\n`)) {
    await once(process.stdout, "drain");
  }
}

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function serializeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "unknown",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.path === "string" ? { path: error.path } : {}),
    ...(typeof error?.spillPath === "string" ? { spillPath: error.spillPath } : {}),
  };
}

function prefix(value, fallback) {
  value ??= fallback;
  if (typeof value !== "string" || value.length > 128 || value.includes("/") || value.includes("\0")) {
    throw failure("invalid", "Temporary file prefix/suffix must be a filename fragment");
  }
  return value;
}

async function tempFile(root, options = {}) {
  const dir = await mkdtemp(join(root, "pi-openshell-"));
  const path = join(dir, `${prefix(options.prefix, "")}${randomUUID()}${prefix(options.suffix, "")}`);
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return path;
}

async function readLimited(path, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > maxBytes) throw failure("invalid", `File exceeds ${maxBytes} byte limit`, { path });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("base64");
}

async function info(path) {
  const stat = await lstat(path);
  const kind = stat.isFile()
    ? "file"
    : stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : undefined;
  if (kind === undefined) throw failure("not_supported", "Unsupported file kind", { path });
  return { name: basename(path), path, kind, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function lines(request) {
  const path = resolve(request.cwd, request.path);
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (stat.isDirectory()) throw failure("EISDIR", "Cannot read a directory", { path });
    await emit({ type: "ready" });
    const decoder = new TextDecoder();
    let buffered = "";
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      buffered +=
        bytesRead === 0 ? decoder.decode() : decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const text = buffered.slice(0, newline);
        if (Buffer.byteLength(text) > request.limits.maxLineBytes)
          throw failure("invalid", "Line exceeds byte limit", { path });
        await emit({ type: "line", data: Buffer.from(text).toString("base64"), terminated: true });
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered) > request.limits.maxLineBytes)
        throw failure("invalid", "Line exceeds byte limit", { path });
      if (bytesRead === 0) break;
    }
    if (buffered !== "")
      await emit({ type: "line", data: Buffer.from(buffered).toString("base64"), terminated: false });
    await emit({ type: "result", value: null });
  } finally {
    await file.close();
  }
}

async function filesystem(request) {
  const path = request.path === undefined ? undefined : resolve(request.cwd, request.path);
  switch (request.op) {
    case "read":
      return readLimited(path, request.limits.maxFileBytes);
    case "write":
    case "append": {
      const content = Buffer.from(request.data, "base64");
      if (content.length > request.limits.maxFileBytes)
        throw failure("invalid", "Write exceeds file byte limit", { path });
      await mkdir(dirname(path), { recursive: true });
      if (request.op === "write") await writeFile(path, content);
      else await appendFile(path, content);
      return null;
    }
    case "truncate":
    case "flush": {
      const file = await open(path, "r+");
      try {
        if (request.op === "truncate") await file.truncate(request.size);
        else await file.sync();
      } finally {
        await file.close();
      }
      return null;
    }
    case "rename":
      await rename(path, resolve(request.cwd, request.destination));
      return null;
    case "info":
      return info(path);
    case "list": {
      const names = await readdir(path);
      if (names.length > request.limits.maxDirectoryEntries)
        throw failure("invalid", "Directory exceeds entry limit", { path });
      const result = [];
      for (const name of names) result.push(await info(join(path, name)));
      return result;
    }
    case "canonical":
      return realpath(path);
    case "mkdir":
      await mkdir(path, { recursive: request.recursive ?? true });
      return null;
    case "remove":
      await rm(path, { recursive: request.recursive ?? false, force: request.force ?? false });
      return null;
    case "temp-dir":
      return mkdtemp(join(request.tempRoot, prefix(request.prefix, "tmp-")));
    case "temp-file":
      return tempFile(request.tempRoot, request.options);
    default:
      throw failure("invalid", "Unknown filesystem operation");
  }
}

async function shell(request, controlSignal) {
  const options = request.options;
  let child;
  let timedOut = false;
  let aborted = false;
  let writeError;
  let spillPath;
  let spillFile;
  let totalBytes = 0;
  let newlines = 0;
  const prefixChunks = [];
  let pending = Promise.resolve();
  let pendingCount = 0;
  let groupBirth;
  const proc = (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return { group: Number(fields[2]), birth: BigInt(fields[19]) };
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return undefined;
      throw error;
    }
  };
  const signalMember = (pid, signal) => {
    const identity = proc(pid);
    if (!identity || identity.group !== child.pid || identity.birth < groupBirth) return;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const killTree = () => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error) {
      if (error.code === "ESRCH") return;
      if (error.code !== "EPERM") throw error;
    }
    // OpenShell denies group/broadcast signals. Freeze and then kill members
    // individually through its broker. A live PGID cannot be reused; reject a
    // replacement leader and processes born before this shell's identity.
    const leader = proc(child.pid);
    if (groupBirth === undefined || (leader && leader.birth !== groupBirth)) return;
    const members = new Set();
    for (let pass = 0; pass < 8; pass++) {
      const previous = members.size;
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        const identity = proc(pid);
        if (identity?.group !== child.pid || identity.birth < groupBirth) continue;
        signalMember(pid, "SIGSTOP");
        members.add(pid);
      }
      if (members.size === previous) break;
    }
    for (const pid of members) if (pid !== child.pid) signalMember(pid, "SIGKILL");
    if (members.has(child.pid)) signalMember(child.pid, "SIGKILL");
  };
  const abort = () => {
    aborted = true;
    killTree();
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.on(signal, abort);
  controlSignal.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    if (controlSignal.aborted) throw failure("aborted", "Command aborted");
    // Process metadata is required for the broker's positive-PID signal path.
    readdirSync("/proc");
    if (!proc(process.pid))
      throw failure("not_supported", "Shell cleanup requires readable /proc process metadata");
    const environment = options.inheritEnv === false ? {} : { ...process.env };
    // Extra variables are applied only to the child, never the harness process.
    const argv = Array.isArray(request.command);
    child = spawn(
      argv ? request.command[0] : request.shellPath,
      argv ? request.command.slice(1) : ["--noprofile", "--norc", "-c", request.command],
      {
        cwd: request.cwd,
        env: { ...environment, ...options.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.once("spawn", () => {
      groupBirth = proc(child.pid)?.birth;
    });
    const closed = new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    // Give commands immediate EOF without opening /dev/null. A sandbox policy
    // may deny that device even though it permits the shell and working files.
    child.stdin.end();
    // Stop ordinary descendants in the shell's group. Deliberately detached
    // groups remain subject to the sandbox's outer lifecycle and policy.
    child.once("exit", killTree);
    if (options.timeout !== undefined)
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, options.timeout * 1000);

    const consume = async (stream, chunk) => {
      if (options.spill !== undefined) {
        totalBytes += chunk.length;
        for (const byte of chunk) if (byte === 10) newlines++;
        const lineCount = newlines + (chunk[chunk.length - 1] === 10 ? 0 : 1);
        if (
          spillFile === undefined &&
          (totalBytes > options.spill.afterBytes || lineCount > options.spill.afterLines)
        ) {
          spillPath = await tempFile(request.tempRoot, { prefix: "pi-output-", suffix: ".log" });
          spillFile = await open(spillPath, "a");
          for (const part of prefixChunks) await spillFile.writeFile(part);
          prefixChunks.length = 0;
          await emit({ type: "spill", path: spillPath });
        }
        if (spillFile === undefined) prefixChunks.push(chunk);
        else await spillFile.writeFile(chunk);
      }
      if (request.forwardOutput) await emit({ type: "output", stream, data: chunk.toString("base64") });
    };
    for (const [name, output] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ]) {
      output.on("data", (chunk) => {
        child.stdout.pause();
        child.stderr.pause();
        pendingCount++;
        pending = pending
          .then(() => consume(name, chunk))
          .catch((error) => {
            writeError ??= error;
            killTree();
          })
          .finally(() => {
            pendingCount--;
            if (pendingCount === 0 && writeError === undefined) {
              child.stdout.resume();
              child.stderr.resume();
            }
          });
      });
    }
    const exit = await closed;
    await pending;
    if (writeError !== undefined) throw writeError;
    if (timedOut || aborted)
      throw failure(timedOut ? "timeout" : "aborted", timedOut ? "Command timed out" : "Command aborted", {
        spillPath,
      });
    return {
      exitCode: exit.code ?? 128 + (constants.signals[exit.signal] ?? 1),
      ...(spillPath === undefined ? {} : { spillPath }),
    };
  } catch (error) {
    killTree();
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, abort);
    controlSignal.removeEventListener("abort", abort);
    await pending;
    await spillFile?.close();
  }
}

function input() {
  const chunks = [];
  let size = 0;
  let received = false;
  const controller = new AbortController();
  let resolveRequest;
  let rejectRequest;
  const commands = [];
  let wake;
  let control = "";
  const request = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const receiveControl = (chunk) => {
    control += chunk.toString("utf8");
    if (Buffer.byteLength(control) > MAX_REQUEST_BYTES) {
      controller.abort();
      return;
    }
    let newline;
    while ((newline = control.indexOf("\n")) !== -1) {
      const text = control.slice(0, newline);
      control = control.slice(newline + 1);
      try {
        const command = JSON.parse(text);
        if (command.type === "cancel") controller.abort();
        else commands.push(command);
      } catch {
        controller.abort();
      }
      wake?.();
    }
  };
  controller.signal.addEventListener("abort", () => wake?.(), { once: true });
  const onData = (chunk) => {
    if (received) {
      receiveControl(chunk);
      return;
    }
    const newline = chunk.indexOf(10);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    size += part.length;
    if (size > MAX_REQUEST_BYTES) {
      rejectRequest(failure("invalid", "Worker request exceeds byte limit"));
      return;
    }
    chunks.push(part);
    if (newline < 0) return;
    received = true;
    try {
      resolveRequest(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
    } catch (error) {
      rejectRequest(error);
    }
    if (newline + 1 < chunk.length) receiveControl(chunk.subarray(newline + 1));
  };
  const onEnd = () => {
    if (!received) rejectRequest(failure("invalid", "Incomplete worker request"));
    controller.abort();
  };
  const onError = (error) => {
    rejectRequest(error);
    controller.abort();
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.on("error", onError);
  return {
    request,
    signal: controller.signal,
    async nextCommand() {
      while (!commands.length && !controller.signal.aborted)
        await new Promise((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      controller.signal.throwIfAborted();
      return commands.shift();
    },
    close() {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.destroy();
    },
  };
}

async function reader(request, channel) {
  const env = new NodeExecutionEnv({ cwd: request.cwd });
  const context = { abortSignal: channel.signal };
  const path = resolve(request.cwd, request.path);
  const opened =
    request.op === "binary-reader"
      ? await env.openBinaryReader(path, request.options, context)
      : await env.openDirReader(path, context);
  if (!opened.ok) throw opened.error;
  const handle = opened.value;
  try {
    await emit({ type: "ready" });
    for (;;) {
      const command = await channel.nextCommand();
      if (command.type === "close") break;
      let result;
      switch (command.type) {
        case "info":
          result = await handle.info(context);
          break;
        case "read":
          if (
            !Number.isSafeInteger(command.length) ||
            command.length < 0 ||
            command.length > request.limits.maxFileBytes
          )
            result = { ok: false, error: failure("invalid", "Read exceeds file byte limit", { path }) };
          else {
            result = await handle.read(command.offset, command.length, context);
            if (result.ok) result = { ok: true, value: Buffer.from(result.value).toString("base64") };
          }
          break;
        case "scan":
          result = await handle.scanLines(command.options, context);
          break;
        case "next":
          if (
            !Number.isSafeInteger(command.maxEntries) ||
            command.maxEntries <= 0 ||
            command.maxEntries > request.limits.maxDirectoryEntries
          )
            result = { ok: false, error: failure("invalid", "Invalid directory page size", { path }) };
          else result = await handle.next(command.maxEntries, context);
          break;
        default:
          throw failure("invalid", "Unknown reader command");
      }
      await emit({
        type: "reply",
        value: result.ok ? result : { ok: false, error: serializeError(result.error) },
      });
    }
    await emit({ type: "result", value: null });
  } finally {
    await handle.close({});
  }
}

async function watch(request, channel) {
  const env = new NodeExecutionEnv({
    cwd: request.cwd,
    watch: { maxDirectories: request.limits.maxDirectoryEntries },
  });
  // Changes during startup must follow the mode handshake on the wire.
  let ready;
  let pending = new Promise((resolve) => {
    ready = resolve;
  });
  const result = await env.watch(
    request.targets.map((target) => ({ ...target, path: resolve(request.cwd, target.path) })),
    (change) => {
      const value = "error" in change ? { error: serializeError(change.error) } : change;
      pending = pending.then(() => emit({ type: "watch", value }));
      // main() observes failures when the watcher closes.
      void pending.catch(() => {});
    },
    { abortSignal: channel.signal },
  );
  if (!result.ok) throw result.error;
  try {
    await emit({ type: "reply", value: result.value.mode });
    ready();
    const command = await channel.nextCommand();
    if (command.type !== "close") throw failure("invalid", "Unknown watch command");
  } finally {
    await result.value.close({});
    await pending;
  }
  await emit({ type: "result", value: null });
}

async function http(request, signal) {
  const url = new URL(request.url);
  const endpoint = new URL(request.baseUrl);
  const prefix = endpoint.pathname.replace(/\/$/, "");
  if (
    url.origin !== endpoint.origin ||
    (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(request.allowHttp && url.protocol === "http:"))
  )
    throw failure("invalid", "Model request is outside the configured provider endpoint");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(request.credentialEnv))
    throw failure("invalid", "Invalid provider credential environment name");
  const placeholder = process.env[request.credentialEnv];
  if (!placeholder) throw failure("provider_missing", "Attach the model provider before launching requests");
  const headers = new Headers(request.headers);
  for (const name of [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "cookie",
    "host",
    "content-length",
  ])
    headers.delete(name);
  headers.set("authorization", `Bearer ${placeholder}`);
  const body = request.body === null ? undefined : Buffer.from(request.body, "base64");
  if (body && body.length > request.limits.maxFileBytes)
    throw failure("invalid", "Model request body exceeds byte limit");
  const response = await fetch(url, { method: request.method, headers, body, redirect: "manual", signal });
  await emit({
    type: "http-response",
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
  if (response.body) {
    try {
      for await (const chunk of response.body) {
        for (let offset = 0; offset < chunk.length; offset += 64 * 1024)
          await emit({
            type: "output",
            stream: "stdout",
            data: Buffer.from(chunk.subarray(offset, offset + 64 * 1024)).toString("base64"),
          });
      }
    } finally {
      await response.body.cancel().catch(() => {});
    }
  }
  await emit({ type: "result", value: null });
}

async function main(channel) {
  const request = await channel.request;
  if (request.version !== 1 || !request.limits || !request.cwd?.startsWith("/"))
    throw failure("invalid", "Invalid worker request");
  if (request.op === "lines") return lines(request);
  if (request.op === "binary-reader" || request.op === "dir-reader") return reader(request, channel);
  if (request.op === "watch") return watch(request, channel);
  if (request.op === "http") return http(request, channel.signal);
  const value = request.op === "shell" ? await shell(request, channel.signal) : await filesystem(request);
  await emit({ type: "result", value });
}

const channel = input();
try {
  await main(channel);
} catch (error) {
  await emit({ type: "error", error: serializeError(error) });
} finally {
  channel.close();
}
