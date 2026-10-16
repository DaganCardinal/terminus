import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ConversationMessagesResponse,
  ConversationSummary,
  StoredDispatcherMessage,
} from "@terminus/protocol"
import { api } from "./api"
import { pollWhileVisible } from "./poll-while-visible"

/** How often the panel asks for new messages. */
const RESPONDING_MS = 1000
const IDLE_MS = 5000
const LIST_MS = 15_000

export interface ConversationView {
  conversationId: string
  conversation: ConversationSummary | null
  messages: StoredDispatcherMessage[]
  lastSeq: number
}

/** Adds a page of messages to what the panel already has, by seq. */
export function mergeConversation(
  view: ConversationView,
  page: ConversationMessagesResponse
): ConversationView {
  const known = new Set(view.messages.map((m) => m.seq))
  return {
    conversationId: view.conversationId,
    conversation: page.conversation,
    messages: [
      ...view.messages,
      ...page.messages.filter((m) => !known.has(m.seq)),
    ].sort((a, b) => a.seq - b.seq),
    lastSeq: Math.max(view.lastSeq, page.lastSeq),
  }
}

/** The network's conversations, most recently active first. */
export function useConversations(networkId: string, visible: boolean) {
  const [conversations, setConversations] = useState<
    ConversationSummary[] | null
  >(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const stop = pollWhileVisible(async () => {
      try {
        const list = await api.conversations(networkId)
        if (!cancelled) setConversations(list)
      } catch {
        // The next poll tries again; the panel keeps what it has.
      }
    }, LIST_MS)
    return () => {
      cancelled = true
      stop()
    }
  }, [networkId, visible, version])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  return { conversations, refresh }
}

/**
 * One conversation's messages, polled while the panel is visible: often
 * while a turn runs, rarely otherwise. Only new messages are fetched.
 */
export function useConversation(
  networkId: string,
  conversationId: string | null,
  visible: boolean
) {
  const empty = (id: string): ConversationView => ({
    conversationId: id,
    conversation: null,
    messages: [],
    lastSeq: 0,
  })
  const [view, setView] = useState<ConversationView | null>(null)
  const current = useRef<ConversationView | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [nudge, setNudge] = useState(0)
  const responding = view?.conversation?.state === "responding"

  useEffect(() => {
    if (!visible || !conversationId) return
    let cancelled = false
    if (current.current?.conversationId !== conversationId)
      current.current = empty(conversationId)
    const stop = pollWhileVisible(
      async () => {
        try {
          let page: ConversationMessagesResponse
          do {
            const before = current.current!
            page = await api.conversationMessages(
              networkId,
              conversationId,
              before.lastSeq
            )
            if (cancelled) return
            current.current = mergeConversation(before, page)
            setView(current.current)
          } while (page.hasMore)
          setUnavailable(false)
        } catch {
          if (!cancelled) setUnavailable(true)
        }
      },
      responding ? RESPONDING_MS : IDLE_MS
    )
    return () => {
      cancelled = true
      stop()
    }
  }, [networkId, conversationId, visible, responding, nudge])

  /** Fetch now, after the user sent or stopped something. */
  const refresh = useCallback(() => setNudge((n) => n + 1), [])
  return {
    view: view?.conversationId === conversationId ? view : null,
    unavailable,
    refresh,
  }
}
