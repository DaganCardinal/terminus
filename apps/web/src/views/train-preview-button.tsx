import { ArrowUpRight, LoaderCircle, MonitorPlay } from "lucide-react"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { prepareTrainPreview, useTrainPreview } from "@/state/train-previews"

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
        <a
          className={buttonVariants({ size: "sm" })}
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open preview <ArrowUpRight size={15} />
        </a>
        <p className="detail-note">
          Ready. Opens accepted Train changes in a new tab.
        </p>
      </div>
    )

  const preparing = preview.status === "preparing"
  const error = preview.status === "idle" ? preview.error : undefined
  return (
    <div className="train-preview">
      <Button
        size="sm"
        variant="outline"
        disabled={preparing}
        onClick={() => prepareTrainPreview(trainId, commit)}
      >
        {preparing ? (
          <LoaderCircle className="animate-spin" size={15} />
        ) : (
          <MonitorPlay size={15} />
        )}
        {preparing ? "Preparing preview…" : "Preview Train"}
      </Button>
      <p className="detail-note" role={error ? "alert" : undefined}>
        {error ??
          (preparing
            ? "Installing dependencies and building the app. This may take a minute."
            : "Builds the accepted Train changes in a Sandbox.")}
      </p>
    </div>
  )
}
