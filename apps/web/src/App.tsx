import { useEffect, useState } from "react"
import { TrainFront } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import "./network.css"
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

  if (networkId)
    return (
      <main className="app-shell">
        <NetworkStatus key={networkId} networkId={networkId} />
      </main>
    )

  return (
    <main className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <a href="#/" className="app-brand">
          <span>
            <TrainFront size={17} />
          </span>
          terminus<span className="brand-dot">.</span>
        </a>
        <span className="app-nav-label">Agent railway network</span>
        <ThemeToggle className="theme-button" />
      </nav>
      <div className="network-list-page">
        <header>
          <h1>Networks</h1>
          <p>Each network coordinates concurrent Lines for one project.</p>
        </header>
        <NetworkList />
      </div>
    </main>
  )
}
