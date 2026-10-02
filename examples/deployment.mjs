import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const defaultImage = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";
const roles = ["coding", "inference"];

function nonempty(value, description) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${description}`);
  return value;
}

export function validateDeployment(value) {
  if (value?.version !== 1) throw new Error("Unsupported deployment file version");
  const deployment = { version: 1, id: nonempty(value.id, "deployment ID") };
  for (const role of roles) {
    const worker = value[role];
    const binding = worker?.binding;
    deployment[role] = {
      binding: Object.fromEntries(
        ["workspace", "name", "id"].map((key) => [key, nonempty(binding?.[key], `${role} ${key}`)]),
      ),
      nodePath: nonempty(worker?.nodePath, `${role} Node path`),
    };
    if (!worker.nodePath.startsWith("/") || worker.nodePath.includes("\0"))
      throw new Error(`${role} Node path must be absolute`);
  }
  deployment.coding.cwd = nonempty(value.coding.cwd, "coding working directory");
  if (!deployment.coding.cwd.startsWith("/") || deployment.coding.cwd.includes("\0"))
    throw new Error("Coding working directory must be absolute");
  deployment.inference.provider = nonempty(value.inference.provider, "inference provider name");
  const coding = deployment.coding.binding;
  const inference = deployment.inference.binding;
  if (
    coding.id === inference.id ||
    (coding.name === inference.name && coding.workspace === inference.workspace)
  )
    throw new Error("Coding and inference must use distinct sandboxes");
  return deployment;
}

async function checkBinding(client, binding, allowMissing = false) {
  let current;
  try {
    current = await client.get(binding.name, { workspace: binding.workspace });
  } catch (error) {
    if (allowMissing && error.code === "not_found") return false;
    throw error;
  }
  if (["workspace", "name", "id"].some((key) => current[key] !== binding[key]))
    throw new Error(`Deployment binding no longer matches ${binding.workspace}/${binding.name}`);
  return true;
}

export async function resolveDeployment(client, value) {
  const deployment = validateDeployment(value);
  await Promise.all(roles.map((role) => checkBinding(client, deployment[role].binding)));
  return deployment;
}

/** Operator-side provisioning. It attaches an existing provider; it never reads its key. */
export async function createDeployment(client, options) {
  const provider = nonempty(options.provider, "inference provider name");
  const workspace = options.workspace ?? "default";
  const id = randomUUID();
  const codingName = options.codingName ?? `pi-code-${id.slice(0, 8)}`;
  const inferenceName = options.inferenceName ?? `pi-infer-${id.slice(0, 8)}`;
  if (codingName === inferenceName) throw new Error("Coding and inference must use distinct sandboxes");
  const codingNodePath = options.codingNodePath ?? "/usr/bin/node";
  const inferenceNodePath = options.inferenceNodePath ?? "/usr/bin/node";
  // Reject invalid application configuration before allocating workers.
  validateDeployment({
    version: 1,
    id,
    coding: {
      binding: { workspace, name: codingName, id: "pending-coding" },
      nodePath: codingNodePath,
      cwd: "/sandbox/work",
    },
    inference: {
      binding: { workspace, name: inferenceName, id: "pending-inference" },
      nodePath: inferenceNodePath,
      provider,
    },
  });
  const codingPolicy = JSON.parse(
    await readFile(new URL("../policies/coding.json", import.meta.url), "utf8"),
  );
  const inferencePolicy = JSON.parse(
    await readFile(new URL("../policies/inference.json", import.meta.url), "utf8"),
  );
  const workers = {};
  try {
    for (const role of roles) {
      const sandbox = await client.create({
        workspace,
        name: role === "coding" ? codingName : inferenceName,
        image: (role === "coding" ? options.codingImage : options.inferenceImage) ?? defaultImage,
        labels: { "pi-openshell.deployment": id, "pi-openshell.role": role },
        providers: role === "coding" ? [] : [provider],
        command:
          role === "coding"
            ? ["/bin/sleep", "infinity"]
            : [inferenceNodePath, "-e", "setInterval(() => {}, 3600000)"],
        policy: role === "coding" ? codingPolicy : inferencePolicy,
      });
      workers[role] = {
        binding: { workspace: sandbox.workspace, name: sandbox.name, id: sandbox.id },
        nodePath: role === "coding" ? codingNodePath : inferenceNodePath,
      };
      await client.waitReady(sandbox.name, options.readyTimeoutSecs ?? 120, { workspace });
      if (role === "coding") {
        const initialized = await client.exec(
          sandbox.name,
          [
            codingNodePath,
            "--input-type=module",
            "-e",
            'import {mkdir} from "node:fs/promises"; await mkdir("/sandbox/work", {recursive: true});',
          ],
          { workspace, workdir: "/", noLoginShell: true, timeoutSecs: 30 },
        );
        if (initialized.exitCode !== 0) throw new Error("Coding workspace initialization failed");
      }
    }
    return validateDeployment({
      version: 1,
      id,
      ...workers,
      coding: { ...workers.coding, cwd: "/sandbox/work" },
      inference: { ...workers.inference, provider },
    });
  } catch (error) {
    const cleanupErrors = [];
    for (const role of [...roles].reverse()) {
      if (!workers[role]) continue;
      const binding = workers[role].binding;
      try {
        if (await checkBinding(client, binding, true)) {
          await client.delete(binding.name, { workspace: binding.workspace });
          await client.waitDeleted(binding.name, 120, { workspace: binding.workspace });
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], "Deployment failed; worker cleanup also failed");
    throw error;
  }
}

/** Delete only workers that still match the saved UUIDs. Provider records are retained. */
export async function deleteDeployment(client, value) {
  const deployment = validateDeployment(value);
  // Validate both resources before deleting either; a reused name fails closed.
  const present = await Promise.all(
    roles.map((role) => checkBinding(client, deployment[role].binding, true)),
  );
  const errors = [];
  for (const index of [1, 0]) {
    if (!present[index]) continue;
    const binding = deployment[roles[index]].binding;
    try {
      if (!(await checkBinding(client, binding, true))) continue;
      await client.delete(binding.name, { workspace: binding.workspace });
      await client.waitDeleted(binding.name, 120, { workspace: binding.workspace });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Could not remove every deployment worker");
}
