import { readFile } from "node:fs/promises";
import type { ExecSession, SandboxBinding, SandboxClient } from "./client.js";
import { type Frame, parseFrame } from "./protocol.js";

let workerSource: Promise<string> | undefined;

export interface WorkerLimits {
  maxFileBytes: number;
  maxLineBytes: number;
  maxDirectoryEntries: number;
}

export class WorkerStream {
  private readonly iterator: AsyncIterator<Frame>;
  private closed = false;
  private cancelling: Promise<void> | undefined;
  private readonly onAbort = () => {
    void this.cancel();
  };

  constructor(
    private readonly session: ExecSession,
    maxFrameBytes: number,
    private readonly controlledShell = false,
    private readonly signal?: AbortSignal,
  ) {
    // A receiver may reject before the consumer reaches the terminal frame.
    void session.done.catch(() => {});
    this.iterator = this.frames(maxFrameBytes)[Symbol.asyncIterator]();
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  next(): Promise<IteratorResult<Frame>> {
    return this.iterator.next();
  }

  cancel(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.cancelling ??= this.stop();
    return this.cancelling;
  }

  private async stop(): Promise<void> {
    if (!this.controlledShell) {
      this.session.cancel();
      return;
    }
    // Keep the RPC alive while the helper kills and reaps its shell group.
    // Abruptly aborting it first can strand a detached shell in the sandbox.
    const timer = setTimeout(() => this.session.cancel(), 2000);
    try {
      this.session.write(Buffer.from('{"type":"cancel"}\n'));
      this.session.closeInput();
      await this.session.done;
    } catch {
      this.session.cancel();
    } finally {
      clearTimeout(timer);
    }
  }

  private async *frames(maxFrameBytes: number): AsyncGenerator<Frame> {
    let chunks: Buffer[] = [];
    let size = 0;
    let sawExit = false;
    let terminal = false;
    let stderr = "";
    try {
      for await (const event of this.session.output) {
        if ("type" in event) {
          if (sawExit) throw new Error("Duplicate remote exit");
          sawExit = true;
          if (event.exitCode !== 0) throw new Error(`Worker exited ${event.exitCode}: ${stderr}`);
          continue;
        }
        if (sawExit) throw new Error("Remote output after exit");
        if (event.stream === "stderr") {
          stderr = (stderr + Buffer.from(event.data).toString("utf8")).slice(-8192);
          continue;
        }
        const data = Buffer.from(event.data);
        let start = 0;
        while (start < data.length) {
          const newline = data.indexOf(10, start);
          const end = newline < 0 ? data.length : newline;
          const part = data.subarray(start, end);
          size += part.length;
          if (size > maxFrameBytes) throw new Error("Worker response exceeds frame limit");
          chunks.push(part);
          if (newline < 0) break;
          if (terminal) throw new Error("Worker sent a frame after its terminal result");
          const frame = parseFrame(Buffer.concat(chunks, size).toString("utf8"));
          chunks = [];
          size = 0;
          terminal = frame.type === "result" || frame.type === "error";
          yield frame;
          start = newline + 1;
        }
      }
      if (!sawExit || !terminal || size !== 0)
        throw new Error("Incomplete worker response; operation outcome may be unknown");
      if ((await this.session.done) !== 0) throw new Error("Worker execution failed");
    } finally {
      this.signal?.removeEventListener("abort", this.onAbort);
      if (!sawExit) await this.cancel();
      this.closed = true;
      this.session.cancel();
    }
  }
}

export class OpenShellTransport {
  private readonly active = new Set<WorkerStream>();
  constructor(
    private readonly client: SandboxClient,
    readonly binding: Readonly<SandboxBinding>,
    private readonly nodePath: string,
    private readonly limits: WorkerLimits,
  ) {}

  async start(request: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerStream> {
    signal?.throwIfAborted();
    const current = await this.client.get(this.binding.name, { workspace: this.binding.workspace, signal });
    if (
      current.id !== this.binding.id ||
      current.workspace !== this.binding.workspace ||
      current.name !== this.binding.name
    ) {
      throw new Error("Sandbox binding no longer matches the gateway resource");
    }
    workerSource ??= readFile(new URL("./worker.mjs", import.meta.url), "utf8");
    const source = await workerSource;
    signal?.throwIfAborted();
    const controlledShell = request.op === "shell" || request.op === "http";
    const rpcController = new AbortController();
    const launchAbort = () => rpcController.abort();
    signal?.addEventListener("abort", launchAbort, { once: true });
    if (signal?.aborted) launchAbort();
    let session: ExecSession;
    try {
      session = await this.client.execInteractive(
        this.binding.name,
        [this.nodePath, "--input-type=module", "--eval", source],
        {
          workspace: this.binding.workspace,
          workdir: "/",
          tty: false,
          noLoginShell: true,
          signal: controlledShell ? rpcController.signal : signal,
        },
      );
    } finally {
      signal?.removeEventListener("abort", launchAbort);
    }
    void session.done.catch(() => {});
    if (typeof session.cancel !== "function" || typeof session.closeInput !== "function") {
      throw new Error("Upgrade the OpenShell SDK: execInteractive must expose cancel() and closeInput()");
    }
    const maxFrameBytes =
      Math.ceil(Math.max(this.limits.maxFileBytes, this.limits.maxLineBytes) / 3) * 4 + 128 * 1024;
    try {
      const payload = Buffer.from(`${JSON.stringify({ version: 1, ...request, limits: this.limits })}\n`);
      // Keep individual gRPC stdin messages below transport and supervisor limits.
      for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
        session.write(payload.subarray(offset, offset + 64 * 1024));
      }
      if (!controlledShell) session.closeInput();
    } catch (error) {
      session.cancel();
      throw error;
    }
    const stream = new WorkerStream(session, maxFrameBytes, controlledShell, signal);
    this.active.add(stream);
    void session.done.then(
      () => this.active.delete(stream),
      () => this.active.delete(stream),
    );
    return stream;
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.active].map((stream) => stream.cancel()));
  }
}
