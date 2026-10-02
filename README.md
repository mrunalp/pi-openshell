# pi-openshell

Run Pi Durable's coding tools in an existing OpenShell sandbox while the trusted
harness, model client, and durable storage stay outside it.

This first version implements Pi Durable 1.0.0's complete `ExecutionEnv`
interface and a conversation-to-sandbox document resolver. Sandbox provisioning,
automatic cleanup of sandboxes, execution reattachment, and an interactive Pi
coding-agent extension are follow-up work. This is a Durable application package;
it does not currently register an extension through `pi install`.

## Install

Node.js 22.19 or later is required on the harness host. The workload image needs
Node.js 22 or later and Bash; it does not need Pi, this package, or the OpenShell SDK.

```shell
npm install git+https://github.com/mrunalp/pi-openshell.git @earendil-works/pi-durable@1.0.0
```

OpenShell's SDK is currently distributed through GitHub Packages. Follow the
[SDK installation instructions](https://github.com/NVIDIA/OpenShell/tree/main/sdk/typescript),
then install `@nvidia/openshell-sdk` separately. It is an optional peer dependency
so this package's tests and core adapter can be installed without private-registry
credentials. The SDK's `execInteractive()` must expose `cancel()` and
`closeInput()`. Use an SDK compatible with your gateway. Development against an
OpenShell checkout can use its built `sdk/typescript` package.

## Attach to an existing sandbox

Create a sandbox from an image containing Node and Bash. Keep its canonical main
process running; helper processes run as sandbox exec sessions.

```js
import { OpenShellClient } from "@nvidia/openshell-sdk";
import { OpenShellExecutionEnv } from "pi-openshell";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const client = await OpenShellClient.connect({
  gateway: "https://gateway.example.com",
  oidcToken: process.env.OPENSHELL_TOKEN,
});
const sandbox = await client.sandbox.get("worker", { workspace: "default" });
const env = new OpenShellExecutionEnv({
  client: client.sandbox,
  binding: { id: sandbox.id, name: sandbox.name, workspace: sandbox.workspace },
  cwd: "/sandbox/work",
  nodePath: "/usr/bin/node", // Official Node images use /usr/local/bin/node.
});

const result = await env.exec("git status --short", {
  timeout: 30,
  onOutput: (text) => process.stdout.write(text),
}, BACKGROUND_CONTEXT);
if (!result.ok) throw result.error;
console.log(`Exit code: ${result.value.exitCode}`);
```

The gateway authentication remains in the harness process. No host environment
variables or credentials are copied to the worker. `inheritEnv` applies to the
sandbox environment; explicit shell `env` overrides are sent to the sandbox.

## Use with Pi Durable

Install the standard `CodingTools` and supply `createOpenShellEnvResolver()` as
the harness's `env` option. Assign the existing sandbox in the same commit that
creates a conversation:

```js
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createOpenShellEnvResolver, SandboxDoc } from "pi-openshell";

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(storage, {
  models,
  registry,
  env: createOpenShellEnvResolver({ client: client.sandbox }),
}, context);

const conversation = await harness.createConversation({
  ownership: { kind: "ownerless" },
  agent: { model: { provider: "openai", modelId: "your-model" } },
  init: async (tx, id) => {
    const doc = await tx.doc(SandboxDoc, id);
    doc.binding = { id: sandbox.id, name: sandbox.name, workspace: sandbox.workspace };
    doc.cwd = "/sandbox/work";
  },
}, context);
```

`storage`, `models`, and `context` are the application's normal Pi Durable setup.
See [examples/durable.mjs](examples/durable.mjs) for a complete runnable harness
with SQLite storage, a real model provider, and the OpenShell SDK.

The document uses `fork: "initial"`. A conversation fork receives no sandbox
binding. Its tools fail without an environment until the application explicitly
assigns a sandbox. A transcript fork never implies a filesystem snapshot.

Each persistent store must have one harness owner at a time. The example's
SQLite store supports process-crash recovery; Pi's default SQLite durability
settings do not promise preservation of the latest commit after a power failure.

## Execution and recovery

- Each remote operation runs a dependency-free Node helper through the SDK's
  non-TTY interactive exec. Its source is read from this installed package and
  transmitted as an argument; paths and content are structured stdin data.
- Every actual filesystem access, symlink resolution, shell command, and spill
  file lives in the sandbox. POSIX path joining on the harness performs no I/O.
- Line readers stream with backpressure and preserve CRLF and whether the final
  line ends in a newline. Binary data uses base64 framing.
- Shell output streams as it arrives. Nonzero command exit codes remain normal
  `ShellExecResult` values for Pi's Bash tool to interpret. Timeouts, cancellation,
  and callback failures terminate the helper's shell process group.
- Each shell call terminates its shell process group on completion. A program
  that deliberately creates another process group can remain inside the sandbox;
  strict per-call process-tree ownership requires additional backend support.
  Sandbox teardown is the final cleanup boundary. Use a separate sandbox main
  process or explicit lifecycle API for background services.
- Full shell output spills into sandbox-local files when thresholds are crossed.
  Completed spills remain until the application or sandbox lifecycle removes them.
- Defaults are 8 MiB per file transfer, 1 MiB per streamed line, 10,000 directory
  entries, and 30 seconds per ordinary filesystem operation. Transfer limits are
  configurable. Line-reader lifetimes and shell calls follow their cancellation
  contexts; shell timeouts are explicit.
- A lost connection, malformed response, missing exit, or failed final RPC is an
  error. Operations are never retried automatically. A write or command may have
  taken effect before the error: treat that outcome as uncertain.

Keep arbitrary shell commands and mutations non-replayable in Pi. Neither the
adapter nor a transcript checkpoint makes external side effects exactly-once.

## Trust boundary

Only operator-approved JavaScript belongs in the managed harness. Custom tools,
hooks, wrappers, prompt renderers, and tasks execute there and can bypass
`ExecutionEnv` using native Node APIs. This package confines the work delegated
through its environment; it does not sandbox other plugins loaded into the host.

OpenShell's admitted filesystem and network policy enforce the worker boundary.
`cwd` is not a filesystem jail. Set static controls before sandbox creation and
keep sandbox management credentials outside agent-controlled code. Model calls
from the external harness use its own inference configuration; worker provider
attachments do not authorize those calls.

The adapter checks the bound sandbox UUID, name, and workspace before every
operation. Current public exec targets a sandbox by name, so this check is not
atomic with execution. Do not delete and reuse a bound name while a harness is
active. A server-side expected-UUID precondition is required to remove this race.

## Develop and verify

```shell
npm ci
npm run check
npm pack --dry-run
```

Tests execute the actual helper in child processes through a test-only SDK
fixture, then drive Pi Durable's real built-in read/write/edit/bash tools through
the adapter. They also check fork behavior, binary and metacharacter handling,
spill preservation, cancellation of descendants, stale bindings, and incomplete
transport responses. The test fixture is not a local fallback shipped to users.

For a live SDK/gateway test, install the SDK and provide an existing sandbox:

```shell
OPENSHELL_ENDPOINT=http://127.0.0.1:17670 \
OPENSHELL_SANDBOX=worker \
OPENSHELL_CWD=/sandbox/work \
node examples/smoke.mjs
```

Optional variables are `OPENSHELL_WORKSPACE` (default `default`),
`OPENSHELL_NODE_PATH` (default `/usr/bin/node`), `OPENSHELL_TOKEN`, and the PEM
file paths `OPENSHELL_CA_FILE`, `OPENSHELL_CLIENT_CERT_FILE`, and
`OPENSHELL_CLIENT_KEY_FILE`. TLS verification remains enabled.

The smoke test uses a unique temporary directory in the sandbox and removes
only that directory afterward. It does not create or delete sandboxes.
