import { expect, test } from "bun:test"
import { InMemoryBlobStorage, InMemoryStorage, type Storage } from "@sixb/core"
import type { AgentRunSessionHost } from "@sixb/core/internal/agents"
import { toModelMessages } from "@sixb/core/internal/agents"
import type { ModelMessage, ModelUsage } from "@sixb/core/models"
import type { ConversationAgentRunRecord } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import { renderCurrentTime } from "../src/agent-prompt"
import { runTurnInSession } from "./helpers"
import { testStream, WorkerTestModel } from "./worker-model-fixture"

const projectId = "project"
const threadId = "thread"
const summary = "The user said one and the assistant answered two."
const serializedSummary = [
  "The earlier conversation was compacted into this continuation summary. Its messages are still stored: `sixb history` prints them.",
  "",
  "<sixb_thread_summary>",
  summary,
  "</sixb_thread_summary>",
].join("\n")

const usage: ModelUsage = {
  inputTokens: 10,
  outputTokens: 7,
  uncachedInputTokens: 10,
  cacheReadInputTokens: 0,
  raw: { input_tokens: 10, output_tokens: 7 },
}

function captureModel(capture: (prompt: readonly ModelMessage[]) => void): WorkerTestModel {
  return new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      capture(options.messages)
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Done" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })
}

function requireWorkerStorage(storage: Storage): AgentRunSessionHost["storage"] {
  if (!storage.agents || !storage.auth || !storage.aiUsage) {
    throw new Error("Expected complete agent worker storage.")
  }
  return storage as AgentRunSessionHost["storage"]
}

async function seedThread(withCheckpoint: boolean) {
  const storage = new InMemoryStorage()
  const agents = storage.agents
  await agents.threads.create({
    id: threadId,
    projectId,
    ownerPrincipal: { type: "user", id: "user" },
  })
  await agents.messages.append({
    id: "message_1",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "one" }],
  })

  const firstExecutionId = await createTestAgentExecution(storage, {
    projectId,
    runId: "run_1",
  })
  await agents.runs.create({
    id: "run_1",
    projectId,
    executionId: firstExecutionId,
    threadId,
    triggerMessageId: "message_1",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  await agents.runs.start({
    id: "run_1",
    projectId,
    execution: {
      token: "execution_1",
      queueLeaseExpiresAt: new Date("2026-08-27T12:05:00.000Z"),
    },
  })
  await agents.messages.append({
    id: "message_2",
    projectId,
    threadId,
    runId: "run_1",
    role: "assistant",
    parts: [{ type: "text", text: "two" }],
  })
  await agents.runs.finish({
    id: "run_1",
    projectId,
    executionToken: "execution_1",
    status: "succeeded",
  })

  await agents.messages.append({
    id: "message_3",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three" }],
  })
  const secondExecutionId = await createTestAgentExecution(storage, {
    projectId,
    runId: "run_2",
  })
  await agents.runs.create({
    id: "run_2",
    projectId,
    executionId: secondExecutionId,
    threadId,
    triggerMessageId: "message_3",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const started = await agents.runs.start({
    id: "run_2",
    projectId,
    execution: {
      token: "execution_2",
      queueLeaseExpiresAt: new Date("2026-08-27T12:10:00.000Z"),
    },
  })
  if (started.kind !== "conversation") throw new Error("Expected a conversational Agent run.")
  const run: ConversationAgentRunRecord = started

  if (withCheckpoint) {
    await agents.checkpoints.create({
      id: "checkpoint_1",
      projectId,
      threadId,
      createdByRunId: "run_2",
      expectedPreviousCheckpointId: null,
      expectedHeadSeq: 3,
      executionToken: "execution_2",
      reason: "threshold",
      summary,
      summaryFormatVersion: 1,
      summarizedThroughSeq: 2,
      observedHeadSeq: 3,
      estimatedInputTokensBefore: 1_000,
      estimatedInputTokensAfter: 300,
      summaryModelId: "test-model",
    })
  }

  const transcript = await agents.messages.list({ projectId, threadId, order: "asc" })
  return { storage, run, transcript: transcript.messages }
}

async function runAndCaptureModelPrompt(withCheckpoint: boolean) {
  const seeded = await seedThread(withCheckpoint)
  let prompt: readonly ModelMessage[] | undefined
  const model = captureModel((value) => {
    prompt = value
  })
  const plan = {
    instructions: "Answer clearly.",
    model,
    recordedModel: model,
    tools: [],
    skills: [],
    ontologyDocs: { files: [], index: [] },
  }

  await runTurnInSession({
    storage: requireWorkerStorage(seeded.storage),
    context: {
      id: projectId,
      authorPrincipal: { type: "serviceAccount", id: "service_agent" },
      blobStorage: new InMemoryBlobStorage(),
      tools: [],
      systemPrompt: "Test system prompt.",
      projectTimeZone: "UTC",
      projectLocale: "en",
    },
    plan,
    run: seeded.run,
    signal: new AbortController().signal,
  })

  if (!prompt) throw new Error("Expected the model prompt to be captured.")
  return { ...seeded, prompt }
}

function conversationMessages(prompt: readonly ModelMessage[]): readonly unknown[] {
  return prompt.filter((message) => message.role !== "system")
}

test("preserves the exact model history when no checkpoint exists", async () => {
  const { prompt, transcript } = await runAndCaptureModelPrompt(false)

  expect(conversationMessages(prompt)).toEqual(
    toModelMessages(transcript, {
      userMessageSuffix: (message) =>
        message.role === "user"
          ? renderCurrentTime(message.createdAt, { timeZone: "UTC", locale: "en" })
          : undefined,
    })
  )
})

test("a seeded checkpoint changes only the model input", async () => {
  // Verified regression guard: temporarily passing `retainedMessages` instead of `modelMessages`
  // from runAgentTurn removes the synthetic summary and makes this exact assertion fail.
  const { storage, prompt, transcript } = await runAndCaptureModelPrompt(true)
  const three = transcript.at(-1)
  if (!three) throw new Error("Expected the retained message.")

  // The synthetic summary is not a sent message, so only the retained one is dated.
  expect(conversationMessages(prompt)).toEqual([
    { role: "user", content: [{ type: "text", text: serializedSummary }] },
    {
      role: "user",
      content: [
        { type: "text", text: "three" },
        {
          type: "text",
          text: `\n\n${renderCurrentTime(three.createdAt, { timeZone: "UTC", locale: "en" })}`,
        },
      ],
    },
  ])

  const durableTranscript = await storage.agents.messages.list({
    projectId,
    threadId,
    order: "asc",
  })
  const originalMessages: readonly unknown[] = durableTranscript.messages.slice(
    0,
    transcript.length
  )
  expect(originalMessages).toEqual(transcript)
})

test("editing an earlier turn preserves exact prefix bytes, pinned memory, and cache affinity while dropping later turns", async () => {
  // Guard proof: omit checkpoints.deleteAfterSeq or messages.deleteFromSeq on rewind, or load
  // memory as of now instead of thread.createdAt; the prefix bytes diverge or Turn 3 leaks.
  const seeded = await seedThread(false)
  const { storage } = seeded
  const agents = storage.agents

  // Save a memory entry AFTER Turn 1/Turn 2 started, as a later Turn 3 might have done.
  await agents.memory.save({
    projectId,
    repoId: "project",
    baseRevision: 0,
    message: "Later turn memory",
    author: { type: "user", id: "user" },
    changes: [{ path: "MEMORY.md", contents: "# Memory\n\n- Secret from deleted Turn 3\n" }],
    createdAt: new Date(Date.now() + 60_000),
  })

  // Capture exact request bytes and caching intent when Turn 2 originally runs.
  let originalMessagesSent: readonly ModelMessage[] | undefined
  let originalCaching: unknown
  const firstModel = new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      originalMessagesSent = options.messages
      originalCaching = options.caching
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Original reply 2" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })

  const baseContext = {
    id: projectId,
    authorPrincipal: { type: "serviceAccount" as const, id: "service_agent" },
    blobStorage: new InMemoryBlobStorage(),
    tools: [],
    systemPrompt: "Test system prompt.",
    projectTimeZone: "UTC",
    projectLocale: "en",
  }

  await runTurnInSession({
    storage: requireWorkerStorage(storage),
    context: baseContext,
    plan: {
      instructions: "Answer clearly.",
      model: firstModel,
      recordedModel: firstModel,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: seeded.run,
    signal: new AbortController().signal,
  })

  // Append Turn 3 + checkpoint that summarizes through Turn 2.
  await agents.messages.append({
    id: "message_5",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "Turn 3 secret follow-up" }],
  })
  const exec3 = await createTestAgentExecution(storage, { projectId, runId: "run_3" })
  await agents.runs.create({
    id: "run_3",
    projectId,
    executionId: exec3,
    threadId,
    triggerMessageId: "message_5",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  await agents.runs.start({
    id: "run_3",
    projectId,
    execution: {
      token: "execution_3",
      queueLeaseExpiresAt: new Date("2026-08-27T12:20:00.000Z"),
    },
  })
  await agents.checkpoints.create({
    id: "checkpoint_future",
    projectId,
    threadId,
    createdByRunId: "run_3",
    expectedPreviousCheckpointId: null,
    expectedHeadSeq: 5,
    executionToken: "execution_3",
    reason: "threshold",
    summary: "Summary mentioning Turn 3 secret follow-up.",
    summaryFormatVersion: 1,
    summarizedThroughSeq: 4,
    observedHeadSeq: 5,
    estimatedInputTokensBefore: 2_000,
    estimatedInputTokensAfter: 400,
    summaryModelId: "test-model",
  })
  await agents.runs.finish({
    id: "run_3",
    projectId,
    executionToken: "execution_3",
    status: "succeeded",
  })

  // Rewind Turn 2 (seq 3): delete checkpoints > 2 and messages >= 3, then append edited Turn 2.
  await agents.checkpoints.deleteAfterSeq({ projectId, threadId, afterSeq: 2 })
  await agents.messages.deleteFromSeq({ projectId, threadId, fromSeq: 3 })
  const editedMsg = await agents.messages.append({
    id: "message_3_edited",
    projectId,
    threadId,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "three (edited)" }],
  })
  expect(editedMsg.seq).toBe(3)

  const execEdited = await createTestAgentExecution(storage, { projectId, runId: "run_2_edited" })
  await agents.runs.create({
    id: "run_2_edited",
    projectId,
    executionId: execEdited,
    threadId,
    triggerMessageId: "message_3_edited",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const startedEdited = await agents.runs.start({
    id: "run_2_edited",
    projectId,
    execution: {
      token: "execution_2_edited",
      queueLeaseExpiresAt: new Date("2026-08-27T12:25:00.000Z"),
    },
  })
  if (startedEdited.kind !== "conversation") throw new Error("Expected conversation run")

  let rewoundMessagesSent: readonly ModelMessage[] | undefined
  let rewoundCaching: unknown
  const secondModel = new WorkerTestModel({
    modelId: "mock-model",
    stream: async (options) => {
      rewoundMessagesSent = options.messages
      rewoundCaching = options.caching
      return testStream([
        { type: "stream-start" },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Edited reply 2" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", usage },
      ])
    },
  })

  await runTurnInSession({
    storage: requireWorkerStorage(storage),
    context: baseContext,
    plan: {
      instructions: "Answer clearly.",
      model: secondModel,
      recordedModel: secondModel,
      tools: [],
      skills: [],
      ontologyDocs: { files: [], index: [] },
    },
    run: startedEdited,
    signal: new AbortController().signal,
  })

  if (!originalMessagesSent || !rewoundMessagesSent) {
    throw new Error("Expected both prompts to be captured.")
  }

  // Same threadId keeps exact cache intent & x-session-affinity key.
  expect(rewoundCaching).toEqual(originalCaching)
  // System prompt + Turn 1 user + Turn 1 assistant prefix is byte-for-byte identical.
  expect(rewoundMessagesSent.slice(0, -1)).toEqual(originalMessagesSent.slice(0, -1))
  // Nothing from Turn 2 original, Turn 3, or the deleted checkpoint/memory appears.
  const serialized = JSON.stringify(rewoundMessagesSent)
  expect(serialized).toContain("three (edited)")
  expect(serialized).not.toContain("Original reply 2")
  expect(serialized).not.toContain("Turn 3 secret")
  expect(serialized).not.toContain("Secret from deleted Turn 3")
})
