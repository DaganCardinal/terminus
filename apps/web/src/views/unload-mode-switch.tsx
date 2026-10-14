import { Prose } from "@terminus/ui/components/prose"
import { useId } from "react"
import type { UnloadMode, UnloadRecommendation } from "@terminus/protocol"

/** Human approval is the exception to auto-unloading, so it is one switch:
 * on parks the finished Train in the review yard, off unloads it. */
export function UnloadModeSwitch({
  mode,
  recommendation,
  disabled,
  onChange,
}: {
  mode: UnloadMode
  recommendation?: UnloadRecommendation
  disabled: boolean
  onChange: (mode: UnloadMode) => void
}) {
  const id = useId()
  const on = mode === "human_approval"
  return (
    <div className="unload-switch">
      <div className="unload-switch-row">
        <label htmlFor={id}>
          <strong>Require human approval</strong>
          <span>
            {on
              ? "Parks the finished Train in the review yard until you approve."
              : "Unloads automatically once Terminus checks pass."}
          </span>
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          className="switch"
          disabled={disabled}
          onClick={() => onChange(on ? "auto" : "human_approval")}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {recommendation && (
        <Prose
          className="detail-note"
          text={`Dispatcher suggests ${recommendation.mode === "auto" ? "auto-unload" : "human approval"}: ${recommendation.reason}`}
        />
      )}
    </div>
  )
}
