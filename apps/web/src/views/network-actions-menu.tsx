import { useEffect, useId, useRef, useState } from "react"
import {
  CircleStop,
  EllipsisVertical,
  LoaderCircle,
  Trash2,
} from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@terminus/ui/components/dropdown-menu"
import { api } from "@/state/api"
import { routes } from "@/state/route"
import { EmergencyBrakeButton } from "./emergency-brake-button"

export function NetworkActionsMenu({
  networkId,
  name,
  deleting,
  onDeleted,
}: {
  networkId: string
  name: string
  deleting?: boolean
  onDeleted: () => void
}) {
  const [brakeOpen, setBrakeOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    if (deleteOpen) dialog.current?.showModal()
    else dialog.current?.close()
  }, [deleteOpen])

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await api.deleteNetwork(networkId)
      onDeleted()
      window.location.hash = routes.networks()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="network-actions-menu">
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          render={<Button variant="outline" size="icon-lg" />}
          aria-label="Network actions"
          disabled={busy}
        >
          <EllipsisVertical size={18} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          finalFocus={brakeOpen || deleteOpen ? false : undefined}
        >
          <DropdownMenuItem
            className="network-danger-action"
            disabled={deleting}
            onClick={() => setBrakeOpen(true)}
          >
            <CircleStop size={16} aria-hidden="true" /> Emergency Brake
          </DropdownMenuItem>
          <DropdownMenuItem
            className="network-danger-action"
            onClick={() => {
              setError(null)
              setDeleteOpen(true)
            }}
          >
            <Trash2 size={16} aria-hidden="true" />{" "}
            {deleting ? "Retry Delete Network…" : "Delete Network…"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EmergencyBrakeButton
        networkId={networkId}
        compact
        open={brakeOpen}
        onOpenChange={(open) => {
          setBrakeOpen(open)
          if (!open) trigger.current?.focus()
        }}
      />
      <dialog
        ref={dialog}
        className="emergency-brake-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => {
          setDeleteOpen(false)
          trigger.current?.focus()
        }}
        onCancel={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <h2 id={titleId}>
          <Trash2 size={20} aria-hidden="true" /> Delete Network
        </h2>
        <p id={descriptionId}>
          Permanently delete <strong>{name}</strong> and all of its Lines,
          Trains, Stations, Cars, plans, repositories, and history.
        </p>
        <p>
          All running agents, workflows, and containers, including previews,
          will be stopped and deleted. Nothing is archived or saved. This cannot
          be undone.
        </p>
        {busy && (
          <p role="status">Stopping running work and deleting the network…</p>
        )}
        {error && (
          <p className="emergency-brake-error" role="alert">
            {error}
          </p>
        )}
        <div className="emergency-brake-dialog-actions">
          <Button
            variant="outline"
            disabled={busy}
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? (
              <LoaderCircle
                size={16}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Trash2 size={16} aria-hidden="true" />
            )}
            {busy
              ? "Deleting…"
              : error || deleting
                ? "Retry Delete Network"
                : "Permanently Delete Network"}
          </Button>
        </div>
      </dialog>
    </div>
  )
}
