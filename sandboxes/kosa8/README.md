# @sixb/sandboxes-kosa8

Run Sixb agent commands in [kosa8](https://kosa8.com) sandboxes: microVMs with their own kernel
that sleep with their memory and disk, and wake where they left off.

```text
Ephemeral (each agent run)          Named (a conversation's workspace)
──────────────────────────          ──────────────────────────────────
create → commands/files → destroy   create → run → stop (sleep) → resume → run → ...
```

[Setup](#setup) · [Sandbox API](#sandbox-api) · [Persistence](#persistence) ·
[Request credentials](#request-credentials) · [Networking](#networking) ·
[Configuration](#configuration) · [Development and tests](#development-and-tests)

## Setup

### 1. Install the provider

From an existing Sixb project running Bun 1.4.2 or later:

```sh
bun add @sixb/sandboxes-kosa8
```

The provider calls kosa8's REST API with `fetch`; it has no other dependency.

### 2. Create an API key

Sign in at [app.kosa8.com](https://app.kosa8.com), add a payment method, and create an API key for
your workers.

```dotenv
# .env.local for local development; use deployment environment variables in production
KOSA8_API_KEY=k8_...
```

The factory reads `KOSA8_API_KEY` when you don't pass `apiKey`. No kosa8 key ever reaches a
sandbox.

### 3. Configure Sixb

```ts
// sandbox.ts
import { Kosa8SandboxFactory } from "@sixb/sandboxes-kosa8"

export const sandboxes = new Kosa8SandboxFactory({
  region: "eu",
  timeout: 30_000,
})
```

Add the factory to your existing configuration. Keep your project's storage, models and other
providers:

```diff
 // sixb.config.ts
+import { sandboxes } from "./sandbox"

 export const sixb = createSixb({
   // Your existing project configuration...
+  sandboxes,
 })
```

### 4. Make the Sixb API reachable

The sandbox calls your **Sixb API server** to run commands such as `sixb objects get`, so the API
needs a public HTTPS URL. `http://localhost:3002` is inside the remote sandbox, not your laptop.
For local development, start a tunnel to the API port and pass its origin:

```sh
bun sixb dev --api-port 3002 --api-public-origin https://your-tunnel.example.dev
```

The agent worker adds the API origin to the sandbox's network, installs the Sixb CLI and the run
context, runs `sixb status`, and destroys the sandbox after the run.

## Sandbox API

Use the factory directly when you need commands and files outside an agent run:

```ts
import { sandboxes } from "./sandbox"

const sandbox = await sandboxes.create()
try {
  await sandbox.writeFiles([
    { path: "hello.txt", contents: "Hello from Sixb\n" },
    { path: "scripts/run.sh", contents: "#!/bin/bash\ncat hello.txt\n", mode: 0o755 },
  ])

  const result = await sandbox.runCommand("bash", ["scripts/run.sh"], {
    env: { TASK_ID: "example" },
    timeout: 10_000,
  })
  console.log(result.exitCode, result.stdout, result.stderr)
} finally {
  await sandbox.destroy()
}
```

| Behavior | Contract |
| --- | --- |
| Isolation | Every sandbox is its own microVM with its own kernel; no kosa8 credentials inside |
| Command user | UID/GID 65534, no groups, no capabilities, no new privileges; it can't use `sudo` |
| Arguments | Literal argv; use `bash -c` explicitly for shell syntax |
| Environment | Factory → create → command; later values win; nothing else of the guest's environment |
| Working directory | `/workspace/sixb` by default, owned by the command user; `HOME` is `/var/lib/sixb-home` |
| Timeout | Exit `137`, `timedOut: true`, output written before the deadline kept |
| Cancellation | Exit `137` without `timedOut`; the command and everything it started are killed |
| Background processes | A process started with `setsid ... &` keeps running between commands |
| Files | UTF-8 or bytes, nested paths, overwrite and POSIX modes, written as the command user |
| `stop()` | Puts the sandbox to sleep, keeping memory and disk; the handle rejects further calls |
| `destroy()` | Deletes the sandbox; repeated calls share the outcome |

The default image is kosa8's universal Ubuntu 24.04 image with Node, Python, Go, Rust, Java and
Git. Commands run as an unprivileged user, so `setup` can't install system packages. Build an image
with them instead and pass `image`; it needs `setpriv`, Bash and Bun or Node. `docker: true` runs
dockerd in the sandbox.

kosa8's files API reaches only `/workspace`, where the provider stages uploads in a root-only
directory. `/workspace` itself stays root's, so the working directory is a directory inside it, or
any other directory of the sandbox's own; `/workspace` itself is refused.

## Persistence

Conversation [sandbox bindings](../../docs/sandboxes/overview.md#keep-files-across-conversation-runs)
keep a thread's workspace between runs. On kosa8 that is one sandbox per thread, asleep between
runs:

```ts
const sandbox = await sandboxes.create({ persistence: { name: "my-workspace" } })
await sandbox.writeFiles([{ path: "draft.txt", contents: "Work in progress" }])
await sandbox.stop()

const resumed = await sandboxes.resume("my-workspace")
await resumed.runCommand("cat", ["draft.txt"])
await resumed.stop()
```

- `stop()` first removes the session's request credentials and closes the sandbox's egress, then
  puts it to sleep. Files, installed packages and running processes are there on resume.
- `resume()` wakes the sandbox, applies the new session's network and credentials, and never runs
  `setup` again. It rejects a sandbox that is still running, and throws
  `SandboxStateUnavailableError` for a name with no sandbox.
- Creation never attaches to an existing name. A failed creation leaves the sandbox asleep rather
  than deleting state another attempt may own.
- The sandbox is named after a digest of the sandbox name and labelled `sixb-sandbox=<name>`.
  Names are scoped to the API key's organization; the caller serializes each name's lifecycle,
  since kosa8 does not itself keep names unique.
- Sandboxes never sleep on their own (`sleep_after_s: 0`): only `stop()` puts one to sleep.
- `destroy()` deletes the sandbox and its state for good.

## Request credentials

The factory supports request credentials (`supportsRequestCredentials`), such as the run token the
agent worker adds to every call its commands make to the Sixb API. A forwarder runs as root in the
sandbox and holds them; `credentialedUrl(url)` is its socket under `/var/lib/sixb-forward`, which
forwards only to `url` and adds the credential that matches the request. The credentials reach the
sandbox in the environment of root's install step, never in a command's arguments, and kosa8's
audit log records only the names of an exec's environment. Commands run as UID 65534, which cannot
read them. Pass credentials to `create()` or `resume()`; a factory default is refused. A
credential's origin must be in the sandbox's network.

## Networking

```ts
// Default: no outbound network.
const offline = await sandboxes.create({ network: { mode: "none" } })

// Only the listed hosts.
const restricted = await sandboxes.create({
  network: {
    mode: "restricted",
    allow: [{ name: "sixb-api", origin: "https://api.example.com" }],
  },
})

// Unrestricted outbound network.
const connected = await sandboxes.create({ network: { mode: "all" } })
```

| Policy | Behavior |
| --- | --- |
| `none` or restricted with `allow: []` | The sandbox reaches nothing |
| `restricted` | Only the listed origins' hosts, any port |
| `all` | Unrestricted outbound network |

kosa8 enforces the policy on the sandbox's host, outside the VM, from its first boot, and each
resume applies the new session's policy. A kosa8 sandbox runs remotely, so loopback and private
addresses are refused: allow a public origin instead. IPv6 addresses are refused too.

## Configuration

| Factory option | Default / requirement |
| --- | --- |
| `apiKey` | `KOSA8_API_KEY` |
| `region` | kosa8's choice; `us`, `eu`, `us-ash1` or `eu-hel1` |
| `size` | `2x4`; `2x4`, `4x8`, `8x16` or `16x32` (vCPU x GiB) |
| `image` | kosa8's universal image; an image needs `setpriv`, Bash and Bun or Node |
| `diskGb` | kosa8's default; 8 to 200 |
| `docker` | `false`; `true` runs dockerd in the sandbox |
| `ttlSeconds` | None; 60 to 7776000, after which kosa8 deletes the sandbox regardless |
| `namePrefix` | `sixb-` |
| `labels` | None; added to every sandbox |
| `workingDirectory` | `/workspace/sixb` |
| `env` | No caller-supplied values |
| `network` | `{ mode: "none" }` |
| `timeout` | No per-command timeout |
| `readyTimeoutMs` | `120_000` ms for a new or resumed sandbox to accept commands |
| `setupTimeoutMs` | `60_000` ms for each of the provider's own steps, such as installing credentials |
| `baseURL` | `https://api.kosa8.com`; a self-hosted control plane's URL otherwise |

`create()` and `resume()` can override `workingDirectory`, `env`, `network` and `timeout`.

> **Cleanup:** always call `destroy()` for ephemeral work. A sandbox left behind keeps running until
> you delete it, unless `ttlSeconds` is set. Set `labels` to find your workers' sandboxes.

## Development and tests

<details>
<summary>Commands for contributors working in the Sixb repository</summary>

```sh
bun test sandboxes/kosa8/tests/
```

The unit tests run against an in-memory kosa8 and a recorded `fetch`. Live tests create real
sandboxes with the key in `KOSA8_API_KEY`, and destroy them. `KOSA8_REGION` selects the region and
`KOSA8_API_URL` another API:

```sh
SIXB_KOSA8_E2E=1 bun test --timeout 300000 \
  ./sandboxes/kosa8/tests/sandbox.e2e.ts \
  ./sandboxes/kosa8/tests/persistence.e2e.ts
```

The request credentials suite and the agent runtime test need public HTTPS origins that forward to
a local port, such as tunnels:

```sh
SIXB_KOSA8_E2E=1 \
SIXB_KOSA8_CREDENTIALS_ORIGINS=https://a.example.dev,https://b.example.dev \
SIXB_KOSA8_CREDENTIALS_PORT=8000 \
bun test --timeout 300000 ./sandboxes/kosa8/tests/credentials.e2e.ts

SIXB_KOSA8_E2E=1 SIXB_KOSA8_AGENT_ORIGIN=https://a.example.dev SIXB_KOSA8_AGENT_PORT=8000 \
bun test --timeout 300000 ./sandboxes/kosa8/tests/agent-runtime.e2e.ts
```

The agent test uses a deterministic model, synthetic data and the real worker, CLI and run-token
API. It answers only run-token requests on the public origin.

</details>
