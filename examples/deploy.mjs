import { open, readFile, rm } from "node:fs/promises";
import { connectGateway } from "./connect.mjs";
import { createDeployment, deleteDeployment } from "./deployment.mjs";

const command = process.argv[2];
if (!["create", "delete"].includes(command)) throw new Error("Usage: node examples/deploy.mjs create|delete");
const path = process.env.OPENSHELL_DEPLOYMENT ?? "./deployment.json";
const client = await connectGateway();

if (command === "delete") {
  await deleteDeployment(client.sandbox, JSON.parse(await readFile(path, "utf8")));
  await rm(path);
  console.log(`Deployment workers removed; provider retained. Removed ${path}.`);
} else {
  // Reserve the file before provisioning so an existing deployment is never overwritten.
  const file = await open(path, "wx", 0o600);
  let deployment;
  try {
    deployment = await createDeployment(client.sandbox, {
      provider: process.env.OPENSHELL_INFERENCE_PROVIDER,
      workspace: process.env.OPENSHELL_WORKSPACE ?? "default",
      codingName: process.env.OPENSHELL_SANDBOX,
      inferenceName: process.env.OPENSHELL_INFERENCE_SANDBOX,
      codingImage: process.env.OPENSHELL_CODING_IMAGE,
      inferenceImage: process.env.OPENSHELL_INFERENCE_IMAGE,
      codingNodePath: process.env.OPENSHELL_NODE_PATH,
      inferenceNodePath: process.env.OPENSHELL_INFERENCE_NODE_PATH,
    });
    await file.writeFile(`${JSON.stringify(deployment, null, 2)}\n`);
    await file.sync();
    console.log(`Deployment ready. Saved bindings to ${path}.`);
  } catch (error) {
    if (deployment) await deleteDeployment(client.sandbox, deployment);
    await rm(path);
    throw error;
  } finally {
    await file.close();
  }
}
