import {
  ArrowUpRight,
  LoaderCircle,
  MonitorPlay,
  RotateCw,
  Square,
} from "lucide-react"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { cn } from "@terminus/ui/lib/utils"
import {
  prepareTerminusPreview,
  stopTerminusPreview,
  useTerminusPreview,
} from "@/state/terminus-previews"

/**
 * Starts a Sandbox preview of the current Terminus commit, then becomes a
 * link to it. Preview state is shared per network and commit, so the map's
 * Terminus panel and the overview page always show the same button state.
 */
export function TerminusPreviewButton({
  networkId,
  commit,
  compact = false,
}: {
  networkId: string
  commit: string
  /** A header-sized button with a short status line instead of a note. */
  compact?: boolean
}) {
  const preview = useTerminusPreview(networkId, commit)
  const preparing = preview.status === "preparing"
  const stopping = preview.status === "stopping"
  const error = preview.status === "idle" ? preview.error : undefined
  const size = compact ? "lg" : "sm"
  const start = () => void prepareTerminusPreview(networkId, commit)
  const stop = () => void stopTerminusPreview(networkId, commit)

  const note =
    error ??
    (preparing
      ? compact
        ? "Building this snapshot; keep reading while it prepares."
        : "Installing dependencies and building this snapshot. You can close this panel while it prepares."
      : stopping
        ? compact
          ? null
          : "Stopping the preview Sandbox."
        : preview.status === "ready"
          ? compact
            ? null
            : "Opens this canonical snapshot in a new tab. It stops after five minutes without requests; refresh it if it has expired."
          : compact
            ? null
            : "Opens the combined application after successful integration.")

  return (
    <div className={compact ? "terminus-preview-compact" : "train-preview"}>
      {preview.status === "ready" ? (
        <div className="terminus-preview-actions">
          <a
            className={cn(
              buttonVariants({
                size,
                variant: compact ? "outline" : "default",
              }),
              compact && "px-4"
            )}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MonitorPlay size={16} />
            View Preview
            <ArrowUpRight size={15} />
          </a>
          {compact ? (
            <>
              <Button
                size="icon-lg"
                variant="ghost"
                aria-label="Refresh preview"
                title="Refresh preview"
                onClick={start}
              >
                <RotateCw size={15} />
              </Button>
              <Button
                size="icon-lg"
                variant="ghost"
                aria-label="Stop preview"
                title="Stop preview"
                onClick={stop}
              >
                <Square size={14} />
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={start}>
                Refresh preview
              </Button>
              <Button size="sm" variant="ghost" onClick={stop}>
                <Square size={13} />
                Stop preview
              </Button>
            </>
          )}
        </div>
      ) : (
        <Button
          size={size}
          variant={compact ? "outline" : "default"}
          className={compact ? "px-4" : undefined}
          disabled={preparing || stopping}
          onClick={start}
        >
          {preparing || stopping ? (
            <LoaderCircle className="animate-spin" size={16} />
          ) : (
            <MonitorPlay size={16} />
          )}
          {preparing
            ? "Starting Preview…"
            : stopping
              ? "Stopping Preview…"
              : "Start Preview"}
        </Button>
      )}
      {note && (
        <p
          className={compact ? "terminus-preview-note" : "detail-note"}
          role={error ? "alert" : "status"}
        >
          {note}
        </p>
      )}
    </div>
  )
}
