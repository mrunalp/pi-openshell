import { readFile } from "node:fs/promises";
import { OpenShellClient } from "@nvidia/openshell-sdk";
import { resolveDeployment } from "./deployment.mjs";

async function pem(variable) {
  const path = process.env[variable];
  return path === undefined ? undefined : readFile(path);
}

export async function connectGateway() {
  const gateway = process.env.OPENSHELL_ENDPOINT;
  if (!gateway) throw new Error("Set OPENSHELL_ENDPOINT");
  return OpenShellClient.connect({
    gateway,
    oidcToken: process.env.OPENSHELL_TOKEN,
    caCert: await pem("OPENSHELL_CA_FILE"),
    clientCert: await pem("OPENSHELL_CLIENT_CERT_FILE"),
    clientKey: await pem("OPENSHELL_CLIENT_KEY_FILE"),
  });
}

export async function connect() {
  const name = process.env.OPENSHELL_SANDBOX;
  if (!name) throw new Error("Set OPENSHELL_SANDBOX");
  const client = await connectGateway();
  const sandbox = await client.sandbox.get(name, { workspace: process.env.OPENSHELL_WORKSPACE ?? "default" });
  return {
    client,
    binding: { id: sandbox.id, name: sandbox.name, workspace: sandbox.workspace },
    cwd: process.env.OPENSHELL_CWD ?? "/sandbox/work",
    nodePath: process.env.OPENSHELL_NODE_PATH ?? "/usr/bin/node",
  };
}

export async function connectManaged() {
  const client = await connectGateway();
  const path = process.env.OPENSHELL_DEPLOYMENT;
  let deployment;
  if (path) deployment = JSON.parse(await readFile(path, "utf8"));
  else {
    const codingName = process.env.OPENSHELL_SANDBOX;
    const inferenceName = process.env.OPENSHELL_INFERENCE_SANDBOX;
    if (!codingName || !inferenceName)
      throw new Error("Set OPENSHELL_DEPLOYMENT or both OPENSHELL_SANDBOX and OPENSHELL_INFERENCE_SANDBOX");
    const codingWorkspace = process.env.OPENSHELL_WORKSPACE ?? "default";
    const inferenceWorkspace = process.env.OPENSHELL_INFERENCE_WORKSPACE ?? codingWorkspace;
    const coding = await client.sandbox.get(codingName, { workspace: codingWorkspace });
    const inference = await client.sandbox.get(inferenceName, { workspace: inferenceWorkspace });
    deployment = {
      version: 1,
      id: "application-configured",
      coding: {
        binding: { id: coding.id, name: coding.name, workspace: coding.workspace },
        cwd: process.env.OPENSHELL_CWD ?? "/sandbox/work",
        nodePath: process.env.OPENSHELL_NODE_PATH ?? "/usr/bin/node",
      },
      inference: {
        binding: { id: inference.id, name: inference.name, workspace: inference.workspace },
        nodePath: process.env.OPENSHELL_INFERENCE_NODE_PATH ?? "/usr/bin/node",
        provider: process.env.OPENSHELL_INFERENCE_PROVIDER ?? "application-attached",
      },
    };
  }
  return { client, ...(await resolveDeployment(client.sandbox, deployment)) };
}
