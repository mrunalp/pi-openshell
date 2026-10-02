import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import type { SandboxBinding, SandboxClient } from "./client.js";
import { decodeBase64, record, type WorkerError } from "./protocol.js";
import { OpenShellTransport, type WorkerLimits, type WorkerStream } from "./transport.js";

export interface OpenShellExecutionEnvOptions {
  client: SandboxClient;
  binding: SandboxBinding;
  cwd: string;
  /** Absolute Node executable path in the sandbox. */
  nodePath?: string;
  /** Absolute Bash executable path in the sandbox. */
  shellPath?: string;
  /** Temporary directory in the sandbox, allowed by its filesystem policy. */
  tempRoot?: string;
  /** Per-file transfer limit, default 8 MiB, maximum 64 MiB. */
  maxFileBytes?: number;
  /** Streaming line limit, default 1 MiB. */
  maxLineBytes?: number;
  maxDirectoryEntries?: number;
  /** Filesystem operation deadline, default 30 seconds. */
  fileTimeoutMs?: number;
}

class RemoteError extends Error {
  constructor(readonly remote: WorkerError) {
    super(remote.message);
  }
}

function positive(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

function absolute(value: string, name: string): string {
  if (!posix.isAbsolute(value) || value.includes("\0"))
    throw new Error(`${name} must be an absolute sandbox path`);
  return posix.normalize(value);
}

function fileError(error: unknown, path?: string, aborted = false): FileError {
  if (error instanceof FileError) return error;
  if (aborted) return new FileError("aborted", "Operation aborted", path);
  const remote = error instanceof RemoteError ? error.remote : undefined;
  const codes: Record<string, FileErrorCode> = {
    ENOENT: "not_found",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    ENOTDIR: "not_directory",
    EISDIR: "is_directory",
    EINVAL: "invalid",
    EEXIST: "invalid",
    invalid: "invalid",
    not_supported: "not_supported",
    aborted: "aborted",
  };
  return new FileError(
    codes[remote?.code ?? ""] ?? "unknown",
    error instanceof Error ? error.message : String(error),
    remote?.path ?? path,
  );
}

function fileInfo(value: unknown): FileInfo {
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    !["file", "directory", "symlink"].includes(String(value.kind)) ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.mtimeMs !== "number" ||
    !Number.isFinite(value.mtimeMs)
  ) {
    throw new Error("Invalid worker file metadata");
  }
  return value as unknown as FileInfo;
}

interface Operation {
  stream: WorkerStream;
  controller: AbortController;
  finish(): void;
}

class RemoteLineReader implements TextLineReader {
  private closed = false;
  private ended = false;

  constructor(
    private readonly operation: Operation,
    private readonly path: string,
  ) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", this.path));
    if (this.ended) return ok(undefined);
    const abort = () => this.operation.controller.abort();
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const next = await this.operation.stream.next();
      if (next.done) throw new Error("Line reader ended without a result");
      if (next.value.type === "error") throw new RemoteError(next.value.error);
      if (next.value.type === "line")
        return ok({
          text: decodeBase64(next.value.data).toString("utf8"),
          terminated: next.value.terminated,
        });
      if (next.value.type !== "result" || next.value.value !== null)
        throw new Error("Invalid line reader response");
      if (!(await this.operation.stream.next()).done) throw new Error("Line reader sent output after EOF");
      this.ended = true;
      this.operation.finish();
      return ok(undefined);
    } catch (error) {
      await this.close(context);
      return err(fileError(error, this.path, context.abortSignal?.aborted));
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }

  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.operation.finish();
  }
}

export class OpenShellExecutionEnv implements ExecutionEnv {
  readonly id: string;
  readonly binding: Readonly<SandboxBinding>;
  cwd: string;
  private readonly transport: OpenShellTransport;
  private readonly controllers = new Set<AbortController>();
  private readonly limits: WorkerLimits;
  private readonly tempRoot: string;
  private readonly shellPath: string;
  private readonly fileTimeoutMs: number;

  constructor(options: OpenShellExecutionEnvOptions) {
    if (!options.binding.id || !options.binding.name || !options.binding.workspace)
      throw new Error("A complete sandbox binding is required");
    this.binding = Object.freeze({ ...options.binding });
    this.id = `openshell:${encodeURIComponent(this.binding.workspace)}:${encodeURIComponent(this.binding.id)}`;
    this.cwd = absolute(options.cwd, "cwd");
    this.tempRoot = absolute(options.tempRoot ?? "/tmp", "tempRoot");
    this.shellPath = absolute(options.shellPath ?? "/bin/bash", "shellPath");
    this.fileTimeoutMs = positive(options.fileTimeoutMs ?? 30_000, "fileTimeoutMs", 2_147_483_647);
    this.limits = {
      maxFileBytes: positive(options.maxFileBytes ?? 8 * 1024 * 1024, "maxFileBytes", 64 * 1024 * 1024),
      maxLineBytes: positive(options.maxLineBytes ?? 1024 * 1024, "maxLineBytes", 64 * 1024 * 1024),
      maxDirectoryEntries: positive(options.maxDirectoryEntries ?? 10_000, "maxDirectoryEntries", 100_000),
    };
    this.transport = new OpenShellTransport(
      options.client,
      this.binding,
      absolute(options.nodePath ?? "/usr/bin/node", "nodePath"),
      this.limits,
    );
  }

  private async start(
    request: Record<string, unknown>,
    context: Context,
    deadline = false,
  ): Promise<Operation> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal =
      context.abortSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, context.abortSignal]);
    const timer = deadline ? setTimeout(() => controller.abort(), this.fileTimeoutMs) : undefined;
    let stream: WorkerStream | undefined;
    const finish = () => {
      clearTimeout(timer);
      this.controllers.delete(controller);
      controller.abort();
      stream?.cancel();
    };
    try {
      stream = await this.transport.start(
        { cwd: absolute(this.cwd, "cwd"), tempRoot: this.tempRoot, ...request },
        signal,
      );
      return { stream, controller, finish };
    } catch (error) {
      finish();
      throw error;
    }
  }

  private async call<T>(
    request: Record<string, unknown>,
    context: Context,
    decode: (value: unknown) => T,
  ): Promise<Result<T, FileError>> {
    let operation: Operation | undefined;
    const path = typeof request.path === "string" ? request.path : undefined;
    try {
      operation = await this.start(request, context, true);
      const next = await operation.stream.next();
      if (next.done) throw new Error("Worker returned no result");
      if (next.value.type === "error") {
        // Require a successful terminal RPC even for a remote filesystem error.
        if (!(await operation.stream.next()).done) throw new Error("Worker sent frames after its error");
        throw new RemoteError(next.value.error);
      }
      if (next.value.type !== "result") throw new Error("Unexpected filesystem worker frame");
      const value = decode(next.value.value);
      if (!(await operation.stream.next()).done) throw new Error("Worker sent frames after its result");
      return ok(value);
    } catch (error) {
      return err(fileError(error, path, context.abortSignal?.aborted));
    } finally {
      operation?.finish();
    }
  }

  private empty(request: Record<string, unknown>, context: Context): Promise<Result<void, FileError>> {
    return this.call(request, context, (value) => {
      if (value !== null) throw new Error("Invalid void worker result");
    });
  }

  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
    if (path.includes("\0")) return err(new FileError("invalid", "Path contains a NUL byte", path));
    try {
      return ok(posix.resolve(absolute(this.cwd, "cwd"), path));
    } catch (error) {
      return err(fileError(error, path));
    }
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted"));
    if (parts.some((part) => part.includes("\0")))
      return err(new FileError("invalid", "Path contains a NUL byte"));
    return ok(posix.join(...parts));
  }

  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.call({ op: "read", path }, context, decodeBase64);
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, context);
    return result.ok ? ok(Buffer.from(result.value).toString("utf8")) : result;
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    let operation: Operation | undefined;
    try {
      operation = await this.start({ op: "lines", path }, context);
      const next = await operation.stream.next();
      if (next.done) throw new Error("Line reader returned no response");
      if (next.value.type === "error") throw new RemoteError(next.value.error);
      if (next.value.type !== "ready") throw new Error("Invalid line reader handshake");
      return ok(new RemoteLineReader(operation, path));
    } catch (error) {
      operation?.finish();
      return err(fileError(error, path, context.abortSignal?.aborted));
    }
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "Operation aborted", path));
    if (options?.maxLines !== undefined && (!Number.isSafeInteger(options.maxLines) || options.maxLines < 0))
      return err(new FileError("invalid", "Invalid maxLines", path));
    if (options?.maxLines === 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const result: string[] = [];
    try {
      while (options?.maxLines === undefined || result.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        result.push(line.value.text);
      }
      return ok(result);
    } finally {
      await opened.value.close(context);
    }
  }

  private write(
    op: "write" | "append",
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    if (data.length > this.limits.maxFileBytes)
      return Promise.resolve(err(new FileError("invalid", "Write exceeds file byte limit", path)));
    return this.empty({ op, path, data: data.toString("base64") }, context);
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.write("write", path, content, context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.write("append", path, content, context);
  }

  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (!Number.isSafeInteger(size) || size < 0)
      return Promise.resolve(err(new FileError("invalid", "Invalid file size", path)));
    return this.empty({ op: "truncate", path, size }, context);
  }

  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.empty({ op: "flush", path }, context);
  }
  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.empty({ op: "rename", path: sourcePath, destination: destinationPath }, context);
  }
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.call({ op: "info", path }, context, fileInfo);
  }

  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.call({ op: "list", path }, context, (value) => {
      if (!Array.isArray(value)) throw new Error("Invalid directory result");
      return value.map(fileInfo);
    });
  }

  private string(request: Record<string, unknown>, context: Context): Promise<Result<string, FileError>> {
    return this.call(request, context, (value) => {
      if (typeof value !== "string") throw new Error("Invalid worker path result");
      return value;
    });
  }

  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.string({ op: "canonical", path }, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    if (result.ok) return ok(true);
    return result.error.code === "not_found" ? ok(false) : result;
  }

  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.empty({ op: "mkdir", path, recursive: options?.recursive }, context);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.empty({ op: "remove", path, ...options }, context);
  }
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.string({ op: "temp-dir", prefix }, context);
  }
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.string({ op: "temp-file", options }, context);
  }

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Operation aborted"));
    let operation: Operation | undefined;
    let spillPath: string | undefined;
    let callbackError: Error | undefined;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    try {
      if (
        options?.timeout !== undefined &&
        (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)
      )
        return err(new ExecutionError("timeout", "Invalid execution timeout"));
      if (options?.spill !== undefined) {
        for (const [key, value] of Object.entries(options.spill)) {
          if (!Number.isSafeInteger(value) || value < 0 || value > this.limits.maxFileBytes)
            throw new Error(`Invalid spill ${key}`);
        }
      }
      operation = await this.start(
        {
          op: "shell",
          command,
          cwd: posix.resolve(absolute(this.cwd, "cwd"), options?.cwd ?? "."),
          shellPath: this.shellPath,
          forwardOutput: options?.onOutput !== undefined,
          options: {
            env: options?.env ?? {},
            inheritEnv: options?.inheritEnv ?? true,
            timeout: options?.timeout,
            spill: options?.spill,
          },
        },
        context,
      );
      const output = (text: string) => {
        if (text === "" || options?.onOutput === undefined) return;
        try {
          options.onOutput(text, context);
        } catch (error) {
          callbackError = error instanceof Error ? error : new Error(String(error));
          throw callbackError;
        }
      };
      let result: ShellExecResult | undefined;
      let remoteError: RemoteError | undefined;
      for (;;) {
        const next = await operation.stream.next();
        if (next.done) break;
        const frame = next.value;
        switch (frame.type) {
          case "output":
            output(decoders[frame.stream].decode(decodeBase64(frame.data), { stream: true }));
            break;
          case "spill":
            spillPath = frame.path;
            break;
          case "error":
            remoteError = new RemoteError(frame.error);
            break;
          case "result": {
            const value = frame.value;
            if (
              !record(value) ||
              !Number.isSafeInteger(value.exitCode) ||
              Number(value.exitCode) < 0 ||
              (value.spillPath !== undefined && typeof value.spillPath !== "string")
            )
              throw new Error("Invalid shell result");
            result = {
              exitCode: Number(value.exitCode),
              ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath as string }),
            };
            break;
          }
          default:
            throw new Error("Unexpected shell worker frame");
        }
      }
      output(decoders.stdout.decode());
      output(decoders.stderr.decode());
      if (remoteError !== undefined) throw remoteError;
      if (result === undefined) throw new Error("Shell execution ended without a result");
      return ok(result);
    } catch (error) {
      const remote = error instanceof RemoteError ? error.remote : undefined;
      const code = callbackError
        ? "callback_error"
        : context.abortSignal?.aborted
          ? "aborted"
          : remote?.code === "timeout"
            ? "timeout"
            : remote?.code === "aborted"
              ? "aborted"
              : remote?.code === "ENOENT"
                ? "shell_unavailable"
                : "unknown";
      const failure = new ExecutionError(code, error instanceof Error ? error.message : String(error));
      failure.spillPath = remote?.spillPath ?? spillPath;
      return err(failure);
    } finally {
      operation?.finish();
    }
  }

  async cleanup(_context: Context): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}
