import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeployment,
  deleteDeployment,
  resolveDeployment,
  validateDeployment,
} from "../examples/deployment.mjs";

class Client {
  resources = new Map();
  creations = [];
  deletions = [];
  failInference = false;
  async create(spec) {
    if (this.failInference && spec.providers.length) throw new Error("Inference admission failed");
    const resource = { id: `uuid-${spec.name}`, name: spec.name, workspace: spec.workspace };
    this.resources.set(spec.name, resource);
    this.creations.push(spec);
    return resource;
  }
  async get(name) {
    const resource = this.resources.get(name);
    if (!resource) throw Object.assign(new Error("Absent"), { code: "not_found" });
    return resource;
  }
  async waitReady() {}
  async exec() {
    return { exitCode: 0 };
  }
  async delete(name) {
    this.deletions.push(name);
    this.resources.delete(name);
  }
  async waitDeleted() {}
}

test("deployment provisions distinct roles, saves stable bindings and resolves them after restart", async () => {
  const client = new Client();
  const deployment = await createDeployment(client, { provider: "model-provider", workspace: "team" });
  const [coding, inference] = client.creations;
  assert.notEqual(deployment.coding.binding.id, deployment.inference.binding.id);
  assert.deepEqual(coding.providers, []);
  assert.deepEqual(inference.providers, ["model-provider"]);
  assert.ok(coding.policy.filesystem.readWrite.includes("/sandbox"));
  assert.equal(inference.policy.filesystem.includeWorkdir, false);
  assert.equal(inference.policy.filesystem.readWrite.includes("/sandbox"), false);
  assert.equal(inference.policy.filesystem.readOnly.includes("/sandbox"), false);
  const restored = await resolveDeployment(client, JSON.parse(JSON.stringify(deployment)));
  assert.deepEqual(restored, deployment);
  await deleteDeployment(client, restored);
  assert.equal(client.resources.size, 0);
});

test("a reused inference name blocks startup and teardown before either worker is deleted", async () => {
  const client = new Client();
  const deployment = await createDeployment(client, { provider: "model-provider" });
  const inference = deployment.inference.binding;
  client.resources.set(inference.name, { ...inference, id: "replacement-uuid" });
  await assert.rejects(resolveDeployment(client, deployment), /binding no longer matches/);
  await assert.rejects(deleteDeployment(client, deployment), /binding no longer matches/);
  assert.equal(client.deletions.length, 0);
  assert.equal(client.resources.size, 2);
});

test("failed inference admission rolls back only the coding worker created by this deployment", async () => {
  const client = new Client();
  client.resources.set("unrelated", { id: "existing", name: "unrelated", workspace: "default" });
  client.failInference = true;
  await assert.rejects(
    createDeployment(client, { provider: "model-provider" }),
    /Inference admission failed/,
  );
  assert.deepEqual([...client.resources.keys()], ["unrelated"]);
  assert.equal(client.deletions.length, 1);
});

test("teardown is repeatable after one worker was already removed", async () => {
  const client = new Client();
  const deployment = await createDeployment(client, { provider: "model-provider" });
  client.resources.delete(deployment.inference.binding.name);
  await deleteDeployment(client, deployment);
  await deleteDeployment(client, deployment);
  assert.deepEqual(client.deletions, [deployment.coding.binding.name]);
});

test("shared workers and incomplete saved deployments fail closed", async () => {
  const client = new Client();
  await assert.rejects(
    createDeployment(client, { provider: "model-provider", codingName: "shared", inferenceName: "shared" }),
    /distinct sandboxes/,
  );
  await assert.rejects(createDeployment(client, {}), /provider name/);
  assert.equal(client.creations.length, 0);
  const deployment = await createDeployment(client, { provider: "model-provider" });
  assert.throws(
    () =>
      validateDeployment({
        ...deployment,
        inference: { ...deployment.inference, binding: deployment.coding.binding },
      }),
    /distinct sandboxes/,
  );
  assert.throws(
    () => validateDeployment({ ...deployment, inference: { ...deployment.inference, nodePath: "node" } }),
    /must be absolute/,
  );
  assert.throws(() => validateDeployment({ ...deployment, inference: undefined }), /inference/);
});
