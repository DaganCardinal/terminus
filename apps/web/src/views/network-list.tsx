import type { NetworkSummary } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { useEffect, useState, type FormEvent } from "react"
import { api } from "@/state/api"

export function NetworkList() {
  const [networks, setNetworks] = useState<NetworkSummary[] | null>(null)
  const [name, setName] = useState("")
  const [sourceUrl, setSourceUrl] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .networks()
      .then(setNetworks)
      .catch((caught) => setError(String(caught)))
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    try {
      const network = await api.createNetwork(
        name || "Demo network",
        sourceUrl.trim() || undefined
      )
      window.location.hash = `#/networks/${network.id}`
    } catch (caught) {
      setError(String(caught))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={create} className="flex flex-col gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Network name"
          aria-label="Network name"
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm"
        />
        <input
          type="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="Public HTTPS Git URL (optional)"
          aria-label="Public HTTPS Git URL"
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        />
        <Button type="submit" disabled={creating}>
          {creating ? "Creating…" : "Create network"}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {networks?.length === 0 && (
        <p className="text-sm text-muted-foreground">No networks yet.</p>
      )}
      {networks && networks.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {networks.map((network) => (
            <li key={network.id}>
              <a
                href={`#/networks/${network.id}`}
                className="flex justify-between px-4 py-3 text-sm hover:bg-muted"
              >
                <span className="font-medium">{network.name}</span>
                <span className="text-muted-foreground">
                  {new Date(network.createdAt).toLocaleString()}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
