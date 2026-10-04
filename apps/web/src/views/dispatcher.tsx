import { useEffect, useRef } from "react"
import { ArrowUpRight, Route, X } from "lucide-react"
import type { NetworkSnapshot } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { TechnicianRepairs } from "./technician-repairs"
import { DispatcherAlerts } from "./dispatcher-alerts"
import { DispatcherPlanner } from "./dispatcher-planner"
import { dispatcherIndicator } from "./dispatcher-state"

/** Floating Dispatcher button. Its colour and pulse reflect what the
 * Dispatcher is doing and whether it needs the user. */
export function DispatcherButton({
  snapshot,
  onOpen,
}: {
  snapshot: NetworkSnapshot
  onOpen: () => void
}) {
  const { tone, label } = dispatcherIndicator(snapshot)
  return (
    <button
      className={`dispatcher-fab dispatcher-${tone}`}
      onClick={onOpen}
      aria-label={`Open Dispatcher: ${label}`}
      aria-haspopup="dialog"
    >
      <Route size={22} />
      <span className="dispatcher-fab-label">{label}</span>
    </button>
  )
}

export function DispatcherModal({
  snapshot,
  open,
  onClose,
  pending,
  error,
  retry,
  openTrain,
  layDemoLines,
}: {
  snapshot: NetworkSnapshot
  open: boolean
  onClose: () => void
  pending: boolean
  error: string | null
  retry: (trainId: string) => Promise<void>
  openTrain: (lineId: string) => void
  layDemoLines: () => Promise<void>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const { tone, label } = dispatcherIndicator(snapshot)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dispatcher-modal"
      aria-labelledby="dispatcher-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dispatcher-modal-inner">
        <header className="dispatcher-modal-header">
          <span className={`dispatcher-mark dispatcher-${tone}`}>
            <Route size={17} />
          </span>
          <h2 id="dispatcher-title">Dispatcher</h2>
          <span className="dispatcher-modal-status">
            {tone === "idle" ? "Plan work, then launch" : label}
          </span>
          <button onClick={onClose} aria-label="Close Dispatcher">
            <X size={18} />
          </button>
        </header>
        <div className="dispatcher-modal-body">
          <DispatcherAlerts
            snapshot={snapshot}
            showConflicts={false}
            pending={pending}
            error={error}
            retry={retry}
            openTrain={openTrain}
          />
          <TechnicianRepairs snapshot={snapshot} />
          <DispatcherPlanner snapshot={snapshot} />
          {snapshot.lines.length === 0 && (
            <div className="dispatcher-demo">
              <p>
                <strong>No Lines on this network yet.</strong> Describe a goal
                above and review its plan, or lay the fixed demo Lines to
                explore the railway.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void layDemoLines()}
              >
                {pending ? "Laying Lines…" : "Lay demo Lines"}
                <ArrowUpRight size={15} />
              </Button>
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}
