import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  GUEST_CREDENTIAL_PATHS,
  SandboxError,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  SandboxStateUnavailableError,
} from "@sixb/core/sandboxes"
import { Kosa8SandboxFactory } from "../src"
import { GUEST_PATHS, RUN_MARKER } from "../src/guest"
import { persistentSandboxName, SANDBOX_NAME_LABEL } from "../src/kosa8-sandbox-factory"
import { FakeKosa8 } from "./kosa8-fixture"

const API = "https://api.example.com"
const SECRET = "Bearer secret-run-token"
const credential: SandboxRequestCredential = {
  origin: API,
  path: { prefix: "/api/" },
  method: ["GET", "POST"],
  headers: { Authorization: SECRET },
}
const network = { mode: "restricted" as const, allow: [{ name: "api", origin: API }] }

function factory(
  kosa8: FakeKosa8,
  options: ConstructorParameters<typeof Kosa8SandboxFactory>[0] = {}
) {
  return new Kosa8SandboxFactory(options, () => kosa8)
}

afterEach(() => {
  jest.useRealTimers()
})

describe("sandboxes", () => {
  test("are created with the session's egress from the first boot, then prepared", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8, {
      size: "4x8",
      region: "eu",
      diskGb: 40,
      ttlSeconds: 3600,
      docker: true,
      image: "ghcr.io/acme/agent:1",
      labels: { team: "ops" },
    }).create({ network })

    expect(kosa8.creates[0]).toMatchObject({
      size: "4x8",
      region: "eu",
      diskGb: 40,
      ttlSeconds: 3600,
      docker: true,
      image: "ghcr.io/acme/agent:1",
      egress: { internet: false, allow: ["api.example.com"] },
      labels: { team: "ops" },
    })
    expect(kosa8.creates[0]?.name).toMatch(/^sixb-[0-9a-f]{20}$/)
    expect(kosa8.calls.slice(1, 3)).toEqual([`ready ${sandbox.id}`, `exec ${sandbox.id}`])
    const bootstrap = kosa8.execs[0]
    expect(bootstrap?.argv).toContain("/workspace/sixb")
    expect(bootstrap?.argv).toContain(GUEST_PATHS.home)
    expect(bootstrap?.argv).toContain(GUEST_PATHS.files)
    expect(sandbox.workingDirectory).toBe("/workspace/sixb")
    expect(sandbox.provider).toBe("kosa8")
  })

  test("default to the smallest size and leave optional settings to kosa8", async () => {
    const kosa8 = new FakeKosa8()
    await factory(kosa8).create()
    expect(kosa8.creates[0]).toEqual({
      name: kosa8.creates[0]?.name ?? "",
      size: "2x4",
      egress: { internet: false, allow: [] },
      labels: {},
    })
  })

  test("map none and an empty allow list to no egress, and all to the open internet", async () => {
    const kosa8 = new FakeKosa8()
    const sandboxes = factory(kosa8)
    await sandboxes.create()
    await sandboxes.create({ network: { mode: "restricted", allow: [] } })
    await sandboxes.create({ network: { mode: "all" } })
    expect(kosa8.creates.map((request) => request.egress)).toEqual([
      { internet: false, allow: [] },
      { internet: false, allow: [] },
      { internet: true, allow: [] },
    ])
  })

  test("are deleted when an ephemeral create fails after provisioning", async () => {
    const kosa8 = new FakeKosa8()
    kosa8.script = (exec) =>
      exec.line.includes("command -v setpriv") ? { exitCode: 21 } : undefined
    const error = await factory(kosa8)
      .create()
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("setpriv")
    expect(kosa8.calls).toContain("delete sbx-1")
    expect(kosa8.sandboxes.size).toBe(0)
  })

  test("reject a system directory or the files root as the working directory", async () => {
    const kosa8 = new FakeKosa8()
    for (const workingDirectory of [
      "/",
      "/tmp",
      "/etc/app",
      "/usr",
      "/workspace",
      GUEST_PATHS.files,
      `${GUEST_PATHS.files}/x`,
    ]) {
      const error = await factory(kosa8)
        .create({ workingDirectory })
        .catch((caught) => caught)
      expect(error).toBeInstanceOf(SandboxError)
    }
    expect(kosa8.creates).toHaveLength(0)
    await factory(kosa8).create({ workingDirectory: "/tmp/run" })
    await factory(kosa8).create({ workingDirectory: "/workspace/app" })
    expect(kosa8.creates).toHaveLength(2)
  })

  test("name the missing key when kosa8 refuses", async () => {
    const saved = process.env.KOSA8_API_KEY
    delete process.env.KOSA8_API_KEY
    try {
      const kosa8 = new FakeKosa8()
      kosa8.failCreate = new Error("unauthorized")
      const error = await factory(kosa8)
        .create()
        .catch((caught) => caught)
      expect(error.message).toContain("Set KOSA8_API_KEY")
    } finally {
      if (saved !== undefined) process.env.KOSA8_API_KEY = saved
    }
  })
})

describe("commands", () => {
  test("run as the unprivileged user with exactly the sandbox and call env", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8, { env: { A: "factory", B: "factory" } }).create({
      env: { B: "create" },
    })
    kosa8.script = () => ({ stdout: "out", stderr: "err", exitCode: 3 })
    const result = await sandbox.runCommand("echo", ["it's"], { env: { C: "call" }, cwd: "src" })

    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err" })
    const argv = kosa8.execs.at(-1)?.argv ?? []
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"])
    expect(argv).toContain("--reuid=65534")
    expect(argv).toContain("--no-new-privs")
    expect(argv).toContain(`HOME=${GUEST_PATHS.home}`)
    expect(argv.filter((arg) => /^[ABC]=/.test(arg))).toEqual(["A=factory", "B=create", "C=call"])
    expect(argv.slice(-3)).toEqual(["/workspace/sixb/src", "echo", "it's"])
    // The command's own env goes in its argv, as root's env never reaches it.
    expect(kosa8.execs.at(-1)?.env).toEqual({})
  })

  test("time out: the command and its processes are ended, keeping output", async () => {
    jest.useFakeTimers()
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8, { timeout: 60_000 }).create()
    kosa8.script = (exec) => (exec.argv[0] === "/bin/bash" ? undefined : "hang")
    const running = sandbox.runCommand("sleep", ["30"], { timeout: 1_000 })
    jest.advanceTimersByTime(1_000)
    const result = await running

    expect(result).toMatchObject({
      exitCode: 137,
      timedOut: true,
      stdout: "partial out\n",
      stderr: "partial err\n",
    })
    expect(kosa8.closed).toHaveLength(1)
    // Closing the stream only stops listening: the run's marker finds what it started.
    const marker = kosa8.execs.at(-2)?.argv.find((arg) => arg.startsWith(`${RUN_MARKER}=`))
    const end = kosa8.execs.at(-1)
    expect(end?.argv.slice(0, 2)).toEqual(["/bin/bash", "-c"])
    expect(end?.argv.at(-1)).toBe(marker)
  })

  test("abort kills the command without marking it timed out", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    kosa8.script = (exec) => (exec.argv[0] === "/bin/bash" ? undefined : "hang")
    const controller = new AbortController()
    const running = sandbox.runCommand("sleep", ["30"], { signal: controller.signal })
    controller.abort()
    const result = await running
    expect(result.exitCode).toBe(137)
    expect(result.timedOut).toBeUndefined()
  })

  test("report a failed call as a SandboxError, never as a command's exit", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    kosa8.script = () => new Error("connection reset")
    const error = await sandbox.runCommand("true").catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("connection reset")
  })

  test("reject env names the guest can't carry, the run marker included", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    const envs: Record<string, string>[] = [{ "A=B": "x" }, { [RUN_MARKER]: "x" }]
    for (const env of envs) {
      const error = await sandbox.runCommand("true", [], { env }).catch((caught) => caught)
      expect(error).toBeInstanceOf(SandboxError)
    }
  })
})

describe("files", () => {
  test("upload to staging and are copied into place by the command user", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    await sandbox.writeFiles([
      { path: "notes/a.txt", contents: "hello" },
      { path: "/workspace/sixb/run.sh", contents: "#!/bin/sh\n", mode: 0o755 },
    ])

    expect(kosa8.uploads.map((upload) => upload.path.startsWith(`${GUEST_PATHS.files}/`))).toEqual([
      true,
      true,
    ])
    const place = kosa8.execs.at(-1)
    const argv = place?.argv ?? []
    expect(argv).toContain("--reuid=65534")
    const at = argv.indexOf("/workspace/sixb/notes/a.txt")
    expect(argv[at + 1]).toBe("")
    expect(argv[argv.indexOf("/workspace/sixb/run.sh") + 1]).toBe("755")
    // The bytes go through the upload alone; root opens and then removes the staged copies.
    expect(place?.line).not.toContain("hello")
    expect(argv[2]).toContain("chmod 644")
    expect(argv[2]).toContain("rm -f --")
  })

  test("an empty batch does nothing", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    const before = kosa8.calls.length
    await sandbox.writeFiles([])
    expect(kosa8.calls.length).toBe(before)
  })

  test("a failed upload is a SandboxError", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    kosa8.failUpload = new Error("disk full")
    const error = await sandbox.writeFiles([{ path: "a", contents: "b" }]).catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("disk full")
  })
})

describe("request credentials", () => {
  test("reach root's install step in its env, before setup runs, never in argv", async () => {
    const kosa8 = new FakeKosa8()
    kosa8.script = (exec) =>
      exec.line.includes("forwarder.pid") && exec.env.SIXB_GUEST_STATE
        ? { exitCode: 10 }
        : undefined
    const sandbox = await factory(kosa8, { setup: ["make setup"] }).create({
      network,
      requestCredentials: [credential],
    })

    for (const exec of kosa8.execs) expect(exec.line).not.toContain("secret-run-token")
    expect(kosa8.uploads.some((upload) => upload.contents.includes("secret-run-token"))).toBe(false)
    const install = kosa8.execs.findIndex((exec) =>
      Object.values(exec.env).some((value) => value.includes("secret-run-token"))
    )
    expect(install).toBeGreaterThan(0)
    expect(kosa8.execs[install]?.argv.includes("--reuid=65534")).toBe(false)
    expect(kosa8.execs.some((exec) => exec.argv[2]?.startsWith("setsid -f"))).toBe(true)
    const setup = kosa8.execs.findIndex((exec) => exec.line.includes("make setup"))
    expect(setup).toBeGreaterThan(install)
    expect(sandbox.credentialedUrl?.(API)).toMatch(
      /^unix:\/var\/lib\/sixb-forward\/[0-9a-f]+\.sock$/
    )
  })

  test("are rejected for an origin the network does not allow, before provisioning", async () => {
    const kosa8 = new FakeKosa8()
    const sandboxes = factory(kosa8)
    for (const options of [
      { requestCredentials: [credential] },
      {
        network: { mode: "restricted" as const, allow: [{ name: "x", origin: "https://x.dev" }] },
        requestCredentials: [credential],
      },
    ]) {
      const error = await sandboxes.create(options).catch((caught) => caught)
      expect(error).toBeInstanceOf(SandboxError)
      expect(error.message).not.toContain("secret-run-token")
    }
    expect(kosa8.creates).toHaveLength(0)
  })

  test("a failed install names the sandbox, not what it was given", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create({ network })
    kosa8.script = (exec) =>
      exec.env.SIXB_GUEST_STATE ? { exitCode: 1, stderr: SECRET } : undefined
    const error = await sandbox.setRequestCredentials?.([credential]).catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).not.toContain("secret")
    expect(error.message).toContain(sandbox.id)
  })

  test("a factory default is refused", () => {
    expect(
      () =>
        new Kosa8SandboxFactory(
          { requestCredentials: [credential] } as never,
          () => new FakeKosa8()
        )
    ).toThrow("never as a factory default")
  })
})

describe("lifecycle", () => {
  // Guard proof: drop confirmSleeping() from stopRemote(); the resume right after stop finds the
  // sandbox still running and the persistence test below fails.
  test("stop sleeps once for every caller, and later operations reject", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    await Promise.all([sandbox.stop(), sandbox.stop()])
    expect(kosa8.calls.filter((call) => call.startsWith("sleep"))).toHaveLength(1)
    expect(sandbox.status).toBe("stopped")
    const error = await sandbox.runCommand("true").catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxNotRunningError)
    const write = await sandbox.writeFiles([{ path: "a", contents: "b" }]).catch((caught) => caught)
    expect(write).toBeInstanceOf(SandboxNotRunningError)
  })

  test("destroy deletes the sandbox by id, once, and treats an absent one as gone", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    await sandbox.destroy()
    await sandbox.destroy()
    expect(kosa8.calls.filter((call) => call.startsWith("delete"))).toEqual([
      `delete ${sandbox.id}`,
    ])

    const other = await factory(kosa8).create()
    kosa8.sandboxes.delete(other.id)
    await other.destroy()
  })

  test("destroy still deletes when sleeping fails", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create()
    kosa8.failSleep = new Error("busy")
    await sandbox.destroy()
    expect(kosa8.sandboxes.has(sandbox.id)).toBe(false)
  })
})

describe("persistence", () => {
  const name = `sixb-sb-${"a".repeat(64)}`

  test("names the sandbox after a digest and keeps the sandbox name in a label", async () => {
    const kosa8 = new FakeKosa8()
    await factory(kosa8).create({ persistence: { name } })
    const request = kosa8.creates[0]
    expect(request?.name).toBe(persistentSandboxName("sixb-", name))
    expect(request?.name.length).toBeLessThanOrEqual(63)
    expect(request?.labels[SANDBOX_NAME_LABEL]).toBe(name)
  })

  test("an existing name fails and nothing is overwritten", async () => {
    const kosa8 = new FakeKosa8()
    await factory(kosa8).create({ persistence: { name } })
    const error = await factory(kosa8)
      .create({ persistence: { name } })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.message).toContain("already exists")
    expect(kosa8.creates).toHaveLength(1)
  })

  // Guard proof: delete instead of sleep in create()'s persistent catch; this test fails.
  test("a failed persistent create keeps the sandbox asleep instead of deleting it", async () => {
    const kosa8 = new FakeKosa8()
    kosa8.script = (exec) =>
      exec.line.includes("command -v setpriv") ? { exitCode: 1 } : undefined
    await factory(kosa8)
      .create({ persistence: { name } })
      .catch(() => {})
    expect(kosa8.calls).toContain("sleep sbx-1")
    expect(kosa8.calls.some((call) => call.startsWith("delete"))).toBe(false)
  })

  test("stop removes credentials and egress before sleeping", async () => {
    const kosa8 = new FakeKosa8()
    const sandbox = await factory(kosa8).create({
      persistence: { name },
      network,
      requestCredentials: [credential],
    })
    await sandbox.stop()
    const id = sandbox.id
    const egress = kosa8.calls.lastIndexOf(`egress ${id} {"internet":false,"allow":[]}`)
    expect(egress).toBeGreaterThan(0)
    expect(kosa8.calls.indexOf(`sleep ${id}`)).toBeGreaterThan(egress)
    const emptied = kosa8.execs.filter((exec) => exec.env.SIXB_GUEST_STATE !== undefined).at(-1)
    expect(emptied?.env.SIXB_GUEST_CREDENTIALS).toBe("[]")
  })

  test("resume wakes the sandbox and applies this session, without replaying setup", async () => {
    const kosa8 = new FakeKosa8()
    const sandboxes = factory(kosa8, { setup: ["make setup"] })
    const created = await sandboxes.create({ persistence: { name } })
    await created.stop()
    const before = kosa8.execs.length

    const resumed = await sandboxes.resume(name, { network, requestCredentials: [credential] })
    expect(resumed.id).toBe(created.id)
    expect(kosa8.calls).toContain(`wake ${created.id}`)
    expect(kosa8.egress.get(created.id)).toEqual({ internet: false, allow: ["api.example.com"] })
    const after = kosa8.execs.slice(before)
    expect(after.some((exec) => exec.line.includes("make setup"))).toBe(false)
    expect(
      after.some((exec) => exec.env.SIXB_GUEST_CREDENTIALS?.includes("secret-run-token"))
    ).toBe(true)
  })

  test("resume of a missing name is missing state; a running one is refused", async () => {
    const kosa8 = new FakeKosa8()
    const sandboxes = factory(kosa8)
    const missing = await sandboxes.resume(name).catch((caught) => caught)
    expect(missing).toBeInstanceOf(SandboxStateUnavailableError)

    await sandboxes.create({ persistence: { name } })
    const running = await sandboxes.resume(name).catch((caught) => caught)
    expect(running).toBeInstanceOf(SandboxError)
    expect(running).not.toBeInstanceOf(SandboxStateUnavailableError)
    expect(running.message).toContain("must be stopped")
  })

  test("resume never classifies a transport failure as missing state", async () => {
    const kosa8 = new FakeKosa8()
    kosa8.failFind = new Error("unavailable")
    const error = await factory(kosa8)
      .resume(name)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).not.toBeInstanceOf(SandboxStateUnavailableError)
  })

  test("resume refuses a sandbox whose label names another sandbox", async () => {
    const kosa8 = new FakeKosa8()
    kosa8.seed({
      id: "sbx-9",
      name: persistentSandboxName("sixb-", name),
      state: "sleeping",
      labels: { [SANDBOX_NAME_LABEL]: "another" },
    })
    const error = await factory(kosa8)
      .resume(name)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxStateUnavailableError)
    expect(kosa8.calls).not.toContain("wake sbx-9")
  })

  test("resume takes session options only", async () => {
    const error = await factory(new FakeKosa8())
      .resume(name, { persistence: { name } } as never)
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(SandboxError)
  })
})

test("the credential state stays root's", () => {
  expect(GUEST_CREDENTIAL_PATHS.state.startsWith("/workspace")).toBe(false)
})
