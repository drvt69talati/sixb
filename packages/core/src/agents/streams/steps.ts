import type { Broker, BrokerRecord } from "../../broker"
import type { ModelUiChunk } from "../../models/events"
import {
  type AgentRunStepsEvent,
  type AgentRunStreamEvent,
  agentRunStepsStreamId,
  isAgentRunStreamEvent,
} from "./protocol"

// A run's live stream carries one record per streamed delta, and drops its oldest past a limit: on
// its own it cannot rebuild a long turn. Its finished steps go to a stream of their own as well
// (see the stream sink), which a reader who opens the turn late reads first.

export type DeltaChunk = Extract<
  ModelUiChunk,
  { readonly type: "text-delta" | "reasoning-delta" | "tool-input-delta" }
>

export function isDeltaChunk(chunk: ModelUiChunk): chunk is DeltaChunk {
  return (
    chunk.type === "text-delta" ||
    chunk.type === "reasoning-delta" ||
    chunk.type === "tool-input-delta"
  )
}

/** Whether `next` extends `delta`'s span, so the two read as one delta. */
export function continuesDelta(delta: DeltaChunk, next: ModelUiChunk): next is DeltaChunk {
  if (next.type !== delta.type) return false
  if (delta.type === "tool-input-delta") {
    return next.type === "tool-input-delta" && next.toolCallId === delta.toolCallId
  }
  return (next as { readonly id?: string }).id === delta.id
}

export function mergeDeltas(delta: DeltaChunk, next: DeltaChunk): DeltaChunk {
  if (delta.type === "tool-input-delta" && next.type === "tool-input-delta") {
    return { ...delta, inputTextDelta: delta.inputTextDelta + next.inputTextDelta }
  }
  if (delta.type !== "tool-input-delta" && next.type !== "tool-input-delta") {
    return { ...delta, delta: delta.delta + next.delta }
  }
  return delta
}

/** Appends `chunk`, merged into the last chunk when it extends the same span. */
export function appendCompacted(chunks: ModelUiChunk[], chunk: ModelUiChunk): void {
  const last = chunks.at(-1)
  if (last && isDeltaChunk(last) && continuesDelta(last, chunk)) {
    chunks[chunks.length - 1] = mergeDeltas(last, chunk)
    return
  }
  chunks.push(chunk)
}

/**
 * A run's finished steps for one attempt, as one event, or null when none finished yet. Records of
 * an earlier attempt are left out: that attempt's work was redone.
 */
export async function readAgentRunSteps(
  broker: Broker,
  params: { readonly projectId: string; readonly runId: string; readonly attempt: number }
): Promise<AgentRunStepsEvent | null> {
  const streamId = agentRunStepsStreamId(params.runId)
  const records: BrokerRecord[] = []
  let afterCursor: string | undefined
  for (;;) {
    const page = await broker.read({
      projectId: params.projectId,
      streamId,
      ...(afterCursor === undefined ? {} : { afterCursor }),
      limit: 1_000,
    })
    records.push(...page.records)
    afterCursor = page.cursor ?? afterCursor
    if (!page.hasMore || page.records.length === 0) break
  }

  let last: AgentRunStepsEvent | null = null
  const chunks: ModelUiChunk[] = []
  for (const record of records) {
    const event = record.payload as unknown
    if (!isStepsEvent(event) || event.attempt !== params.attempt) continue
    for (const chunk of event.chunks) appendCompacted(chunks, chunk)
    last = event
  }
  return last === null ? null : { ...last, chunks }
}

function isStepsEvent(value: unknown): value is AgentRunStepsEvent {
  return isAgentRunStreamEvent(value) && (value as AgentRunStreamEvent).type === "agent.ui.steps"
}

/** Whether a live record is one of the chunks `steps` already covers. */
export function coveredBySteps(steps: AgentRunStepsEvent, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false
  const event = payload as Partial<Extract<AgentRunStreamEvent, { type: "agent.ui.chunk" }>>
  return (
    event.type === "agent.ui.chunk" &&
    event.attempt === steps.attempt &&
    typeof event.chunkIndex === "number" &&
    event.chunkIndex <= steps.throughChunkIndex
  )
}
