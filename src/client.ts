/** Structural subset of @nvidia/openshell-sdk's SandboxClient. */
export interface SandboxClient {
  get(
    name: string,
    options?: { workspace?: string; signal?: AbortSignal },
  ): Promise<{
    id: string;
    name: string;
    workspace: string;
  }>;
  execInteractive(
    name: string,
    command: string[],
    options?: {
      workspace?: string;
      workdir?: string;
      environment?: Record<string, string>;
      timeoutSecs?: number;
      tty?: boolean;
      noLoginShell?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<ExecSession>;
}

export interface ExecSession {
  output: AsyncIterable<
    { stream: "stdout" | "stderr"; data: Uint8Array } | { type: "exit"; exitCode: number }
  >;
  done: Promise<number>;
  write(data: Buffer): void;
  closeInput(): void;
  cancel(): void;
}

/** Immutable application-authorized binding; cwd does not select a sandbox. */
export type SandboxBinding = {
  workspace: string;
  name: string;
  id: string;
};
