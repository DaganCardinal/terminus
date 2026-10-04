import { useEffect, useState } from "react"
import { Moon, Sun, TrainFront } from "lucide-react"
import { useTheme } from "@/components/theme-provider"
import "./network.css"
import { NetworkList } from "@/views/network-list"
import { NetworkStatus } from "@/views/network-status"

function currentNetworkId(): string | null {
  return /^#\/networks\/([^/]+)$/.exec(window.location.hash)?.[1] ?? null
}

export function App() {
  const [networkId, setNetworkId] = useState(currentNetworkId)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    const onChange = () => setNetworkId(currentNetworkId())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])

  return (
    <main className="app-shell">
      <nav className="app-nav" aria-label="Main navigation">
        <a href="#/" className="app-brand">
          <span>
            <TrainFront size={20} />
          </span>
          terminus<span className="brand-dot">.</span>
        </a>
        <span className="app-nav-label">Agent railway network</span>
        <button
          className="theme-button"
          aria-label="Toggle color theme"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </nav>
      {networkId ? (
        <NetworkStatus key={networkId} networkId={networkId} />
      ) : (
        <div className="network-list-page">
          <h1>Your networks</h1>
          <p>Coordinate independent workstreams, from depot to Terminus.</p>
          <NetworkList />
        </div>
      )}
    </main>
  )
}
