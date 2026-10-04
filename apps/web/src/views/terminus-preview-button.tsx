import { ArrowUpRight, LoaderCircle, MonitorPlay } from "lucide-react"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import {
  prepareTerminusPreview,
  useTerminusPreview,
} from "@/state/terminus-previews"

export function TerminusPreviewButton({
  networkId,
  commit,
}: {
  networkId: string
  commit: string
}) {
  const preview = useTerminusPreview(networkId, commit)
  const preparing = preview.status === "preparing"
  return (
    <div className="train-preview">
      {preview.status === "ready" ? (
        <div className="terminus-preview-actions">
          <a
            className={buttonVariants({ size: "sm" })}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Terminus preview <ArrowUpRight size={15} />
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void prepareTerminusPreview(networkId, commit)}
          >
            Refresh preview
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          disabled={preparing}
          onClick={() => void prepareTerminusPreview(networkId, commit)}
        >
          {preparing ? (
            <LoaderCircle className="animate-spin" size={15} />
          ) : (
            <MonitorPlay size={15} />
          )}
          {preparing ? "Preparing preview…" : "Preview Terminus"}
        </Button>
      )}
      <p className="detail-note" role="status">
        {preview.status === "idle" && preview.error
          ? preview.error
          : preparing
            ? "Installing dependencies and building this snapshot. You can close this panel while it prepares."
            : preview.status === "ready"
              ? "Opens this canonical snapshot in a new tab. Refresh the preview if it has expired."
              : "Opens the combined application after successful integration."}
      </p>
    </div>
  )
}
