import { isIP } from "node:net"
import {
  SandboxError,
  type SandboxNetworkPolicy,
  type SandboxRequestCredential,
} from "@sixb/core/sandboxes"
import type { Kosa8Egress } from "./kosa8-client"

/** The egress policy that reaches nothing. */
export const NO_EGRESS: Kosa8Egress = { internet: false, allow: [] }

/**
 * The sandbox's egress policy for a network policy: the open internet for `all`, nothing for
 * `none` and an empty `restricted` list, else each allowed origin's hostname. kosa8 enforces the
 * policy on its host by hostname or address, so the hostname is the whole rule: any port on it is
 * open.
 */
export function toKosa8Egress(policy: SandboxNetworkPolicy): Kosa8Egress {
  if (policy.mode === "all") return { internet: true, allow: [] }
  if (policy.mode === "none" || policy.allow.length === 0) return NO_EGRESS
  return {
    internet: false,
    allow: [...new Set(policy.allow.map((target) => egressHost(target.origin)))],
  }
}

/**
 * Reject credentials the sandbox's network can't carry, before anything is provisioned: the
 * forwarder reaches each origin through the same egress as the commands.
 */
export function assertCredentialsAllowed(
  policy: SandboxNetworkPolicy,
  credentials: readonly SandboxRequestCredential[]
): void {
  if (credentials.length === 0) return
  if (policy.mode === "none") {
    throw invalidCredential("the sandbox network allows no origin")
  }
  for (const credential of credentials) {
    let origin: string
    try {
      origin = new URL(credential.origin).origin
    } catch {
      throw invalidCredential("origin must be an http:// or https:// origin")
    }
    if (origin !== credential.origin || !/^https?:$/.test(new URL(origin).protocol)) {
      throw invalidCredential("origin must be an http:// or https:// origin, without a path")
    }
    if (
      policy.mode === "restricted" &&
      !policy.allow.some((target) => target.origin === credential.origin)
    ) {
      throw invalidCredential(`${credential.origin} is not in the sandbox network`)
    }
  }
}

/** Name the rule a credential breaks. Never include its headers: they hold the secret. */
function invalidCredential(reason: string): SandboxError {
  return new SandboxError(`[Sandbox] Invalid request credential: ${reason}.`)
}

/**
 * A kosa8 sandbox runs remotely: an origin on this host's loopback or private network is out of
 * its reach, so name the fix instead of letting commands fail to connect.
 */
function egressHost(origin: string): string {
  let host: string
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, "")
  } catch {
    throw new SandboxError(`[Sandbox] kosa8 network origin ${origin} is not a URL.`)
  }
  if (isLocalHost(host)) {
    throw new SandboxError(
      `[Sandbox] kosa8 sandboxes run remotely and cannot reach ${origin}. Allow a public origin instead, such as the Sixb API's public HTTPS URL.`
    )
  }
  if (isIP(host) === 6) {
    throw new SandboxError(
      `[Sandbox] kosa8 egress takes hostnames and public IPv4 addresses, not ${origin}.`
    )
  }
  return host
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true
  if (isIP(host) !== 4) return false
  const [a = 0, b = 0] = host.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
