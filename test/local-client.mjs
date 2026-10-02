// Test-only SDK fixture. The shipped adapter has no local execution transport.
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

export class LocalSandboxClient {
  executions = [];
  children = new Set();
  denyGroupSignals = false;
  constructor(binding, environment = {}) {
    this.binding = binding;
    this.environment = environment;
  }

  async get(name, options) {
    options?.signal?.throwIfAborted();
    if (name !== this.binding.name || options?.workspace !== this.binding.workspace)
      throw new Error("Unexpected target");
    return { ...this.binding };
  }

  async execInteractive(name, command, options) {
    options?.signal?.throwIfAborted();
    this.executions.push({ name, command, options });
    const args = command.slice(1);
    if (this.denyGroupSignals) {
      args[args.length - 1] = `const kill = process.kill.bind(process);
        process.kill = (pid, signal) => {
          if (pid <= 0) throw Object.assign(new Error("group signals denied"), {code:"EPERM"});
          return kill(pid, signal);
        };\n${args[args.length - 1]}`;
    }
    const child = spawn(command[0], args, {
      cwd: options.workdir,
      env: { PATH: "/usr/bin:/bin", ...this.environment },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    let cancelled = false;
    const output = new Readable({
      objectMode: true,
      read() {
        child.stdout.resume();
        child.stderr.resume();
      },
    });
    for (const [stream, readable] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ]) {
      readable.on("data", (data) => {
        if (!output.push({ stream, data })) {
          child.stdout.pause();
          child.stderr.pause();
        }
      });
    }
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      // Test transport cancellation terminates the helper's process group.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      output.destroy(new DOMException("Exec cancelled", "AbortError"));
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => {});
    const done = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        output.destroy(error);
        reject(error);
      });
      child.once("close", (code) => {
        this.children.delete(child);
        options.signal?.removeEventListener("abort", cancel);
        if (cancelled) reject(new DOMException("Exec cancelled", "AbortError"));
        else {
          output.push({ type: "exit", exitCode: code ?? 1 });
          output.push(null);
          resolve(code ?? 1);
        }
      });
    });
    void done.catch(() => {});
    return {
      output,
      done,
      cancel,
      write: (data) => {
        child.stdin.write(data);
      },
      closeInput: () => child.stdin.end(),
    };
  }
}
