import type { Context } from "@earendil-works/chord";
import { defineDoc, type HarnessOptions } from "@earendil-works/pi-durable";
import type { SandboxBinding, SandboxClient } from "./client.js";
import { OpenShellExecutionEnv, type OpenShellExecutionEnvOptions } from "./env.js";

export type SandboxDocument = {
  binding?: SandboxBinding;
  /** Initial sandbox-local working directory. */
  cwd?: string;
};

/** A conversation fork receives no sandbox authority by default. */
export const SandboxDoc = defineDoc<SandboxDocument>({
  kind: "openshell.sandbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export function createOpenShellEnvResolver(
  options: Omit<OpenShellExecutionEnvOptions, "binding" | "cwd"> & { client: SandboxClient },
): NonNullable<HarnessOptions["env"]> {
  return async ({ conversationId, cwd, read }, context: Context) => {
    const document = await read.snapshot(SandboxDoc, conversationId, context);
    if (document?.binding === undefined) return undefined;
    if (document.cwd === undefined) throw new Error("Sandbox document has no working directory");
    return new OpenShellExecutionEnv({ ...options, binding: document.binding, cwd: cwd ?? document.cwd });
  };
}
