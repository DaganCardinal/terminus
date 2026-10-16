import {
  dispatcherConversationSchema,
  dispatcherMessageSchema,
  type ConversationSummary,
  type DispatcherMessage,
  type StoredDispatcherMessage,
} from "@terminus/protocol"
import type { DispatcherConversation } from "@terminus/domain"
import { StaleWriteError, type Loaded } from "./network-store"

/** A turn tried to write after it stopped being the active one. */
export class TurnFencedError extends Error {
  constructor() {
    super("The turn is no longer active")
    this.name = "TurnFencedError"
  }
}

interface ConversationRow {
  id: string
  network_id: string
  record: string
  version: number
  updated_at: string
}

interface MessageRow {
  seq: number
  turn_id: string
  position: number
  at: string
  message: string
}

export type LoadedConversation = Loaded<DispatcherConversation> & {
  updatedAt: string
}

const PAGE = 100

/**
 * D1 persistence for Dispatcher conversations. Every write a turn makes is
 * fenced: it lands only while the conversation still names that turn as
 * active, so a stopped turn's late writes are discarded. Messages are keyed
 * by (turn, position) and read back, so a retried step never duplicates one.
 */
export class ConversationStore {
  readonly #db: D1Database
  constructor(db: D1Database) {
    this.#db = db
  }

  /** Creates a conversation, or returns the one this request already made. */
  async create(
    conversation: DispatcherConversation,
    requestId: string,
    at: string
  ): Promise<LoadedConversation> {
    await this.#db
      .prepare(
        "INSERT INTO dispatcher_conversations (id, network_id, record, version, updated_at, request_id) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(request_id) DO NOTHING"
      )
      .bind(
        conversation.id,
        conversation.networkId,
        JSON.stringify(dispatcherConversationSchema.parse(conversation)),
        at,
        requestId
      )
      .run()
    const row = await this.#db
      .prepare(
        "SELECT id, network_id, record, version, updated_at FROM dispatcher_conversations WHERE request_id = ?"
      )
      .bind(requestId)
      .first<ConversationRow>()
    if (!row) throw new Error("Conversation was not created")
    return loaded(row)
  }

  async conversation(id: string): Promise<LoadedConversation | null> {
    const row = await this.#db
      .prepare(
        "SELECT id, network_id, record, version, updated_at FROM dispatcher_conversations WHERE id = ?"
      )
      .bind(id)
      .first<ConversationRow>()
    return row ? loaded(row) : null
  }

  /** Most recently active first, with the plans each conversation started. */
  async list(networkId: string, limit = 50): Promise<ConversationSummary[]> {
    const [conversations, plans] = await this.#db.batch<
      ConversationRow & { plan_id?: string; conversation_id?: string }
    >([
      this.#db
        .prepare(
          "SELECT id, network_id, record, version, updated_at FROM dispatcher_conversations WHERE network_id = ? ORDER BY updated_at DESC, id LIMIT ?"
        )
        .bind(networkId, limit),
      this.#db
        .prepare(
          "SELECT id AS plan_id, json_extract(record, '$.conversationId') AS conversation_id FROM dispatch_plans WHERE network_id = ? AND json_extract(record, '$.conversationId') IS NOT NULL ORDER BY json_extract(record, '$.createdAt')"
        )
        .bind(networkId),
    ])
    const planIds = new Map<string, string[]>()
    for (const row of plans!.results) {
      const list = planIds.get(row.conversation_id!) ?? []
      list.push(row.plan_id!)
      planIds.set(row.conversation_id!, list)
    }
    return conversations!.results.map((row) =>
      summary(loaded(row), planIds.get(row.id) ?? [])
    )
  }

  async summary(
    conversation: LoadedConversation
  ): Promise<ConversationSummary> {
    const { results } = await this.#db
      .prepare(
        "SELECT id FROM dispatch_plans WHERE json_extract(record, '$.conversationId') = ? ORDER BY json_extract(record, '$.createdAt')"
      )
      .bind(conversation.value.id)
      .all<{ id: string }>()
    return summary(
      conversation,
      results.map((row) => row.id)
    )
  }

  /** The user message a request already sent, if any. */
  async messageForRequest(
    requestId: string
  ): Promise<(StoredDispatcherMessage & { conversationId: string }) | null> {
    const row = await this.#db
      .prepare(
        "SELECT seq, turn_id, position, at, message, conversation_id FROM dispatcher_messages WHERE request_id = ?"
      )
      .bind(requestId)
      .first<MessageRow & { conversation_id: string }>()
    return row ? { ...stored(row), conversationId: row.conversation_id } : null
  }

  /**
   * Accepts a user message and starts its turn, atomically. Throws
   * StaleWriteError if the conversation changed since it was read.
   */
  async acceptMessage(
    before: LoadedConversation,
    after: DispatcherConversation,
    input: {
      turnId: string
      requestId: string
      message: Extract<DispatcherMessage, { kind: "user" }>
      at: string
    }
  ): Promise<StoredDispatcherMessage> {
    try {
      await this.#db.batch([
        this.#update(before, after, input.at),
        this.#db
          .prepare(
            "INSERT INTO dispatcher_messages (conversation_id, turn_id, position, at, message, request_id) VALUES (?, ?, 0, ?, ?, ?)"
          )
          .bind(
            after.id,
            input.turnId,
            input.at,
            JSON.stringify(dispatcherMessageSchema.parse(input.message)),
            input.requestId
          ),
      ])
    } catch (error) {
      if (String(error).includes("stale_write")) throw new StaleWriteError()
      throw error
    }
    const [message] = await this.turnMessages(input.turnId)
    return message!
  }

  /**
   * Saves a turn's messages at fixed positions while the turn is still
   * active, and returns what is saved at those positions. A retried write
   * keeps the first copy. Throws TurnFencedError once the turn has ended.
   */
  async appendTurnMessages(
    conversationId: string,
    turnId: string,
    entries: { position: number; message: DispatcherMessage }[],
    at: string
  ): Promise<StoredDispatcherMessage[]> {
    if (entries.length)
      await this.#db.batch(
        entries.map(({ position, message }) =>
          this.#db
            .prepare(
              `INSERT OR IGNORE INTO dispatcher_messages (conversation_id, turn_id, position, at, message)
               SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (
                 SELECT 1 FROM dispatcher_conversations WHERE id = ?1
                   AND json_extract(record, '$.state.status') = 'responding'
                   AND json_extract(record, '$.state.turnId') = ?2)`
            )
            .bind(
              conversationId,
              turnId,
              position,
              at,
              JSON.stringify(dispatcherMessageSchema.parse(message))
            )
        )
      )
    const saved = await this.turnMessages(turnId)
    const wanted = new Set(entries.map((entry) => entry.position))
    const found = saved.filter((message) => wanted.has(message.position))
    if (found.length !== wanted.size) throw new TurnFencedError()
    return found
  }

  /** Ends a turn, with its closing message when it has one. */
  async endTurn(
    before: LoadedConversation,
    after: DispatcherConversation,
    turnId: string,
    closing: { position: number; message: DispatcherMessage } | null,
    at: string
  ): Promise<void> {
    try {
      await this.#db.batch([
        // Inserted first, while the turn is still the active one.
        ...(closing
          ? [
              this.#db
                .prepare(
                  "INSERT OR IGNORE INTO dispatcher_messages (conversation_id, turn_id, position, at, message) VALUES (?, ?, ?, ?, ?)"
                )
                .bind(
                  after.id,
                  turnId,
                  closing.position,
                  at,
                  JSON.stringify(dispatcherMessageSchema.parse(closing.message))
                ),
            ]
          : []),
        this.#update(before, after, at),
      ])
    } catch (error) {
      if (String(error).includes("stale_write")) throw new StaleWriteError()
      throw error
    }
  }

  /** Saves a change to the record alone, such as token usage. */
  async save(
    before: LoadedConversation,
    after: DispatcherConversation,
    at: string
  ): Promise<void> {
    try {
      await this.#update(before, after, at).run()
    } catch (error) {
      if (String(error).includes("stale_write")) throw new StaleWriteError()
      throw error
    }
  }

  async turnMessages(turnId: string): Promise<StoredDispatcherMessage[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT seq, turn_id, position, at, message FROM dispatcher_messages WHERE turn_id = ? ORDER BY position"
      )
      .bind(turnId)
      .all<MessageRow>()
    return results.map(stored)
  }

  /** Every message of the conversation's other turns, oldest first. */
  async history(
    conversationId: string,
    exceptTurnId: string
  ): Promise<StoredDispatcherMessage[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT seq, turn_id, position, at, message FROM dispatcher_messages WHERE conversation_id = ? AND turn_id <> ? ORDER BY seq"
      )
      .bind(conversationId, exceptTurnId)
      .all<MessageRow>()
    return results.map(stored)
  }

  /** A page of messages after a cursor, for the panel. */
  async messagesAfter(
    conversationId: string,
    after: number
  ): Promise<{ messages: StoredDispatcherMessage[]; hasMore: boolean }> {
    const { results } = await this.#db
      .prepare(
        "SELECT seq, turn_id, position, at, message FROM dispatcher_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?"
      )
      .bind(conversationId, after, PAGE + 1)
      .all<MessageRow>()
    return {
      messages: results.slice(0, PAGE).map(stored),
      hasMore: results.length > PAGE,
    }
  }

  /** Newest first, without tool messages, for `terminus_conversation`. */
  async readableMessagesBefore(
    conversationId: string,
    before: number | undefined,
    limit: number
  ): Promise<StoredDispatcherMessage[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT seq, turn_id, position, at, message FROM dispatcher_messages
         WHERE conversation_id = ? AND seq < ?
           AND json_extract(message, '$.kind') IN ('user', 'dispatcher', 'plan')
         ORDER BY seq DESC LIMIT ?`
      )
      .bind(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit)
      .all<MessageRow>()
    return results.map(stored)
  }

  /** Conversation titles and user messages that mention the text. */
  async search(
    networkId: string,
    query: string,
    limit: number
  ): Promise<{
    conversations: { id: string; title: string }[]
    messages: { conversationId: string; seq: number; text: string }[]
  }> {
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const [conversations, messages] = await this.#db.batch<
      Record<string, unknown>
    >([
      this.#db
        .prepare(
          "SELECT id, json_extract(record, '$.title') AS title FROM dispatcher_conversations WHERE network_id = ? AND json_extract(record, '$.title') LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?"
        )
        .bind(networkId, like, limit),
      this.#db
        .prepare(
          `SELECT m.conversation_id, m.seq, json_extract(m.message, '$.text') AS text
           FROM dispatcher_messages m JOIN dispatcher_conversations c ON c.id = m.conversation_id
           WHERE c.network_id = ? AND json_extract(m.message, '$.kind') = 'user'
             AND json_extract(m.message, '$.text') LIKE ? ESCAPE '\\'
           ORDER BY m.seq DESC LIMIT ?`
        )
        .bind(networkId, like, limit),
    ])
    return {
      conversations: conversations!.results.map((row) => ({
        id: String(row.id),
        title: String(row.title),
      })),
      messages: messages!.results.map((row) => ({
        conversationId: String(row.conversation_id),
        seq: Number(row.seq),
        text: String(row.text),
      })),
    }
  }

  /** Every turn a network ran, for deletion cleanup. */
  async turnIds(networkId: string): Promise<string[]> {
    const { results } = await this.#db
      .prepare(
        "SELECT DISTINCT m.turn_id FROM dispatcher_messages m JOIN dispatcher_conversations c ON c.id = m.conversation_id WHERE c.network_id = ?"
      )
      .bind(networkId)
      .all<{ turn_id: string }>()
    return results.map((row) => row.turn_id)
  }

  #update(
    before: LoadedConversation,
    after: DispatcherConversation,
    at: string
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        "UPDATE dispatcher_conversations SET record = ?, version = ?, updated_at = ? WHERE id = ?"
      )
      .bind(
        JSON.stringify(dispatcherConversationSchema.parse(after)),
        before.version + 1,
        at,
        after.id
      )
  }
}

function loaded(row: ConversationRow): LoadedConversation {
  return {
    value: dispatcherConversationSchema.parse(JSON.parse(row.record)),
    version: row.version,
    networkId: row.network_id,
    updatedAt: row.updated_at,
  }
}

function stored(row: MessageRow): StoredDispatcherMessage {
  return {
    seq: row.seq,
    turnId: row.turn_id,
    position: row.position,
    at: row.at,
    message: dispatcherMessageSchema.parse(JSON.parse(row.message)),
  }
}

export function summary(
  conversation: LoadedConversation,
  planIds: string[]
): ConversationSummary {
  const { state } = conversation.value
  return {
    id: conversation.value.id,
    title: conversation.value.title,
    state: state.status,
    ...(state.status === "responding" ? { turnId: state.turnId } : {}),
    updatedAt: conversation.updatedAt,
    planIds,
  }
}
