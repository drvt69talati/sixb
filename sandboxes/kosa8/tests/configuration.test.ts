import { expect, test } from "bun:test"
import { param } from "@sixb/core"
import { Kosa8SandboxFactory, type Kosa8SandboxFactoryOptions } from "../src"

test("carries only common configuration, not provider credentials or infrastructure", () => {
  const factory = new Kosa8SandboxFactory({
    apiKey: "private",
    region: "eu",
    size: "4x8",
    diskGb: 40,
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })
  expect(factory.configuration).toEqual({
    source: { type: "git", url: "https://github.com/acme/app.git" },
    setup: ["bun install"],
  })

  // A dynamic recipe is carried as given, never evaluated at configuration time.
  const resolve = () => {
    throw new Error("Not called at configuration time")
  }
  const params = { clientId: param("string") }
  const dynamic = new Kosa8SandboxFactory({ apiKey: "private", params, resolve })
  expect(dynamic.configuration).toEqual({ params, resolve })
})

test("rejects provider-specific source variants at construction", () => {
  for (const source of [
    { type: "tarball" as const, url: "https://example.com/app.tgz" },
    { type: "git" as const, url: "https://github.com/acme/app.git", password: "private" },
  ]) {
    expect(
      () =>
        new Kosa8SandboxFactory<Record<never, never>>({ source } as Kosa8SandboxFactoryOptions<
          Record<never, never>
        >)
    ).toThrow("Invalid sandbox source")
  }
})

test("rejects an unknown size, region or bound, or an invalid name prefix at construction", () => {
  expect(() => new Kosa8SandboxFactory({ size: "3x12" as never })).toThrow("size")
  expect(() => new Kosa8SandboxFactory({ region: "mars" as never })).toThrow("region")
  expect(() => new Kosa8SandboxFactory({ diskGb: 4 })).toThrow("diskGb")
  expect(() => new Kosa8SandboxFactory({ ttlSeconds: 30 })).toThrow("ttlSeconds")
  expect(() => new Kosa8SandboxFactory({ namePrefix: "Sixb_" })).toThrow("namePrefix")
  expect(() => new Kosa8SandboxFactory({ readyTimeoutMs: 0 })).toThrow("readyTimeoutMs")
})

test("supports request credentials and named persistence", () => {
  const factory = new Kosa8SandboxFactory()
  expect(factory.supportsRequestCredentials).toBe(true)
  expect(typeof factory.resume).toBe("function")
})
