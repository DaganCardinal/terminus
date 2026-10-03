import { useEffect, useState } from "react"
import { NetworkList } from "@/views/network-list"
import { NetworkStatus } from "@/views/network-status"

function currentNetworkId(): string | null {
  return /^#\/networks\/([^/]+)$/.exec(window.location.hash)?.[1] ?? null
}

export function App() {
  const [networkId, setNetworkId] = useState(currentNetworkId)

  useEffect(() => {
    const onChange = () => setNetworkId(currentNetworkId())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <nav className="flex items-center gap-3 text-sm">
        <a href="#/" className="font-semibold">
          Terminus
        </a>
        {networkId && <span className="text-muted-foreground">/</span>}
      </nav>
      {networkId ? (
        <NetworkStatus key={networkId} networkId={networkId} />
      ) : (
        <NetworkList />
      )}
    </main>
  )
}
