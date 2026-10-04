import type { NetworkSummary } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { useEffect, useState, type FormEvent } from "react"
import { Plus } from "lucide-react"
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
    <>
      <form onSubmit={create} className="create-network panel">
        <h2>New network</h2>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Demo network"
          />
        </label>
        <label className="field">
          <span>Public Git URL (optional)</span>
          <input
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://github.com/owner/repo.git"
          />
        </label>
        <Button type="submit" disabled={creating}>
          <Plus size={16} />
          {creating ? "Creating…" : "Create network"}
        </Button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <section className="network-index panel" aria-label="Networks">
        <div className="panel-heading">
          <h2>Networks</h2>
          {networks && networks.length > 0 && <span>{networks.length}</span>}
        </div>
        {networks === null && !error && (
          <p className="network-index-empty">Loading networks…</p>
        )}
        {networks?.length === 0 && (
          <p className="network-index-empty">
            <strong>No networks yet</strong>
            Create one above to start planning Lines toward Terminus.
          </p>
        )}
        {networks && networks.length > 0 && (
          <ul>
            {networks.map((network) => (
              <li key={network.id}>
                <a href={`#/networks/${network.id}`}>
                  <span>{network.name}</span>
                  <time dateTime={network.createdAt}>
                    {new Date(network.createdAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
