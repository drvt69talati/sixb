import { expect, test } from "bun:test"
import {
  createKosa8Client,
  EXEC_LINE_ENV,
  execBody,
  Kosa8ApiError,
  shellQuote,
} from "../src/kosa8-client"

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string
}

/** A fetch that records each request and answers from `answer`. */
function fakeFetch(answer: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body
    const request: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body:
        body === undefined || body === null
          ? ""
          : typeof body === "string"
            ? body
            : new TextDecoder().decode(body as Uint8Array),
    }
    seen.push(request)
    return answer(request)
  }) as typeof fetch
  return { seen, fetcher }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const frames = (...lines: unknown[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { status: 200 })

const b64 = (text: string) => Buffer.from(text).toString("base64")

test("creates a persistent sandbox that never sleeps on its own, with the key as a bearer", async () => {
  const { seen, fetcher } = fakeFetch(() =>
    json(202, { sandbox: { id: "sbx_1", name: "sixb-a", state: "creating", labels: {} } })
  )
  const client = createKosa8Client({ apiKey: "k8_test", fetch: fetcher })
  const record = await client.create({
    name: "sixb-a",
    size: "2x4",
    region: "eu",
    diskGb: 20,
    ttlSeconds: 600,
    docker: true,
    egress: { internet: false, allow: ["api.example.com"] },
    labels: { team: "ops" },
  })

  expect(record).toEqual({ id: "sbx_1", name: "sixb-a", state: "creating", labels: {} })
  expect(seen[0]?.method).toBe("POST")
  expect(seen[0]?.url).toBe("https://api.kosa8.com/v1/sandboxes")
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer k8_test")
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
    name: "sixb-a",
    size: "2x4",
    labels: { team: "ops" },
    persistent: true,
    sleep_after_s: 0,
    disk_gb: 20,
    region: "eu",
    docker: true,
    ttl_s: 600,
    egress: { internet: false, allow: ["api.example.com"] },
  })
})

test("reads an API refusal's status and code", async () => {
  const { fetcher } = fakeFetch(() =>
    json(404, { error: "not_found", message: "no sandbox sbx_9" })
  )
  const error = await createKosa8Client({ apiKey: "k", fetch: fetcher })
    .get("sbx_9")
    .catch((caught) => caught)
  expect(error).toBeInstanceOf(Kosa8ApiError)
  expect(error).toMatchObject({
    status: 404,
    code: "not_found",
    message: "kosa8: no sandbox sbx_9",
  })
})

test("refuses to call without a key", async () => {
  const saved = process.env.KOSA8_API_KEY
  delete process.env.KOSA8_API_KEY
  try {
    const { seen, fetcher } = fakeFetch(() => json(200, {}))
    const error = await createKosa8Client({ fetch: fetcher })
      .get("sbx_1")
      .catch((caught) => caught)
    expect(error).toMatchObject({ code: "no_api_key" })
    expect(seen).toHaveLength(0)
  } finally {
    if (saved !== undefined) process.env.KOSA8_API_KEY = saved
  }
})

test("finds a live sandbox by exact name, and refuses two", async () => {
  let sandboxes: unknown[] = [{ id: "sbx_1", name: "n", state: "sleeping", labels: { a: "b" } }]
  const { seen, fetcher } = fakeFetch(() => json(200, { sandboxes, next_cursor: null }))
  const client = createKosa8Client({ apiKey: "k", fetch: fetcher })
  expect(await client.findByName("sixb-x y")).toMatchObject({ id: "sbx_1", state: "sleeping" })
  expect(seen[0]?.url).toBe("https://api.kosa8.com/v1/sandboxes?name=sixb-x%20y")
  sandboxes = []
  expect(await client.findByName("n")).toBeUndefined()
  sandboxes = [
    { id: "sbx_1", name: "n", state: "running" },
    { id: "sbx_2", name: "n", state: "sleeping" },
  ]
  expect(await client.findByName("n").catch((caught) => caught)).toMatchObject({ status: 409 })
})

test("waits through creating and the guest's 409 until a first command runs", async () => {
  const states = ["creating", "running", "running"]
  let execs = 0
  const { fetcher } = fakeFetch((request) => {
    if (request.method === "GET") {
      return json(200, { sandbox: { id: "sbx_1", name: "n", state: states.shift() ?? "running" } })
    }
    execs += 1
    return execs === 1
      ? json(409, { error: "starting", message: "sandbox is starting" })
      : json(200, { exit: 0, stdout: "", stderr: "" })
  })
  const record = await createKosa8Client({ apiKey: "k", fetch: fetcher }).waitUntilRunning(
    "sbx_1",
    10_000
  )
  expect(record.state).toBe("running")
  expect(execs).toBe(2)
})

test("stops waiting at a state the sandbox never leaves", async () => {
  const { fetcher } = fakeFetch(() =>
    json(200, { sandbox: { id: "sbx_1", name: "n", state: "error" } })
  )
  const error = await createKosa8Client({ apiKey: "k", fetch: fetcher })
    .waitUntilRunning("sbx_1", 10_000)
    .catch((caught) => caught)
  expect(error.message).toContain("is error")
})

test("streams a command's output and exit status from NDJSON frames", async () => {
  const { seen, fetcher } = fakeFetch(() =>
    frames(
      { stream: "stdout", data: b64("hel") },
      { heartbeat: true },
      { stream: "stderr", data: b64("warn\n") },
      { stream: "stdout", data: b64("lo\n") },
      { done: true, exit: 7 }
    )
  )
  const stream = createKosa8Client({ apiKey: "k", fetch: fetcher }).exec("sbx_1", {
    argv: ["sh", "-c", "x"],
    env: { SECRET: "s" },
  })
  const read = async (chunks: AsyncIterable<Uint8Array>) => {
    let text = ""
    for await (const chunk of chunks) text += new TextDecoder().decode(chunk)
    return text
  }
  const [stdout, stderr, exit] = await Promise.all([
    read(stream.stdout),
    read(stream.stderr),
    stream.wait(),
  ])
  expect({ stdout, stderr, exit }).toEqual({ stdout: "hello\n", stderr: "warn\n", exit: 7 })
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
    cmd: ["sh", "-c", "x"],
    env: ["SECRET=s"],
    stream: true,
  })
})

test("a stream that ends without an exit status, or with an error, rejects", async () => {
  for (const response of [
    frames({ stream: "stdout", data: b64("x") }),
    frames({ done: true, error: "command exceeded its time limit", code: "exec_timeout" }),
  ]) {
    const { fetcher } = fakeFetch(() => response)
    const stream = createKosa8Client({ apiKey: "k", fetch: fetcher }).exec("sbx_1", {
      argv: ["true"],
    })
    expect(await stream.wait().catch((caught) => caught)).toBeInstanceOf(Error)
  }
})

test("uploads raw bytes under the files API", async () => {
  const { seen, fetcher } = fakeFetch(() => json(200, { ok: true }))
  await createKosa8Client({ apiKey: "k", fetch: fetcher }).upload(
    "sbx_1",
    "/workspace/.sixb-files/a b",
    "hello"
  )
  expect(seen[0]?.method).toBe("PUT")
  expect(seen[0]?.url).toBe(
    "https://api.kosa8.com/v1/sandboxes/sbx_1/files/raw?path=%2Fworkspace%2F.sixb-files%2Fa%20b"
  )
  expect(seen[0]?.headers.get("content-type")).toBe("application/octet-stream")
  expect(seen[0]?.body).toBe("hello")
})

test("sets egress, sleeps, wakes and deletes by id", async () => {
  const { seen, fetcher } = fakeFetch(() => json(200, { ok: true }))
  const client = createKosa8Client({ apiKey: "k", baseURL: "https://k8.internal/", fetch: fetcher })
  await client.setEgress("sbx_1", { internet: false })
  await client.sleep("sbx_1")
  await client.wake("sbx_1")
  await client.delete("sbx_1")
  expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
    "PUT https://k8.internal/v1/sandboxes/sbx_1/egress",
    "POST https://k8.internal/v1/sandboxes/sbx_1/sleep",
    "POST https://k8.internal/v1/sandboxes/sbx_1/wake",
    "DELETE https://k8.internal/v1/sandboxes/sbx_1",
  ])
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ internet: false, allow: [] })
})

test("a command past kosa8's argument bounds travels in its env, exactly", async () => {
  const long = "x".repeat(9000)
  expect(execBody({ argv: ["echo", "short"] })).toEqual({ cmd: ["echo", "short"], env: [] })
  const body = execBody({ argv: ["printf", "%s", long, "it's"], env: { A: "1" } })
  expect(body.cmd).toEqual(["/bin/sh", "-c", `eval "$${EXEC_LINE_ENV}"`])
  expect(body.env[0]).toBe("A=1")
  expect(body.env[1]).toBe(
    `${EXEC_LINE_ENV}=${["printf", "%s", long, "it's"].map(shellQuote).join(" ")}`
  )
  const many = execBody({ argv: Array.from({ length: 300 }, (_, index) => String(index)) })
  expect(many.cmd[0]).toBe("/bin/sh")

  // The shell gets back the argv it was given.
  const line = body.env[1]?.slice(EXEC_LINE_ENV.length + 1) ?? ""
  const echoed = Bun.spawnSync(["/bin/sh", "-c", `eval "$L"`], {
    env: { L: line, PATH: process.env.PATH ?? "" },
  })
  expect(new TextDecoder().decode(echoed.stdout)).toBe(`${long}it's`)
})
