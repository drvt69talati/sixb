import { createHash, randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CreateSandboxOptions,
  initializeSandboxEnvironment,
  type ParamsConfig,
  type ResumeSandboxOptions,
  type Sandbox,
  type SandboxConfig,
  SandboxError,
  type SandboxFactory,
  type SandboxNetworkPolicy,
  type SandboxSessionOptions,
  SandboxStateUnavailableError,
  sandboxConfig,
  sandboxCreationEnvironment,
} from "@sixb/core/sandboxes"
import {
  BOOTSTRAP_NO_SETPRIV,
  bootstrapCommand,
  DEFAULT_WORKING_DIRECTORY,
  FILES_ROOT,
  GUEST_PATHS,
} from "./guest"
import {
  createKosa8Client,
  isNotFound,
  type Kosa8Client,
  type Kosa8ClientOptions,
  type Kosa8SandboxRecord,
} from "./kosa8-client"
import { DEFAULT_SETUP_TIMEOUT_MS, Kosa8Sandbox } from "./kosa8-sandbox"
import { assertCredentialsAllowed, toKosa8Egress } from "./network"

/** A kosa8 sandbox size, `<vCPU>x<GiB of memory>`. */
export type Kosa8SandboxSize = "2x4" | "4x8" | "8x16" | "16x32"

/** A kosa8 Cloud region. */
export type Kosa8Region = "us" | "eu" | "us-ash1" | "eu-hel1"

export interface Kosa8SandboxFactoryOptions<in out TParams extends ParamsConfig = ParamsConfig>
  extends SandboxConfig<TParams> {
  /** kosa8 API key. Defaults to the `KOSA8_API_KEY` environment variable. */
  readonly apiKey?: string
  /** The region sandboxes are created in. Defaults to kosa8's choice. */
  readonly region?: Kosa8Region
  /** The kosa8 API endpoint, such as a self-hosted control plane. Defaults to kosa8 Cloud. */
  readonly baseURL?: string
  /** Sandbox size. Defaults to `"2x4"`. */
  readonly size?: Kosa8SandboxSize
  /**
   * The image to boot instead of kosa8's universal Ubuntu 24.04 image, for example one with your
   * toolchain installed. It needs `setpriv`, Bash and Bun or Node, as the universal image has.
   */
  readonly image?: string
  /** Disk size in GB, 8 to 200. Defaults to kosa8's. */
  readonly diskGb?: number
  /** Run dockerd in the sandbox, so commands can use `docker`. Needs a size. */
  readonly docker?: boolean
  /**
   * Seconds after which kosa8 deletes the sandbox even if nothing else does, 60 to 7776000: a
   * floor under a crashed host. Unset keeps it until destroy().
   */
  readonly ttlSeconds?: number
  /** Prefix for sandbox names. Defaults to `"sixb-"`. */
  readonly namePrefix?: string
  /** Labels added to every sandbox, to find them with `GET /v1/sandboxes?label=`. */
  readonly labels?: Readonly<Record<string, string>>
  /**
   * Default working directory for commands and files. Defaults to `/workspace/sixb`. kosa8's files
   * API reaches only /workspace, which stays root's, so `/workspace` itself is refused.
   */
  readonly workingDirectory?: string
  /** Default env merged into every sandbox the factory creates. */
  readonly env?: Readonly<Record<string, string>>
  /** Default per-command timeout in milliseconds. */
  readonly timeout?: number
  /** Default network policy. Overridable per create. Defaults to no network. */
  readonly network?: SandboxNetworkPolicy
  /** How long a new or resumed sandbox may take to accept commands. Defaults to 120 seconds. */
  readonly readyTimeoutMs?: number
  /** Bound for each of the provider's own guest steps, such as installing credentials. */
  readonly setupTimeoutMs?: number
}

const DEFAULT_NAME_PREFIX = "sixb-"
const DEFAULT_READY_TIMEOUT_MS = 120_000
/** The label that holds a persistent sandbox's Sixb name, checked again on resume. */
export const SANDBOX_NAME_LABEL = "sixb-sandbox"
const SIZES: readonly string[] = ["2x4", "4x8", "8x16", "16x32"]
const REGIONS: readonly string[] = ["us", "eu", "us-ash1", "eu-hel1"]
const DEFAULT_SIZE = "2x4"

/**
 * Pluggable factory for kosa8-backed Sixb sandboxes. Every sandbox is its own microVM, with its own
 * kernel, an egress policy enforced on its host, and no kosa8 credentials inside it.
 */
export class Kosa8SandboxFactory<const TParams extends ParamsConfig = Record<never, never>>
  implements SandboxFactory<TParams>
{
  /** A root forwarder in the guest adds them; commands run as an unprivileged user. */
  readonly supportsRequestCredentials = true
  readonly configuration: SandboxConfig<TParams>
  private client: Kosa8Client | undefined
  private readonly readyTimeoutMs: number
  private readonly setupTimeoutMs: number

  constructor(
    private readonly defaults: Kosa8SandboxFactoryOptions<TParams> = {},
    private readonly createClient: (options: Kosa8ClientOptions) => Kosa8Client = createKosa8Client
  ) {
    // A run issues credentials for itself; a factory default would outlive every run.
    if ("requestCredentials" in defaults && defaults.requestCredentials !== undefined) {
      throw new SandboxError(
        "[Sandbox] kosa8 takes request credentials per sandbox, from create() or resume(), never as a factory default."
      )
    }
    if (defaults.size !== undefined && !SIZES.includes(defaults.size)) {
      throw new SandboxError(`[Sandbox] kosa8 size must be one of ${SIZES.join(", ")}.`)
    }
    if (defaults.region !== undefined && !REGIONS.includes(defaults.region)) {
      throw new SandboxError(`[Sandbox] kosa8 region must be one of ${REGIONS.join(", ")}.`)
    }
    integerIn(defaults.diskGb, 8, 200, "diskGb")
    integerIn(defaults.ttlSeconds, 60, 7_776_000, "ttlSeconds")
    const prefix = defaults.namePrefix ?? DEFAULT_NAME_PREFIX
    if (!/^[a-z0-9-]{0,30}$/.test(prefix)) {
      throw new SandboxError(
        "[Sandbox] kosa8 namePrefix takes at most 30 lowercase letters, digits and hyphens."
      )
    }
    this.readyTimeoutMs = positive(
      defaults.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "readyTimeoutMs"
    )
    this.setupTimeoutMs = positive(
      defaults.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      "setupTimeoutMs"
    )
    this.configuration = sandboxConfig<TParams>(defaults)
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const environment = sandboxCreationEnvironment(this.configuration, options)
    const session = this.session(options)
    const persistence = options.persistence
    if (persistence !== undefined) {
      if (
        persistence === null ||
        typeof persistence !== "object" ||
        Object.keys(persistence).some((key) => key !== "name")
      ) {
        throw new SandboxError("[Sandbox] persistence must contain only a sandbox name.")
      }
      assertPersistentName(persistence.name)
    }

    const sandboxName =
      persistence === undefined
        ? `${this.prefix}${randomUUID().replaceAll("-", "").slice(0, 20)}`
        : persistentSandboxName(this.prefix, persistence.name)
    const client = this.kosa8()
    let record: Kosa8SandboxRecord | undefined
    let sandbox: Kosa8Sandbox | undefined
    try {
      if (persistence !== undefined && (await client.findByName(sandboxName)) !== undefined) {
        throw new SandboxError(
          "[Sandbox] kosa8 sandbox name already exists. Resume its stopped state or choose a new name; nothing was overwritten."
        )
      }
      record = await client.create({
        name: sandboxName,
        size: this.defaults.size ?? DEFAULT_SIZE,
        ...(this.defaults.image === undefined ? {} : { image: this.defaults.image }),
        ...(this.defaults.diskGb === undefined ? {} : { diskGb: this.defaults.diskGb }),
        ...(this.defaults.region === undefined ? {} : { region: this.defaults.region }),
        ...(this.defaults.docker ? { docker: true } : {}),
        ...(this.defaults.ttlSeconds === undefined ? {} : { ttlSeconds: this.defaults.ttlSeconds }),
        egress: toKosa8Egress(session.network),
        labels: {
          ...this.defaults.labels,
          ...(persistence === undefined ? {} : { [SANDBOX_NAME_LABEL]: persistence.name }),
        },
      })
      await client.waitUntilRunning(record.id, this.readyTimeoutMs)
      options.signal?.throwIfAborted()
      sandbox = this.sandbox(client, record, session, persistence !== undefined)
      await this.bootstrap(sandbox)
      // Before any setup command, so the source clone already authenticates outside the guest.
      if (session.requestCredentials.length > 0) {
        await sandbox.installCredentials(session.requestCredentials)
      }
      return await initializeSandboxEnvironment(sandbox, environment, options.signal)
    } catch (error) {
      if (persistence !== undefined) {
        // A failed create must never delete a name that another attempt may own: keep it asleep.
        if (record !== undefined) await client.sleep(record.id).catch(() => {})
        throw persistentError(error, "create")
      }
      if (sandbox !== undefined) await sandbox.destroy().catch(() => {})
      else if (record !== undefined) await client.delete(record.id).catch(() => {})
      if (error instanceof SandboxError) throw error
      throw new SandboxError(
        `[Sandbox] kosa8 create failed: ${errorMessage(error)}${this.keyHint()}`
      )
    }
  }

  /**
   * Resume a stopped persistent sandbox: wake it, memory and processes included, and apply this session's network and
   * credentials. Setup never runs again.
   */
  async resume(name: string, options: ResumeSandboxOptions = {}): Promise<Sandbox> {
    if (this.configuration.auth !== undefined && options.requestCredentials === undefined) {
      throw new SandboxError(
        "[Sandbox] Authenticated sandbox configuration requires execution-prepared request credentials on resume."
      )
    }
    const allowed = ["workingDirectory", "env", "timeout", "network", "requestCredentials"]
    if (Object.keys(options).some((key) => !allowed.includes(key))) {
      throw new SandboxError(
        `[Sandbox] resume accepts only session options (${allowed.join(", ")}); pass the existing name separately.`
      )
    }
    assertPersistentName(name)
    const session = this.session(options)
    const client = this.kosa8()

    let record: Kosa8SandboxRecord | undefined
    try {
      record = await client.findByName(persistentSandboxName(this.prefix, name))
    } catch (error) {
      throw persistentError(error, "resume")
    }
    if (record === undefined || record.labels?.[SANDBOX_NAME_LABEL] !== name) {
      throw new SandboxStateUnavailableError(
        "[Sandbox] kosa8 has no saved state for this sandbox name; no replacement was created."
      )
    }
    if (record.state !== "sleeping") {
      throw new SandboxError(
        "[Sandbox] kosa8 sandbox must be stopped before resume. Serialize its lifecycle and resolve any previous execution first."
      )
    }

    const sandbox = this.sandbox(client, record, session, true)
    try {
      await client.wake(record.id)
      await client.waitUntilRunning(record.id, this.readyTimeoutMs)
      await client.setEgress(record.id, toKosa8Egress(session.network))
      if (session.requestCredentials.length > 0) {
        await sandbox.installCredentials(session.requestCredentials)
      }
      // The working directory may be new to this session; the sandbox keeps everything else.
      await this.bootstrap(sandbox)
      return sandbox
    } catch (error) {
      // Leave the sandbox asleep, as it was, with no authority from this session.
      await sandbox.stop().catch(() => {})
      throw persistentError(error, "configure")
    }
  }

  /** Name the fix when no key was given. */
  private keyHint(): string {
    return this.defaults.apiKey || process.env.KOSA8_API_KEY
      ? ""
      : " Set KOSA8_API_KEY or pass apiKey."
  }

  private get prefix(): string {
    return this.defaults.namePrefix ?? DEFAULT_NAME_PREFIX
  }

  private kosa8(): Kosa8Client {
    this.client ??= this.createClient({
      ...(this.defaults.apiKey === undefined ? {} : { apiKey: this.defaults.apiKey }),
      ...(this.defaults.baseURL === undefined ? {} : { baseURL: this.defaults.baseURL }),
    })
    return this.client
  }

  /** This session's options over the factory's defaults, validated before anything is created. */
  private session(options: SandboxSessionOptions) {
    const network = options.network ?? this.configuration.network ?? { mode: "none" }
    const requestCredentials = options.requestCredentials ?? []
    toKosa8Egress(network)
    assertCredentialsAllowed(network, requestCredentials)
    return {
      workingDirectory: workspacePath(
        options.workingDirectory || this.defaults.workingDirectory || DEFAULT_WORKING_DIRECTORY
      ),
      env: { ...this.configuration.env, ...options.env },
      timeout: options.timeout ?? this.defaults.timeout,
      network,
      requestCredentials,
    }
  }

  private sandbox(
    client: Kosa8Client,
    record: Kosa8SandboxRecord,
    session: ReturnType<Kosa8SandboxFactory["session"]>,
    persistent: boolean
  ): Kosa8Sandbox {
    return new Kosa8Sandbox({
      client,
      sandboxId: record.id,
      sandboxName: record.name ?? "",
      persistent,
      workingDirectory: session.workingDirectory,
      env: session.env,
      timeout: session.timeout,
      network: session.network,
      setupTimeoutMs: this.setupTimeoutMs,
    })
  }

  private async bootstrap(sandbox: Kosa8Sandbox): Promise<void> {
    const result = await sandbox.runSetup(bootstrapCommand(sandbox.workingDirectory))
    if (result.exitCode === BOOTSTRAP_NO_SETPRIV) {
      throw new SandboxError(`[Sandbox] kosa8 sandbox ${sandbox.id} has no setpriv.`)
    }
    if (result.exitCode !== 0) {
      throw new SandboxError(
        `[Sandbox] kosa8 could not prepare ${sandbox.workingDirectory} on ${sandbox.id}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      )
    }
  }
}

/**
 * Sixb's sandbox names may hold what a kosa8 name may not, so the sandbox is named after a digest
 * of it, and the name itself is kept in a label.
 */
export function persistentSandboxName(prefix: string, name: string): string {
  return `${prefix}${createHash("sha256").update(name).digest("hex").slice(0, 24)}`
}

/**
 * The working directory becomes the command user's own, so it can't be a directory the system or
 * the provider depends on: /workspace holds the provider's staging area and stays root's.
 */
function workspacePath(path: string): string {
  const resolved = posix.resolve("/", path)
  const top = resolved.split("/")[1] ?? ""
  if (
    SHARED_DIRECTORIES.includes(resolved) ||
    SYSTEM_TREES.includes(top) ||
    resolved === FILES_ROOT ||
    resolved === GUEST_PATHS.files ||
    resolved.startsWith(`${GUEST_PATHS.files}/`)
  ) {
    throw new SandboxError(
      `[Sandbox] kosa8 workingDirectory ${resolved} is a system directory; use one of its own, such as ${DEFAULT_WORKING_DIRECTORY}.`
    )
  }
  return resolved
}

const SHARED_DIRECTORIES = ["/", "/tmp", "/var", "/var/tmp", "/var/lib", "/opt", "/srv", "/mnt"]
const SYSTEM_TREES = [
  "bin",
  "boot",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "proc",
  "root",
  "run",
].concat(["sbin", "sys", "usr"])

function assertPersistentName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 256 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new SandboxError(
      "[Sandbox] A sandbox name of 1 to 256 characters, without surrounding whitespace or control characters, is required."
    )
  }
}

function persistentError(
  error: unknown,
  operation: "create" | "resume" | "configure"
): SandboxError {
  if (error instanceof SandboxError) return error
  if (operation === "resume" && isNotFound(error)) {
    return new SandboxStateUnavailableError(
      "[Sandbox] kosa8 has no saved state for this sandbox name; no replacement was created."
    )
  }
  return new SandboxError(
    `[Sandbox] kosa8 persistent sandbox ${operation} failed: ${errorMessage(error)}`
  )
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SandboxError(`[Sandbox] kosa8 ${name} must be a positive number of milliseconds.`)
  }
  return value
}

function integerIn(value: number | undefined, min: number, max: number, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw new SandboxError(`[Sandbox] kosa8 ${name} must be an integer from ${min} to ${max}.`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
