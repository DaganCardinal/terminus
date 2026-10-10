import { useId, useRef, useState } from "react"
import { CircleStop, LoaderCircle } from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import type { EmergencyBrakeResult } from "@terminus/protocol"
import { api } from "@/state/api"

export function EmergencyBrakeButton({
  networkId,
  compact = false,
}: {
  networkId: string
  compact?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<EmergencyBrakeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const stop = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.emergencyBrake(networkId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? "emergency-brake-compact" : "emergency-brake"}>
      <Button
        variant="outline"
        size={compact ? "lg" : "sm"}
        className="emergency-brake-trigger"
        disabled={busy}
        onClick={() => {
          setResult(null)
          setError(null)
          dialog.current?.showModal()
        }}
      >
        {busy ? (
          <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
        ) : (
          <CircleStop size={16} aria-hidden="true" />
        )}
        {busy ? "Stopping Stations…" : "Emergency Brake"}
      </Button>
      {!compact && (
        <p className="detail-note">
          Stop this network’s Station agents and free their containers.
        </p>
      )}
      <dialog
        ref={dialog}
        className="emergency-brake-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <h2 id={titleId}>
          <CircleStop size={20} aria-hidden="true" /> Emergency Brake
        </h2>
        <p id={descriptionId}>
          Stop all Station agents in this network, including running agents, and
          discard their unfinished work. This also cleans up containers left by
          older runs.
        </p>
        <p>
          A network hold prevents new departures. Interrupted Trains need
          intervention before restarting. Accepted work stays in history.
        </p>
        <p className="detail-note">
          Dispatcher, Conductor, integration, repair, and preview containers are
          outside this control.
        </p>
        {busy && (
          <p role="status">
            Stopping Station runs and closing their containers…
          </p>
        )}
        {error && (
          <p className="emergency-brake-error" role="alert">
            {error} A hold may already be in place. Retry to finish cleanup.
          </p>
        )}
        {result && (
          <div role="status">
            <p>
              <strong>Network hold is in place.</strong> Cleaned up{" "}
              {result.cleanedUpRunIds.length} Station{" "}
              {result.cleanedUpRunIds.length === 1 ? "run" : "runs"}.
            </p>
            {result.failures.length > 0 ? (
              <>
                <p className="emergency-brake-error">
                  Some runs still need attention. Try Emergency Brake again.
                </p>
                <ul className="emergency-brake-failures">
                  {result.failures.map((failure, index) => (
                    <li key={`${failure.runId}-${index}`}>
                      <code>{failure.runId}</code>
                      <span>{failure.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                When you’re ready, release the Emergency Brake hold on the
                Network Map, then retry interrupted Stations after intervention.
              </p>
            )}
          </div>
        )}
        <div className="emergency-brake-dialog-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => dialog.current?.close()}
            autoFocus
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {(!result || result.failures.length > 0) && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void stop()}
            >
              {busy && (
                <LoaderCircle
                  size={16}
                  className="animate-spin"
                  aria-hidden="true"
                />
              )}
              {busy
                ? "Stopping…"
                : result || error
                  ? "Retry Emergency Brake"
                  : "Stop Stations & Discard Work"}
            </Button>
          )}
        </div>
      </dialog>
    </div>
  )
}
