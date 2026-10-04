import { useId } from "react"
import type { UnloadMode, UnloadRecommendation } from "@terminus/protocol"

export function UnloadModeSelect({
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
  return (
    <div className="unload-control">
      <label htmlFor={id}>Unloading at Terminus</label>
      <select
        id={id}
        value={mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as UnloadMode)}
      >
        <option value="auto">Auto-unload</option>
        <option value="human_approval">Human approval</option>
      </select>
      {recommendation && (
        <p className="detail-note">
          Dispatcher suggests{" "}
          {recommendation.mode === "auto" ? "auto-unload" : "human approval"}:{" "}
          {recommendation.reason}
        </p>
      )}
      <p className="detail-note">
        Human approval parks the completed Train in the review yard. All
        unloading requires integration checks.
      </p>
    </div>
  )
}
