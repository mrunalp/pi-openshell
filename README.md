# pi-openshell

Run Pi Durable's coding tools in an existing OpenShell sandbox while the trusted
harness, model client, and durable storage stay outside it.

Model HTTP requests can also run through a sandbox helper. An attached OpenShell
provider supplies an opaque credential placeholder; OpenShell substitutes the
real API key at the profile-authorized endpoint. The Pi process needs no model
API key.

This first version implements Pi Durable 1.0.0's complete `ExecutionEnv`
interface and a conversation-to-sandbox document resolver. Sandbox provisioning,
automatic cleanup of sandboxes, execution reattachment, and an interactive Pi
coding-agent extension are follow-up work. This is a Durable application package;
it does not currently register an extension through `pi install`.

## Architecture

```mermaid
flowchart TB
  subgraph host["Trusted harness host"]
    direction LR
    pi["Pi Durable harness + CodingTools<br/>Operator-approved plugins and hooks"]
    storage[("Durable storage<br/>Conversation + SandboxDoc")]
    adapter["pi-openshell<br/>Env resolver + ExecutionEnv"]
    inference["Pi OpenAI provider<br/>OpenShell fetch bridge"]
    sdk["OpenShell TypeScript SDK<br/>Gateway credentials"]
    pi <--> storage
    pi -->|"read / write / edit / bash"| adapter
    storage -.->|"workspace, name, UUID, cwd"| adapter
    adapter --> sdk
    pi -->|"Model requests"| inference
    inference --> sdk
  end

  model["Model provider"]
  gateway["OpenShell gateway<br/>Authentication + sandbox lifecycle"]
  provider[("OpenShell provider<br/>Real key + endpoint profile")]
  gateway --> provider
  host <-->|"Authenticated SDK exec RPC"| gateway

  subgraph managed["OpenShell managed execution"]
    direction LR
    enforcement["Trusted supervisor + runtime<br/>Filesystem, network and process policy"]
    subgraph worker["Sandboxed Linux workload"]
      direction LR
      helper["Node helpers<br/>Tool I/O + model HTTP requests"]
      shell["Bash + command descendants"]
      files[("Workspace + temporary files<br/>Output spills")]
      helper --> shell
      helper <--> files
      shell <--> files
    end
    enforcement <-->|"Helper request / cancellation; streamed results"| worker
  end

  gateway <-->|"Managed exec session"| managed
  provider -.->|"Attached provider"| managed
  managed <-->|"Native model API; proxy substitutes the real key"| model

  classDef trusted fill:#e8f0fe,stroke:#3568a8,color:#172b4d;
  classDef control fill:#e8f5e9,stroke:#388e3c,color:#173c20;
  classDef sandboxed fill:#fff3e0,stroke:#d97706,color:#4a2c0b;
  class pi,storage,adapter,inference,sdk trusted;
  class gateway,provider,enforcement control;
  class helper,shell,files sandboxed;
```

The application attaches an existing sandbox to each conversation. The resolver
reads that binding from `SandboxDoc`; the adapter verifies it and delegates tool
I/O through the SDK. Helper code runs inside the workload, where OpenShell policy
constrains filesystem access, networking, and processes. Pi, this package, and
the SDK do not need to be installed in the workload image.

The model client, durable state, and gateway credentials remain on the host.
Model HTTP connections originate inside the sandbox; real model credentials
remain in OpenShell's trusted components and are substituted by its network proxy.
Host plugins and hooks remain trusted JavaScript and can use native Node APIs;
`ExecutionEnv` confines only work routed through it. Provisioning and sandbox
teardown belong to the application; this adapter attaches to existing sandboxes.

## Install

Node.js 22.19 or later is required on the harness host. The workload image needs
Node.js 22 or later and Bash in a Linux workload; it does not need Pi, this package,
or the OpenShell SDK. Its filesystem policy must permit the working and temporary
directories, executable/library paths, and read access to `/proc` process metadata
for descendant cleanup. Commands receive immediate stdin EOF through a pipe;
the adapter does not require access to `/dev/null`.

```shell
npm install git+https://github.com/mrunalp/pi-openshell.git @earendil-works/pi-durable@1.0.0 @earendil-works/pi-ai@1.0.0
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

The example uses `createOpenShellOpenAIProvider()` as described below. It does
not read a model API key from the host.

The document uses `fork: "initial"`. A conversation fork receives no sandbox
binding. Its tools fail without an environment until the application explicitly
assigns a sandbox. A transcript fork never implies a filesystem snapshot.

Each persistent store must have one harness owner at a time. The example's
SQLite store supports process-crash recovery; Pi's default SQLite durability
settings do not promise preservation of the latest commit after a power failure.

## Model credentials through OpenShell

The OpenAI Responses integration keeps Pi's model client on the host and sends
its HTTP requests through a Node helper in the bound sandbox. The helper reads
`OPENAI_API_KEY` from the sandbox's provider environment, where OpenShell supplies
an opaque placeholder. OpenShell checks network policy and credential endpoint
binding before substituting the stored key. The bridge never retrieves a key or
placeholder into the harness and never copies host auth headers into a request.

Review [providers/openai-node.yaml](providers/openai-node.yaml) for your workload
image, then import it and attach a provider to the existing sandbox:

```shell
openshell profile lint -f providers/openai-node.yaml
openshell profile import -f providers/openai-node.yaml
openshell provider create --name pi-openai --type pi-openai-node --from-existing
openshell sandbox provider attach worker pi-openai --wait
```

`--from-existing` discovers the credential in the operator's setup environment.
Once the provider is created, launch Pi without that key:

```shell
env -u OPENAI_API_KEY \
  OPENSHELL_ENDPOINT=https://gateway.example.com \
  OPENSHELL_SANDBOX=worker \
  PI_MODEL=gpt-4.1-mini \
  node examples/durable.mjs "Inspect the workspace"
```

Add the gateway token or mTLS file variables described in the live-test section
when required. In an application, register the managed model provider:

```js
import { createModels } from "@earendil-works/pi-ai/models";
import { createOpenShellOpenAIProvider } from "pi-openshell";

const provider = createOpenShellOpenAIProvider({
  client: client.sandbox,
  binding: { id: sandbox.id, name: sandbox.name, workspace: sandbox.workspace },
});
const models = createModels();
models.setProvider(provider);
// Pass models to Harness.open(); call provider.cleanup() after closing it.
```

Requests use SSE, preserve HTTP errors, and stream response bodies back to Pi.
The factory pins the native base URL and transport, uses a non-secret Pi auth
sentinel, and disables retries. The bridge rejects URL escapes and does not
follow redirects. Missing or revoked provider access fails without direct host
networking. Request bodies default to an 8 MiB limit; calls default to a ten-minute
timeout. HTTP redirects and WebSocket transports are not supported.

For an OpenAI-compatible endpoint, set `baseUrl` and import a separate profile
authorizing that endpoint. `credentialEnv` selects its sandbox placeholder
variable. `allowHttp: true` is available for an explicitly configured local HTTP
service. `createOpenShellFetch()` also exposes the transport directly for custom
clients; automatic Pi provider setup currently covers OpenAI Responses only.

The model provider's binding is application configuration, independent of the
conversation's tool environment. Use a separate provider-attached sandbox for
inference if coding commands should have no model-network access. Pass that
sandbox's binding to the factory and keep the tool resolver binding unchanged.
Sharing a sandbox grants model access to processes admitted by its effective
policy; removing the real key does not prevent authorized API usage or spending.

## Execution and recovery

- Each remote operation runs a dependency-free Node helper through the SDK's
  non-TTY interactive exec. Its source is read from this installed package and
  transmitted as an argument; paths and content are a structured stdin frame.
- Every actual filesystem access, symlink resolution, shell command, and spill
  file lives in the sandbox. POSIX path joining on the harness performs no I/O.
- Line readers stream with backpressure and preserve CRLF and whether the final
  line ends in a newline. Binary data uses base64 framing.
- Shell output streams as it arrives. Nonzero command exit codes remain normal
  `ShellExecResult` values for Pi's Bash tool to interpret. Timeouts, cancellation,
  and callback failures stop ordinary members of the helper's shell process group.
- Cancellation sends a control frame and keeps the exec stream alive while the
  helper stops and reaps the command. It falls back to transport cancellation
  after two seconds. A lost connection or forced helper termination can leave
  descendants running; sandbox teardown remains the final cleanup boundary.
- OpenShell denies workload group/broadcast signals. The helper reads `/proc`
  metadata, freezes matching group members, and signals them individually through
  OpenShell's broker. It checks group membership and process birth times and
  refuses to act on a replacement group leader.
- On completion the helper cleans up ordinary members of its shell process group.
  A program that deliberately creates another process group can remain inside the sandbox;
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
through `createOpenShellOpenAIProvider()` use the bound sandbox's attached
provider and effective network policy. Other host model clients retain their
own inference configuration and can bypass this integration.

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
npm run test:live
```

Optional variables are `OPENSHELL_WORKSPACE` (default `default`),
`OPENSHELL_NODE_PATH` (default `/usr/bin/node`), `OPENSHELL_TOKEN`, and the PEM
file paths `OPENSHELL_CA_FILE`, `OPENSHELL_CLIENT_CERT_FILE`, and
`OPENSHELL_CLIENT_KEY_FILE`. TLS verification remains enabled.

The live tests check text and binary transfers (including a 2 MiB file), streamed
lines, shell output, nonzero exit codes, spill files, timeout and cancellation of
descendants, and Pi Durable's actual read/write/edit/bash tools. A deterministic
model drives the harness; no model API key is required. The Durable test also
checks that an unbound conversation fork cannot modify the assigned sandbox.

Each tool test uses a unique temporary directory in the sandbox and removes that
directory afterward. The tests do not create or delete sandboxes.

For provider injection, use a local gateway reachable from this machine's
`host.openshell.internal` address. From this source checkout, with the same
gateway/TLS variables set, run:

```shell
npm run test:provider:live
```

This separate test creates a temporary profile, provider with a synthetic key,
and sandbox. A host-local mock Responses API verifies the substituted key while
Pi's real OpenAI client streams its response. It also checks that the workload
receives a placeholder and provider detachment blocks the next call. The test
removes those resources afterward. It uses local HTTP and no paid model service;
the caller needs permission to manage profiles, providers, and sandboxes.

Locally verified on October 1, 2026 with Pi Durable 1.0.0, the TypeScript SDK and
gateway/runtime/supervisor built from OpenShell commit `76cfd0e31d5e`, rootless
Podman, mTLS, and the community base workload image with Node 22.22.1. An explicit
policy granted filesystem access and `/proc` metadata, with no network grants.
Tool tests used a deterministic model. The provider test additionally verified
real OpenShell substitution against the local mock Responses API, with Pi's real
OpenAI client. Paid provider calls, external upstream TLS, and crash recovery were
not exercised.
