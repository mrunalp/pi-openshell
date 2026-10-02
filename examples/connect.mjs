import { readFile } from "node:fs/promises";
import { OpenShellClient } from "@nvidia/openshell-sdk";

async function pem(variable) {
  const path = process.env[variable];
  return path === undefined ? undefined : readFile(path);
}

export async function connect() {
  const gateway = process.env.OPENSHELL_ENDPOINT;
  const name = process.env.OPENSHELL_SANDBOX;
  if (!gateway || !name) throw new Error("Set OPENSHELL_ENDPOINT and OPENSHELL_SANDBOX");
  const client = await OpenShellClient.connect({
    gateway,
    oidcToken: process.env.OPENSHELL_TOKEN,
    caCert: await pem("OPENSHELL_CA_FILE"),
    clientCert: await pem("OPENSHELL_CLIENT_CERT_FILE"),
    clientKey: await pem("OPENSHELL_CLIENT_KEY_FILE"),
  });
  const sandbox = await client.sandbox.get(name, { workspace: process.env.OPENSHELL_WORKSPACE ?? "default" });
  return {
    client,
    binding: { id: sandbox.id, name: sandbox.name, workspace: sandbox.workspace },
    cwd: process.env.OPENSHELL_CWD ?? "/sandbox/work",
    nodePath: process.env.OPENSHELL_NODE_PATH ?? "/usr/bin/node",
  };
}
