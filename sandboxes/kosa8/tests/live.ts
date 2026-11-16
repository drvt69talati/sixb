import type { Sandbox, SandboxFactory } from "@sixb/core/sandboxes"
import { Kosa8SandboxFactory, type Kosa8SandboxFactoryOptions } from "../src"

/**
 * Live tests run against real kosa8 sandboxes when SIXB_KOSA8_E2E=1. They read the API key from
 * KOSA8_API_KEY and, when set, the region from KOSA8_REGION and the API from KOSA8_API_URL.
 * Sandboxes are named with SIXB_KOSA8_E2E_PREFIX (default "sixb-e2e-") and labelled
 * `sixb-e2e=1`. Each test destroys the sandboxes it creates.
 */
export const liveEnabled = process.env.SIXB_KOSA8_E2E === "1"

export const LIVE_TIMEOUT_MS = 300_000

export function liveOptions(
  options: Partial<Kosa8SandboxFactoryOptions> = {}
): Kosa8SandboxFactoryOptions {
  const apiKey = process.env.KOSA8_API_KEY
  if (!apiKey) throw new Error("SIXB_KOSA8_E2E=1 needs KOSA8_API_KEY")
  return {
    apiKey,
    ...(process.env.KOSA8_REGION
      ? { region: process.env.KOSA8_REGION as Kosa8SandboxFactoryOptions["region"] }
      : {}),
    ...(process.env.KOSA8_API_URL ? { baseURL: process.env.KOSA8_API_URL } : {}),
    namePrefix: process.env.SIXB_KOSA8_E2E_PREFIX ?? "sixb-e2e-",
    labels: { "sixb-e2e": "1" },
    ...options,
  }
}

/** Log each sandbox a factory creates, so a failed run's sandboxes can be found and removed. */
export function logged<T extends SandboxFactory>(factory: T): T {
  const create = factory.create.bind(factory)
  const resume = factory.resume?.bind(factory)
  return Object.assign(Object.create(factory), {
    async create(options?: Parameters<SandboxFactory["create"]>[0]): Promise<Sandbox> {
      const sandbox = await create(options)
      console.log(`[Kosa8E2E] created sandbox ${sandbox.id}`)
      return sandbox
    },
    ...(resume
      ? {
          async resume(
            name: string,
            options?: Parameters<NonNullable<SandboxFactory["resume"]>>[1]
          ) {
            const sandbox = await resume(name, options)
            console.log(`[Kosa8E2E] resumed sandbox ${sandbox.id}`)
            return sandbox
          },
        }
      : {}),
  }) as T
}

export function liveFactory(
  options: Partial<Kosa8SandboxFactoryOptions> = {}
): Kosa8SandboxFactory {
  return logged(new Kosa8SandboxFactory(liveOptions(options)))
}
