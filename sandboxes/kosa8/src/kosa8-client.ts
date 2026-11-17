/** kosa8 Cloud's REST API, called directly: the provider loads no SDK. */
export const KOSA8_API_URL = "https://api.kosa8.com"

/** What the provider reads from a sandbox. */
export interface Kosa8SandboxRecord {
  readonly id: string
  readonly name: string | null
  /** `creating`, `running`, `sleeping`, or a state it never leaves, such as `error`. */
  readonly state: string
  readonly labels?: Readonly<Record<string, string>>
}

/** A sandbox's egress policy, enforced on its host for everything in the VM. */
export interface Kosa8Egress {
  /** `false`: nothing leaves but what `allow` names. */
  readonly internet: boolean
  /** Hostnames, `*.` wildcards and IPv4 addresses or ranges. */
  readonly allow?: readonly string[]
}

export interface Kosa8CreateSandboxRequest {
  readonly name: string
  readonly size: string
  readonly image?: string
  readonly diskGb?: number
  readonly region?: string
  readonly docker?: boolean
  readonly ttlSeconds?: number
  /** Applied on the host before the sandbox boots; omitted is unrestricted. */
  readonly egress?: Kosa8Egress
  readonly labels: Readonly<Record<string, string>>
}

/** One running command. Iterate both streams while waiting; `close()` stops listening. */
export interface Kosa8CommandStream {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  /** The exit status; rejects when the stream ends without one. */
  wait(): Promise<number>
  close(): void
}

/** A command for the guest. `env` reaches the command's root process and never the API's logs. */
export interface Kosa8Exec {
  readonly argv: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The kosa8 calls the provider makes, bound to one API key. Tests replace it with a fake;
 * {@link createKosa8Client} implements it with `fetch`.
 */
export interface Kosa8Client {
  create(request: Kosa8CreateSandboxRequest): Promise<Kosa8SandboxRecord>
  get(id: string): Promise<Kosa8SandboxRecord>
  /** The live sandbox with this name, if there is one. */
  findByName(name: string): Promise<Kosa8SandboxRecord | undefined>
  /** Resolves once the sandbox runs commands; rejects at a state it never leaves. */
  waitUntilRunning(id: string, timeoutMs: number): Promise<Kosa8SandboxRecord>
  /** Run as root in the sandbox's one long-lived container. */
  exec(id: string, command: Kosa8Exec): Kosa8CommandStream
  /** Paths under /workspace only. */
  upload(id: string, path: string, contents: string | Uint8Array): Promise<void>
  setEgress(id: string, egress: Kosa8Egress): Promise<void>
  sleep(id: string): Promise<void>
  wake(id: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface Kosa8ClientOptions {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly fetch?: typeof fetch
}

/** A refusal from the kosa8 API, with its HTTP status and stable error code. */
export class Kosa8ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "Kosa8ApiError"
  }
}

/** kosa8 bounds an exec to 256 arguments of 8 KiB; a longer command travels in its env. */
const MAX_ARGS = 256
const MAX_ARG_CHARS = 8192
/** The env entry that carries a command line past those bounds. */
export const EXEC_LINE_ENV = "SIXB_KOSA8_EXEC"
/** A sandbox in one of these never runs a command again. */
const FAILED_STATES = ["error", "stopped", "deleted", "host_removed", "host_lost"]
const POLL_MS = 500
/** Bounds each control-plane request; commands and file transfers run as long as they need. */
const REQUEST_TIMEOUT_MS = 60_000

/** A {@link Kosa8Client} on kosa8 Cloud's REST API. Reads `KOSA8_API_KEY` when `apiKey` is unset. */
export function createKosa8Client(options: Kosa8ClientOptions = {}): Kosa8Client {
  const base = (options.baseURL ?? KOSA8_API_URL).replace(/\/+$/, "")
  const fetcher = options.fetch ?? fetch
  const send = async (
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal; stream?: boolean } = {}
  ): Promise<Response> => {
    const apiKey = options.apiKey ?? process.env.KOSA8_API_KEY
    if (!apiKey)
      throw new Kosa8ApiError(401, "no_api_key", "kosa8: set KOSA8_API_KEY or pass apiKey")
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }
    let body: BodyInit | undefined
    if (init.json !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(init.json)
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/octet-stream"
      body = new Uint8Array(init.body)
    }
    const signals = [init.signal, init.stream ? undefined : AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
    const response = await fetcher(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any(signals.filter((signal): signal is AbortSignal => !!signal)),
    })
    if (!response.ok) throw await apiError(response)
    return response
  }
  const json = async <T>(method: string, path: string, payload?: unknown): Promise<T> =>
    (await (await send(method, path, payload === undefined ? {} : { json: payload })).json()) as T
  const call = async (method: string, path: string, payload?: unknown): Promise<void> => {
    const response = await send(method, path, payload === undefined ? {} : { json: payload })
    await response.body?.cancel().catch(() => {})
  }
  const sandbox = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`
  const get = async (id: string) =>
    record((await json<{ sandbox: Kosa8SandboxRecord }>("GET", sandbox(id))).sandbox)

  return {
    create: async (request) =>
      record(
        (
          await json<{ sandbox: Kosa8SandboxRecord }>("POST", "/v1/sandboxes", {
            name: request.name,
            // A plain create takes the universal-<size> template: kosa8's Ubuntu 24.04 image, kept
            // warm (a size alone boots the minimal Alpine base, whose BusyBox setpriv cannot drop
            // to another uid). An image, docker or a disk size needs a sandbox booted for it.
            ...(request.image === undefined && !request.docker && request.diskGb === undefined
              ? { template: `universal-${request.size}` }
              : { size: request.size }),
            labels: request.labels,
            // Every command runs in one long-lived container, so files and processes last.
            persistent: true,
            // A sandbox sleeps when the provider stops it, never on its own.
            sleep_after_s: 0,
            ...(request.image === undefined ? {} : { image: request.image }),
            ...(request.diskGb === undefined ? {} : { disk_gb: request.diskGb }),
            ...(request.region === undefined ? {} : { region: request.region }),
            ...(request.docker ? { docker: true } : {}),
            ...(request.ttlSeconds === undefined ? {} : { ttl_s: request.ttlSeconds }),
            ...(request.egress === undefined ? {} : { egress: egressBody(request.egress) }),
          })
        ).sandbox
      ),
    get,
    async findByName(name) {
      const { sandboxes } = await json<{ sandboxes: Kosa8SandboxRecord[] }>(
        "GET",
        `/v1/sandboxes?name=${encodeURIComponent(name)}`
      )
      const live = sandboxes.filter((candidate) => candidate.state !== "deleted").map(record)
      if (live.length > 1) {
        throw new Kosa8ApiError(
          409,
          "duplicate_name",
          `kosa8: ${live.length} sandboxes are named ${name}`
        )
      }
      return live[0]
    },
    async waitUntilRunning(id, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const current = await get(id)
        if (current.state === "running") {
          // A sandbox reads running a moment before its guest takes commands: kosa8 answers
          // 409 until then.
          try {
            await call("POST", `${sandbox(id)}/exec`, { cmd: ["true"], timeout_s: 30 })
            return current
          } catch (error) {
            if (!(error instanceof Kosa8ApiError && error.status === 409)) throw error
          }
        }
        if (FAILED_STATES.includes(current.state)) {
          throw new Kosa8ApiError(409, "not_running", `kosa8: sandbox ${id} is ${current.state}`)
        }
        if (Date.now() >= deadline) {
          throw new Kosa8ApiError(
            504,
            "not_ready",
            `kosa8: sandbox ${id} is still ${current.state}`
          )
        }
        await sleep(POLL_MS)
      }
    },
    exec(id, command) {
      const controller = new AbortController()
      const response = send("POST", `${sandbox(id)}/exec`, {
        json: { ...execBody(command), stream: true },
        signal: controller.signal,
        stream: true,
      })
      return execStream(response, controller)
    },
    async upload(id, path, contents) {
      const bytes = typeof contents === "string" ? new TextEncoder().encode(contents) : contents
      const response = await send(
        "PUT",
        `${sandbox(id)}/files/raw?path=${encodeURIComponent(path)}`,
        { body: bytes, stream: true }
      )
      await response.body?.cancel().catch(() => {})
    },
    setEgress: (id, egress) => call("PUT", `${sandbox(id)}/egress`, egressBody(egress)),
    sleep: (id) => call("POST", `${sandbox(id)}/sleep`),
    wake: (id) => call("POST", `${sandbox(id)}/wake`),
    delete: (id) => call("DELETE", sandbox(id)),
  }
}

/**
 * The request body for a command. argv within kosa8's bounds goes as it is; past them, the shell-
 * quoted command line goes in an env entry, which no argument bound applies to, and a shell runs it.
 */
export function execBody(command: Kosa8Exec): { cmd: string[]; env: string[] } {
  const env = Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${value}`)
  const fits =
    command.argv.length <= MAX_ARGS && command.argv.every((arg) => arg.length <= MAX_ARG_CHARS)
  if (fits) return { cmd: [...command.argv], env }
  return {
    cmd: ["/bin/sh", "-c", `eval "$${EXEC_LINE_ENV}"`],
    env: [...env, `${EXEC_LINE_ENV}=${command.argv.map(shellQuote).join(" ")}`],
  }
}

function egressBody(egress: Kosa8Egress): { internet: boolean; allow: string[] } {
  return { internet: egress.internet, allow: [...(egress.allow ?? [])] }
}

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Whether kosa8 said no such sandbox exists. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Kosa8ApiError && error.status === 404
}

/**
 * Newline-delimited frames: `{stream, data}` with base64 data (a `heartbeat` frame every 15 s
 * while the command is quiet), then `{done, exit}` or `{done, error}`.
 */
function execStream(response: Promise<Response>, controller: AbortController): Kosa8CommandStream {
  const stdout = new Channel()
  const stderr = new Channel()
  const exit = (async () => {
    try {
      const reader = (await response).body?.getReader()
      if (!reader) throw new Error("kosa8 sent no command output")
      const decoder = new TextDecoder()
      let pending = ""
      for (;;) {
        const { done, value } = await reader.read()
        pending += decoder.decode(value, { stream: !done })
        const lines = pending.split("\n")
        pending = done ? "" : (lines.pop() ?? "")
        for (const line of lines) {
          if (!line.trim()) continue
          const frame = JSON.parse(line) as {
            stream?: string
            data?: string
            heartbeat?: boolean
            done?: boolean
            exit?: number
            error?: string
          }
          if (frame.done) {
            await reader.cancel().catch(() => {})
            if (typeof frame.exit === "number") return frame.exit
            throw new Error(`kosa8 command failed: ${frame.error ?? "no exit status"}`)
          }
          if (frame.heartbeat || !frame.data) continue
          const bytes = Uint8Array.from(Buffer.from(frame.data, "base64"))
          if (frame.stream === "stdout") stdout.push(bytes)
          else if (frame.stream === "stderr") stderr.push(bytes)
        }
        if (done) throw new Error("kosa8 command output ended before the command exited")
      }
    } finally {
      stdout.end()
      stderr.end()
    }
  })()
  exit.catch(() => {})
  return {
    stdout,
    stderr,
    wait: () => exit,
    close: () => controller.abort(),
  }
}

/** An async iterable fed by the frame reader. */
class Channel implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = []
  private ended = false
  private wake: (() => void) | undefined

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const chunk = this.chunks.shift()
      if (chunk !== undefined) {
        yield chunk
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
  }
}

async function apiError(response: Response): Promise<Kosa8ApiError> {
  const text = await response.text().catch(() => "")
  let code = "http_error"
  let message = text.slice(0, 500) || `HTTP ${response.status}`
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown }
    if (typeof body.error === "string") code = body.error
    if (typeof body.message === "string") message = body.message
  } catch {
    // A proxy's own error page: its text is the message.
  }
  return new Kosa8ApiError(response.status, code, `kosa8: ${message}`)
}

function record(sandbox: Kosa8SandboxRecord): Kosa8SandboxRecord {
  return {
    id: sandbox.id,
    name: sandbox.name ?? null,
    state: sandbox.state,
    ...(sandbox.labels === undefined ? {} : { labels: sandbox.labels }),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
