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
import { ArrowUp, Maximize2, Minimize2, Route, Sparkles, X } from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"
import { AttentionMessages, attentionTrains } from "./dispatcher-alerts"
import {
  DispatcherAvatar,
  DispatcherMessage,
  Typing,
  UserMessage,
} from "./dispatcher-message"
import { PlanExchange } from "./dispatcher-planner"
import { dispatcherIndicator } from "./dispatcher-state"
import { RepairMessages, repairThreads } from "./technician-repairs"

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

/** Example goals for an empty thread. They fill the composer; the user
 * still decides what to send. */
const starters = [
  "Add an accessible footer with links and a copyright line, with tests",
  "Add a light/dark theme toggle that remembers the choice",
  "Improve the README with setup and contribution instructions",
]

type Sent = { goal: string; requestId: string; planId?: string }

/** The Dispatcher as a collaborator beside the map: a thread of goals, the
 * plans it proposes, and the things it needs the user for. Every message is
 * a projection of the snapshot, so a refresh rebuilds the same thread. */
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
  const [sent, setSent] = useState<Sent | null>(null)
  // The goal being refined, shown above the composer until it is sent.
  const [revising, setRevising] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  const plans = snapshot.plans
  const latest = plans.at(-1)
  const showSent = sent && !plans.some((plan) => plan.id === sent.planId)
  const { blocked, awaiting } = attentionTrains(snapshot)
  const repairs = repairThreads(snapshot)
  const needs = blocked.length + awaiting.length + repairs.length
  const running = snapshot.trains.filter(
    ({ train }) => !["unloaded", "siding"].includes(train.state.status)
  ).length
  const status =
    indicator.tone !== "idle"
      ? indicator.label
      : running > 0
        ? `${running} ${running === 1 ? "Train" : "Trains"} running`
        : "Ready for your next goal"

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

  function propose(goal: string) {
    const trimmed = goal.trim()
    if (!trimmed || pending) return
    // A resend of the same text keeps its request identity, so a retried
    // request cannot create a second plan.
    const request =
      sent && sent.goal === trimmed && !sent.planId
        ? sent
        : { goal: trimmed, requestId: crypto.randomUUID() }
    setSent(request)
    setDraft("")
    setRevising(null)
    void command(async () => {
      try {
        const created = await api.proposePlan(networkId, {
          goal: request.goal,
          requestId: request.requestId,
        })
        setSent({ ...request, planId: created.id })
      } catch (caught) {
        setSent(null)
        setDraft(request.goal)
        throw caught
      }
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    propose(draft)
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      propose(draft)
    }
  }

  const refine = useCallback((goal: string, revise = true) => {
    setDraft(goal)
    setRevising(revise ? goal : null)
    requestAnimationFrame(() => {
      const field = input.current
      if (!field) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    })
  }, [])

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
  }, [open, mobile])

  // New messages scroll into view while the reader is following along. A
  // freshly drafted plan scrolls to its start so it reads top to bottom.
  const signature = `${plans.map((p) => `${p.id}:${p.state.status}`).join()}|${needs}|${showSent ? 1 : 0}`
  const previous = useRef({ signature, latest: latest?.state.status })
  useEffect(() => {
    const element = scroller.current
    const before = previous.current
    previous.current = { signature, latest: latest?.state.status }
    if (!element || before.signature === signature) return
    if (latest?.state.status === "ready" && before.latest === "planning") {
      element
        .querySelector(`[data-plan="${latest.id}"] .dmsg`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" })
      return
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }, [signature, latest])

  const empty = plans.length === 0 && snapshot.lines.length === 0

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
        <DispatcherAvatar tone={indicator.tone} size="lg" />
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

      <div ref={scroller} className="dpanel-thread">
        <DispatcherMessage meta="Dispatcher">
          <p>
            I plan work for <strong>{snapshot.network.name}</strong>. Tell me
            what you want to build and I&rsquo;ll lay it out as Lines that can
            run side by side, with a Work Manifest for every Station.
          </p>
          <p>You review the plan. Nothing runs until you launch it.</p>
          {empty && (
            <div className="starters">
              <p className="starters-label">Try one of these</p>
              {starters.map((starter) => (
                <button key={starter} onClick={() => refine(starter, false)}>
                  {starter}
                </button>
              ))}
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
                  {pending ? "Laying Lines…" : "Lay demo Lines"}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void command(() => api.layCrossingDemoLines(networkId))
                  }
                >
                  Lay Crossing demo
                </Button>
              </div>
            </div>
          )}
        </DispatcherMessage>

        {plans.map((plan) => (
          <PlanExchange
            key={plan.id}
            plan={plan}
            snapshot={snapshot}
            latest={plan === latest}
            pending={pending}
            command={command}
            refine={refine}
            propose={propose}
            openTrain={openTrain}
          />
        ))}

        {showSent && (
          <div className="exchange">
            <UserMessage text={sent.goal} sending={!sent.planId} />
            <DispatcherMessage tone="working">
              <p className="dmsg-status" role="status">
                <Typing />
                <span>Reading your goal…</span>
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
        {revising && (
          <div className="composer-context">
            <span>
              Revising <q>{revising}</q>. Sending drafts a fresh plan.
            </span>
            <button
              type="button"
              onClick={() => {
                setRevising(null)
                setDraft("")
              }}
              aria-label="Stop revising"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="composer-box">
          <label htmlFor="dispatch-goal" className="sr-only">
            Goal for the Dispatcher
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
              revising
                ? "Describe what to change…"
                : plans.length
                  ? "Describe what to build next…"
                  : "Describe what you want to build…"
            }
          />
          <button
            type="submit"
            className="composer-send"
            disabled={pending || !draft.trim()}
            aria-label="Send goal to the Dispatcher"
          >
            <ArrowUp size={17} />
          </button>
        </div>
        <p className="composer-hint">
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new
          line
        </p>
      </form>
    </aside>
  )
}
