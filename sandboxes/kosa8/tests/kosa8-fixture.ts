import {
  Kosa8ApiError,
  type Kosa8Client,
  type Kosa8CommandStream,
  type Kosa8CreateSandboxRequest,
  type Kosa8Egress,
  type Kosa8Exec,
  type Kosa8SandboxRecord,
} from "../src/kosa8-client"

/** What a scripted command does: its output and exit code, or `"hang"` until it is closed. */
export type FakeCommand =
  | { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number }
  | "hang"
  | Error

interface FakeSandbox {
  id: string
  name: string
  state: string
  labels: Record<string, string>
}

/** One exec as kosa8 received it: the argv, its env, and the argv joined with spaces. */
export interface FakeExec {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly line: string
}

/**
 * An in-memory kosa8: sandboxes, the calls made on them in order, and commands answered by a
 * script. Unscripted commands exit 0 with no output.
 */
export class FakeKosa8 implements Kosa8Client {
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly calls: string[] = []
  readonly execs: FakeExec[] = []
  readonly uploads: { readonly id: string; readonly path: string; readonly contents: string }[] = []
  readonly egress = new Map<string, Kosa8Egress>()
  readonly creates: Kosa8CreateSandboxRequest[] = []
  private readonly settling = new Set<string>()
  /** The streams `close()` was called on, by command line. */
  readonly closed: string[] = []
  /** Answer a command; the first matching rule wins. */
  script: (exec: FakeExec) => FakeCommand | undefined = () => undefined
  failCreate: Error | undefined
  failFind: Error | undefined
  failDelete: Error | undefined
  failSleep: Error | undefined
  failUpload: Error | undefined
  private nextId = 1

  async create(request: Kosa8CreateSandboxRequest): Promise<Kosa8SandboxRecord> {
    this.calls.push(`create ${request.name}`)
    this.creates.push(request)
    if (this.failCreate) throw this.failCreate
    const sandbox = {
      id: `sbx-${this.nextId++}`,
      name: request.name,
      state: "creating",
      labels: { ...request.labels },
    }
    this.sandboxes.set(sandbox.id, sandbox)
    if (request.egress) this.egress.set(sandbox.id, request.egress)
    return { ...sandbox }
  }

  async get(id: string): Promise<Kosa8SandboxRecord> {
    this.calls.push(`get ${id}`)
    const sandbox = this.sandbox(id)
    const seen = { ...sandbox }
    if (this.settling.delete(id)) sandbox.state = "sleeping"
    return seen
  }

  async findByName(name: string): Promise<Kosa8SandboxRecord | undefined> {
    this.calls.push(`find ${name}`)
    if (this.failFind) throw this.failFind
    const found = [...this.sandboxes.values()].find((candidate) => candidate.name === name)
    return found && { ...found }
  }

  async waitUntilRunning(id: string): Promise<Kosa8SandboxRecord> {
    this.calls.push(`ready ${id}`)
    const sandbox = this.sandbox(id)
    if (sandbox.state === "creating") sandbox.state = "running"
    return { ...sandbox }
  }

  exec(id: string, command: Kosa8Exec): Kosa8CommandStream {
    this.calls.push(`exec ${id}`)
    const exec = { argv: command.argv, env: command.env ?? {}, line: command.argv.join(" ") }
    this.execs.push(exec)
    const answer = this.script(exec) ?? {}
    return new FakeStream(answer, () => this.closed.push(exec.line))
  }

  async upload(id: string, path: string, contents: string | Uint8Array): Promise<void> {
    this.calls.push(`upload ${id} ${path}`)
    if (this.failUpload) throw this.failUpload
    this.uploads.push({
      id,
      path,
      contents: typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8"),
    })
  }

  async setEgress(id: string, egress: Kosa8Egress): Promise<void> {
    this.calls.push(`egress ${id} ${JSON.stringify(egress)}`)
    this.egress.set(id, egress)
  }

  async sleep(id: string): Promise<void> {
    this.calls.push(`sleep ${id}`)
    if (this.failSleep) throw this.failSleep
    // kosa8 answers before the sandbox is down: the next read still sees it running.
    this.sandbox(id)
    this.settling.add(id)
  }

  async wake(id: string): Promise<void> {
    this.calls.push(`wake ${id}`)
    this.sandbox(id).state = "running"
  }

  async delete(id: string): Promise<void> {
    this.calls.push(`delete ${id}`)
    if (this.failDelete) throw this.failDelete
    if (!this.sandboxes.delete(id)) throw notFound(id)
  }

  /** Add a sandbox as if an earlier execution had created it. */
  seed(sandbox: FakeSandbox): void {
    this.sandboxes.set(sandbox.id, sandbox)
  }

  /** The commands that ran as the unprivileged command user. */
  unprivileged(): FakeExec[] {
    return this.execs.filter((exec) => exec.argv.includes("--reuid=65534"))
  }

  private sandbox(id: string): FakeSandbox {
    const sandbox = this.sandboxes.get(id)
    if (!sandbox) throw notFound(id)
    return sandbox
  }
}

export function notFound(id: string): Kosa8ApiError {
  return new Kosa8ApiError(404, "not_found", `kosa8: sandbox ${id} not found`)
}

class FakeStream implements Kosa8CommandStream {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  private readonly exit: Promise<number>
  private onClose: (() => void) | undefined

  constructor(answer: FakeCommand, closed: () => void) {
    if (answer === "hang") {
      let release: (error: Error) => void = () => {}
      this.exit = new Promise<number>((_, reject) => {
        release = reject
      })
      this.exit.catch(() => {})
      this.stdout = once("partial out\n", this.exit)
      this.stderr = once("partial err\n", this.exit)
      this.onClose = () => {
        closed()
        release(new Error("The operation was aborted"))
      }
      return
    }
    this.onClose = closed
    if (answer instanceof Error) {
      this.exit = Promise.reject(answer)
      this.exit.catch(() => {})
      this.stdout = once("", this.exit)
      this.stderr = once("", this.exit)
      return
    }
    this.exit = Promise.resolve(answer.exitCode ?? 0)
    this.stdout = once(answer.stdout ?? "", this.exit)
    this.stderr = once(answer.stderr ?? "", this.exit)
  }

  wait(): Promise<number> {
    return this.exit
  }

  close(): void {
    this.onClose?.()
    this.onClose = undefined
  }
}

/** Yield `text`, then end with the command, as the client's channels do. */
async function* once(text: string, exit: Promise<number>): AsyncIterable<Uint8Array> {
  if (text) yield new TextEncoder().encode(text)
  await exit
}
