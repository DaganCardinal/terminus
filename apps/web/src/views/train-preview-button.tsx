import { useState } from "react"
import { ArrowUpRight, LoaderCircle } from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"

export function TrainPreviewButton({ trainId }: { trainId: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function preview() {
    setError(null)
    // Open during the click so async Sandbox startup does not trigger a popup blocker.
    const tab = window.open("about:blank", "_blank")
    if (!tab) {
      setError("Allow pop-ups for Terminus to open the Train preview.")
      return
    }
    tab.opener = null
    tab.document.title = "Preparing Train preview"
    const message = tab.document.createElement("p")
    message.textContent =
      "Preparing your Train preview. Installing dependencies and building the app may take a minute."
    tab.document.body.append(message)
    setPending(true)
    try {
      const result = await api.previewTrain(trainId)
      if (!tab.closed) tab.location.replace(result.url)
    } catch (caught) {
      const detail =
        caught instanceof Error
          ? caught.message
          : "Could not start the Train preview."
      setError(detail)
      if (!tab.closed) {
        tab.document.title = "Train preview failed"
        message.textContent = `${detail} Return to Terminus to try again.`
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div>
      <Button size="sm" variant="outline" disabled={pending} onClick={preview}>
        {pending ? (
          <LoaderCircle className="animate-spin" size={15} />
        ) : (
          <ArrowUpRight size={15} />
        )}
        {pending ? "Preparing preview…" : "Preview Train"}
      </Button>
      <p className="detail-note" role={error ? "alert" : undefined}>
        {error ?? "Opens accepted Train changes in a new tab."}
      </p>
    </div>
  )
}
