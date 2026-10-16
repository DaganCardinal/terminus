import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react"
import {
  ArrowUp,
  Maximize2,
  Minimize2,
  Plus,
  Route,
  Sparkles,
  X,
} from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api, ApiRequestError } from "@/state/api"
import {
  AttentionMessages,
  attentionTrains,
  repairThreads,
  ConflictMessages,
  conflictThreads,
} from "./dispatcher-alerts"
import {
  DispatcherAvatar,
  DispatcherMessage,
  Typing,
  UserMessage,
} from "./dispatcher-message"
import { PlanExchange } from "./dispatcher-planner"
import { ConversationThread } from "./dispatcher-conversation"
import { useConversation, useConversations } from "@/state/use-conversation"
import { dispatcherIndicator } from "./dispatcher-state"
import { RepairMessages } from "./technician-repairs"

/** Floating Dispatcher button. Its colour and pulse reflect what the
 * Dispatcher is doing and whether it needs the user. */
export function DispatcherButton({
  snapshot,
  onOpen,
  hidden,
  ref,
}: {
  snapshot: NetworkSnapshot
  onOpen: () => void
  hidden: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  const { tone, label } = dispatcherIndicator(snapshot)
  return (
    <button
      ref={ref}
      className={`dispatcher-fab dispatcher-${tone}`}
      onClick={onOpen}
      hidden={hidden}
      aria-label={`Open Dispatcher: ${label}`}
      aria-controls="dispatcher-panel"
      aria-expanded={!hidden}
    >
      <Route size={22} />
      <span className="dispatcher-fab-label">{label}</span>
    </button>
  )
}

/** A message on its way, shown until the server's copy arrives. */
type Sending = {
  text: string
  requestId: string
  checkBaseline: boolean
  /** Set once the server accepted it. */
  turnId?: string
}

/** Choosing "New conversation" before its first message creates it. */
const NEW = "new"

/** The Dispatcher as a collaborator beside the map: one conversation at a
 * time, the plans it starts, and the things it needs the user for. Every
 * message comes from the server, so a refresh rebuilds the same thread. */
export function DispatcherPanel({
  snapshot,
  open,
  mobile,
  onClose,
  onResize,
  openTrain,
}: {
  snapshot: NetworkSnapshot
  open: boolean
  mobile: boolean
  onClose: () => void
  onResize: (width: number) => void
  openTrain: (lineId: string) => void
}) {
  const networkId = snapshot.network.id
  const indicator = dispatcherIndicator(snapshot)
  const [wide, setWide] = useState(false)
  const [draft, setDraft] = useState("")
  const [checkBaseline, setCheckBaseline] = useState(false)
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  // The conversation the user picked; otherwise the most recently active.
  const [selected, setSelected] = useState<string | null>(null)
  const newConversation = useRef<string | null>(null)
  const panel = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const { conversations, refresh: refreshList } = useConversations(
    networkId,
    open
  )
  const conversationId =
    selected === NEW ? null : (selected ?? conversations?.[0]?.id ?? null)
  const { view, refresh } = useConversation(networkId, conversationId, open)
  const conversation =
    view?.conversation ??
    conversations?.find((c) => c.id === conversationId) ??
    null
  const responding = conversation?.state === "responding"
  const messages = view?.messages ?? []
  const showSending =
    sending &&
    !(
      sending.turnId &&
      messages.some(
        (m) => m.turnId === sending.turnId && m.message.kind === "user"
      )
    )

  const earlierPlans = snapshot.plans.filter((plan) => !plan.conversationId)
  const latestEarlier = earlierPlans.at(-1)
  const { blocked, awaiting, notices } = attentionTrains(snapshot)
  const conflicts = conflictThreads(snapshot)
  const repairs = repairThreads(snapshot)
  const needs =
    blocked.length +
    awaiting.length +
    conflicts.reported.length +
    repairs.length +
    notices.length
  const running = snapshot.trains.filter(
    ({ train }) => !["unloaded", "siding"].includes(train.state.status)
  ).length
  const status = responding
    ? "Answering…"
    : indicator.tone !== "idle"
      ? indicator.label
      : running > 0
        ? `${running} ${running === 1 ? "Train" : "Trains"} running`
        : "Ready when you are"

  const command = useCallback(async (run: () => Promise<unknown>) => {
    setPending(true)
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPending(false)
    }
  }, [])

  function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || pending || responding || stopping) return
    // A resend of the same text keeps its request identity, so a retried
    // request cannot send the message twice.
    const request: Sending =
      sending &&
      !sending.turnId &&
      sending.text === trimmed &&
      sending.checkBaseline === checkBaseline
        ? sending
        : { text: trimmed, requestId: crypto.randomUUID(), checkBaseline }
    setSending(request)
    setDraft("")
    void command(async () => {
      try {
        let id = conversationId
        if (!id) {
          newConversation.current ??= crypto.randomUUID()
          id = (
            await api.createConversation(networkId, newConversation.current)
          ).id
          newConversation.current = null
          setSelected(id)
          refreshList()
        }
        const sent = await api.sendConversationMessage(networkId, id, {
          requestId: request.requestId,
          text: request.text,
          ...(request.checkBaseline ? { checkBaseline: true } : {}),
        })
        setSending({ ...request, turnId: sent.turnId })
        refresh()
      } catch (caught) {
        setSending(null)
        setDraft(request.text)
        throw caught
      }
    })
  }

  async function stop() {
    const turnId = conversation?.turnId
    if (!conversationId || !turnId || stopping) return
    setStopping(true)
    setError(null)
    try {
      await api.stopConversationTurn(networkId, conversationId, turnId)
    } catch (caught) {
      // The turn may have finished on its own just before.
      if (!(caught instanceof ApiRequestError) || caught.status !== 409)
        setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setStopping(false)
      refresh()
    }
  }

  function startNew() {
    newConversation.current = null
    setSelected(NEW)
    setSending(null)
    setError(null)
    requestAnimationFrame(() => input.current?.focus())
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    send(draft)
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      send(draft)
    }
  }

  // The composer grows with its text, up to a limit. A hidden panel has
  // nothing to measure, so it measures again when it opens.
  useLayoutEffect(() => {
    const field = input.current
    if (!field || !open) return
    field.style.height = "auto"
    field.style.height = `${Math.min(field.scrollHeight, 200)}px`
  }, [draft, open])

  // Report the docked width so the map can centre beside the panel.
  useEffect(() => {
    const element = panel.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) onResize(entry.borderBoxSize[0]?.inlineSize ?? 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onResize])

  // Opening lands on the newest messages, ready to type.
  useLayoutEffect(() => {
    if (!open) return
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
    if (!mobile) input.current?.focus({ preventScroll: true })
  }, [open, mobile, conversationId])

  // New messages scroll into view while the reader is following along.
  const signature = `${conversationId}|${messages.length}|${responding ? 1 : 0}|${showSending ? 1 : 0}|${needs}`
  const previous = useRef(signature)
  useEffect(() => {
    const element = scroller.current
    if (!element || previous.current === signature) return
    previous.current = signature
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }, [signature])

  const empty =
    snapshot.plans.length === 0 &&
    snapshot.lines.length === 0 &&
    !messages.length

  return (
    <aside
      ref={panel}
      id="dispatcher-panel"
      className={`dispatcher-panel ${wide ? "dispatcher-panel-wide" : ""}`}
      aria-labelledby="dispatcher-title"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="drawer-grip" aria-hidden="true" />
      <header className="dpanel-head">
        <DispatcherAvatar
          tone={responding ? "working" : indicator.tone}
          size="lg"
        />
        <div className="dpanel-title">
          <h2 id="dispatcher-title">Dispatcher</h2>
          <p role="status">{status}</p>
        </div>
        {needs > 0 && (
          <button
            className="needs-chip"
            onClick={() =>
              scroller.current
                ?.querySelector(".thread-divider")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {needs} {needs === 1 ? "needs" : "need"} you
          </button>
        )}
        {!mobile && (
          <button
            className="dpanel-icon"
            onClick={() => setWide(!wide)}
            aria-label={wide ? "Narrow the Dispatcher" : "Widen the Dispatcher"}
            aria-pressed={wide}
          >
            {wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        <button
          className="dpanel-icon"
          onClick={onClose}
          aria-label="Close Dispatcher"
        >
          <X size={17} />
        </button>
      </header>
      <div className="dpanel-conversations">
        <label htmlFor="dispatcher-conversation" className="sr-only">
          Conversation
        </label>
        <select
          id="dispatcher-conversation"
          value={conversationId ?? NEW}
          disabled={pending}
          onChange={(event) => {
            setSelected(event.target.value)
            setSending(null)
            setError(null)
          }}
        >
          {!conversationId && <option value={NEW}>New conversation</option>}
          {(conversations ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || "New conversation"}
            </option>
          ))}
        </select>
        <button
          className="dpanel-new"
          onClick={startNew}
          disabled={pending || !conversationId}
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div ref={scroller} className="dpanel-thread">
        <DispatcherMessage meta="Dispatcher">
          <p>
            I plan and follow work for <strong>{snapshot.network.name}</strong>.
            Ask me where things stand, or tell me what you want to build and
            I&rsquo;ll lay it out as Lines that can run side by side.
          </p>
          <p>
            You review every plan. Nothing runs until you launch it, and
            replying is how you change a plan.
          </p>
          {empty && (
            <div className="starters">
              <div className="starters-demo">
                <span>Just exploring?</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void command(() => api.layDemoLines(networkId))
                  }
                >
                  <Sparkles size={14} />
                  {pending ? "Laying tracks…" : "Lay demo Lines"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void command(() => api.layCrossingDemoLines(networkId))
                  }
                >
                  Lay Crossing demo
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void command(() => api.layJunctionDemo(networkId))
                  }
                >
                  Lay Junction demo
                </Button>
              </div>
            </div>
          )}
        </DispatcherMessage>

        {earlierPlans.length > 0 && (
          <details className="earlier-plans">
            <summary>Earlier plans · {earlierPlans.length}</summary>
            {earlierPlans.map((plan) => (
              <PlanExchange
                key={plan.id}
                plan={plan}
                snapshot={snapshot}
                latest={plan === latestEarlier}
                pending={pending}
                visible={open}
                command={command}
                openTrain={openTrain}
              />
            ))}
          </details>
        )}

        <ConversationThread
          messages={messages}
          snapshot={snapshot}
          responding={responding && !showSending}
          pending={pending}
          visible={open}
          command={command}
          openTrain={openTrain}
        />

        {showSending && (
          <div className="exchange">
            <UserMessage text={sending.text} sending={!sending.turnId} />
            <DispatcherMessage tone="working">
              <p className="dmsg-status" role="status">
                <Typing />
                <span>Reading your message…</span>
              </p>
            </DispatcherMessage>
          </div>
        )}

        {needs > 0 && (
          <>
            <div className="thread-divider" role="separator">
              <span>Needs you · {needs}</span>
            </div>
            <RepairMessages
              snapshot={snapshot}
              pending={pending}
              command={command}
              openTrain={openTrain}
            />
            <ConflictMessages
              snapshot={snapshot}
              pending={pending}
              command={command}
              openTrain={openTrain}
            />
            <AttentionMessages
              snapshot={snapshot}
              pending={pending}
              command={command}
              openTrain={openTrain}
            />
          </>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        {error && (
          <p className="composer-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </p>
        )}
        <div className="composer-box">
          <label htmlFor="dispatch-goal" className="sr-only">
            Message the Dispatcher
          </label>
          <textarea
            ref={input}
            id="dispatch-goal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKey}
            maxLength={4000}
            rows={1}
            placeholder={
              messages.length
                ? "Reply to the Dispatcher…"
                : "Ask about the network, or describe what to build…"
            }
          />
          {responding ? (
            <button
              type="button"
              className="composer-send composer-stop"
              disabled={stopping}
              onClick={() => void stop()}
              aria-label="Stop the Dispatcher's answer"
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send"
              disabled={pending || stopping || !draft.trim()}
              aria-label="Send to the Dispatcher"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        <div className="composer-footer">
          <label
            className="composer-option"
            title="If this message starts a plan, install dependencies and run the project's checks before exploring. Slower; a failing check gets a suggested fix you can reject."
          >
            <input
              type="checkbox"
              checked={checkBaseline}
              onChange={(event) => setCheckBaseline(event.target.checked)}
            />
            Check baseline first
          </label>
          <p className="composer-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a
            new line
          </p>
        </div>
      </form>
    </aside>
  )
}
