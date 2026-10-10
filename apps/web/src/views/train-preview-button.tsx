import { ArrowUpRight, LoaderCircle, MonitorPlay, Square } from "lucide-react"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import {
  prepareTrainPreview,
  stopTrainPreview,
  useTrainPreview,
} from "@/state/train-previews"

/** Builds a preview Sandbox on request, then becomes a link to open it. */
export function TrainPreviewButton({
  trainId,
  commit,
}: {
  trainId: string
  commit: string
}) {
  const preview = useTrainPreview(trainId, commit)

  if (preview.status === "ready")
    return (
      <div className="train-preview">
        <div className="terminus-preview-actions">
          <a
            className={buttonVariants({ size: "sm" })}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open preview <ArrowUpRight size={15} />
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void stopTrainPreview(trainId, commit)}
          >
            <Square size={13} />
            Stop preview
          </Button>
        </div>
        <p className="detail-note">
          Ready. Opens accepted Train changes in a new tab. Stops after five
          minutes without requests.
        </p>
      </div>
    )

  const preparing = preview.status === "preparing"
  const stopping = preview.status === "stopping"
  const busy = preparing || stopping
  const error = preview.status === "idle" ? preview.error : undefined
  return (
    <div className="train-preview">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => prepareTrainPreview(trainId, commit)}
      >
        {busy ? (
          <LoaderCircle className="animate-spin" size={15} />
        ) : (
          <MonitorPlay size={15} />
        )}
        {preparing
          ? "Preparing preview…"
          : stopping
            ? "Stopping preview…"
            : "Preview Train"}
      </Button>
      <p className="detail-note" role={error ? "alert" : undefined}>
        {error ??
          (preparing
            ? "Installing dependencies and building the app. This may take a minute."
            : stopping
              ? "Stopping the preview Sandbox."
              : "Builds the accepted Train changes in a Sandbox.")}
      </p>
    </div>
  )
}
