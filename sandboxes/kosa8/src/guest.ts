import {
  GUEST_COMMAND_UID,
  type GuestCommand,
  SandboxError,
  unprivilegedGuestArgv,
} from "@sixb/core/sandboxes"
import { type Kosa8Exec, shellQuote } from "./kosa8-client"

// kosa8 runs the provider's commands as root in the sandbox's one long-lived container. The
// sandbox's commands never run as root: each goes through setpriv, which drops to
// GUEST_COMMAND_UID with no groups, no capabilities and no way back. What only root can read is
// out of their reach: the credentials the guest's forwarder holds, and the staging directory the
// provider uploads through.

/** Where the provider keeps its guest state. */
export const GUEST_PATHS = {
  /** HOME for commands, owned by the command user and outside the working directory. */
  home: "/var/lib/sixb-home",
  /**
   * Files bound for the workspace. kosa8's files API reaches only /workspace, so the staging
   * directory is there, root's own, and /workspace itself stays root's so it can't be swapped.
   */
  files: "/workspace/.sixb-files",
} as const

/** The kosa8 files API's root, kept root-owned: commands get a directory inside it. */
export const FILES_ROOT = "/workspace"
export const DEFAULT_WORKING_DIRECTORY = "/workspace/sixb"

const GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

/** Every process a command starts carries this, so a cancelled command can be ended. */
export const RUN_MARKER = "SIXB_KOSA8_RUN"

/** The bootstrap's exit status when the image has no `setpriv`. */
export const BOOTSTRAP_NO_SETPRIV = 21

const BOOTSTRAP_SCRIPT = `set -eu
command -v setpriv >/dev/null 2>&1 || exit ${BOOTSTRAP_NO_SETPRIV}
install -d -o root -g root -m 755 -- ${FILES_ROOT}
mkdir -p -- "$1"
chown ${GUEST_COMMAND_UID}:${GUEST_COMMAND_UID} -- "$1"
install -d -o ${GUEST_COMMAND_UID} -g ${GUEST_COMMAND_UID} -m 700 -- "$2"
install -d -o root -g root -m 711 -- "$3"`

/** Prepare the sandbox: the working directory and HOME for commands, and the staging area. */
export function bootstrapCommand(workingDirectory: string): Kosa8Exec {
  return {
    argv: [
      "/bin/sh",
      "-c",
      BOOTSTRAP_SCRIPT,
      "sh",
      workingDirectory,
      GUEST_PATHS.home,
      GUEST_PATHS.files,
    ],
  }
}

// Change directory as the command user, so a directory only it can enter still works, and name a
// missing one instead of the program.
const COMMAND_SCRIPT = `cd -- "$1" 2>/dev/null || {
  printf "[Sandbox] working directory '%s' does not exist or is not a directory\\n" "$1" >&2
  exit 1
}
shift
exec "$@"`

/**
 * Run `command` as the command user in `cwd`, with exactly `env` on top of a fixed base: nothing
 * of root's environment reaches it. `run` marks every process it starts, for {@link endRunCommand}.
 */
export function unprivilegedCommand(
  run: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  command: string,
  args: readonly string[]
): Kosa8Exec {
  return {
    argv: [
      ...commandEnv(run, env),
      ...unprivilegedGuestArgv("/bin/sh", ["-c", COMMAND_SCRIPT, "sh", cwd, command, ...args]),
    ],
  }
}

const WRITE_SCRIPT = `set -e
while [ "$#" -gt 0 ]; do
  mkdir -p -- "$(dirname -- "$2")"
  cp -- "$1" "$2"
  if [ -n "$3" ]; then chmod "$3" -- "$2"; fi
  shift 3
done`

export interface StagedFile {
  /** Where the bytes were uploaded, under {@link GUEST_PATHS.files}. */
  readonly staged: string
  /** The absolute path the file goes to. */
  readonly path: string
  readonly mode?: number
}

/**
 * Copy staged uploads into place as the command user: a link a command planted can lead a write
 * only where the command could write itself. The staged copies go either way.
 */
export function placeFilesCommand(run: string, files: readonly StagedFile[]): Kosa8Exec {
  // Root opens the staged copies to the command user, which copies them into place; root then
  // removes them, whatever the copy did.
  const staged = files.map((file) => shellQuote(file.staged)).join(" ")
  return {
    argv: [
      "/bin/sh",
      "-c",
      `chmod 644 -- ${staged} || exit\n"$@" </dev/null\nstatus=$?\nrm -f -- ${staged}\nexit "$status"`,
      "sh",
      ...commandEnv(run, {}),
      ...unprivilegedGuestArgv("/bin/sh", [
        "-c",
        WRITE_SCRIPT,
        "sh",
        ...files.flatMap((file) => [
          file.staged,
          file.path,
          file.mode === undefined ? "" : file.mode.toString(8),
        ]),
      ]),
    ],
  }
}

/**
 * Run a guest credentials step as root with a fixed environment. The step's env, which holds the
 * credentials, travels as the exec's own env: a root process's environment, never its argv.
 */
export function rootCommand(command: GuestCommand): Kosa8Exec {
  return {
    argv: ["/usr/bin/env", "-i", `PATH=${GUEST_PATH}`, ...command.argv],
    env: command.env,
  }
}

/** Start the forwarder as root in a session of its own, so it outlives this exec. */
export function detachedRootCommand(command: GuestCommand): Kosa8Exec {
  return {
    argv: [
      "/bin/sh",
      "-c",
      'setsid -f "$@" </dev/null >/dev/null 2>&1',
      "sh",
      "/usr/bin/env",
      "-i",
      `PATH=${GUEST_PATH}`,
      ...command.argv,
    ],
    env: command.env,
  }
}

/**
 * End every process of a run: each whose environment carries the marker, and every descendant of
 * one, since a command may drop the marker in its children. It looks again after each signal, so
 * a process forked meanwhile is caught too, and exits 3 when any survive KILL.
 */
const END_RUN_SCRIPT = `scan() {
  pids=" "
  local p line rest state grew=1
  local -A parent=()
  cd /proc || return 0
  for p in [0-9]*; do
    read -r line < "$p/stat" 2>/dev/null || continue
    rest=\${line##*) }
    state=\${rest%% *}; rest=\${rest#* }
    [ "$state" = Z ] && continue
    parent[$p]=\${rest%% *}
    grep -qzxF -- "$1" "$p/environ" 2>/dev/null && pids="$pids$p "
  done
  [ "$pids" = " " ] && { pids=""; return 0; }
  while [ -n "$grew" ]; do
    grew=""
    for p in "\${!parent[@]}"; do
      case "$pids" in *" $p "*) continue ;; esac
      case "$pids" in *" \${parent[$p]} "*) pids="$pids$p "; grew=1 ;; esac
    done
  done
}
scan "$1"; [ -n "$pids" ] || exit 0
kill -KILL $pids 2>/dev/null
for i in 1 2 3 4 5; do sleep 0.2; scan "$1"; [ -n "$pids" ] || exit 0; kill -KILL $pids 2>/dev/null; done
echo "processes survived KILL:$pids" >&2
exit 3`

/** Kill what a run started. Closing kosa8's exec stream only stops listening. */
export function endRunCommand(run: string): Kosa8Exec {
  return { argv: ["/bin/bash", "-c", END_RUN_SCRIPT, "end-run", `${RUN_MARKER}=${run}`] }
}

function commandEnv(run: string, env: Readonly<Record<string, string>>): string[] {
  return [
    "/usr/bin/env",
    "-i",
    `PATH=${GUEST_PATH}`,
    `HOME=${GUEST_PATHS.home}`,
    "LANG=C.UTF-8",
    `${RUN_MARKER}=${run}`,
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ]
}

/** Env names and values the guest's `env` can pass on: a name without "=", no NUL anywhere. */
export function assertGuestEnv(env: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (
      !key ||
      /[=\0]/.test(key) ||
      key === RUN_MARKER ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw new SandboxError(
        `[Sandbox] kosa8 env names must be non-empty without "=" or NUL, and not ${RUN_MARKER}; values strings without NUL: ${JSON.stringify(key)}.`
      )
    }
  }
}
