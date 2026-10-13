import "./network.css"
import "./pages.css"
import { NetworkList } from "@/views/network-list"
import { NetworkOverview } from "@/views/network-overview"
import { NetworkStatus } from "@/views/network-status"
import { useRoute } from "@/state/route"

export function App() {
  const route = useRoute()

  return (
    <main className="app-shell">
      {route.page === "map" ? (
        <NetworkStatus key={route.networkId} networkId={route.networkId} />
      ) : route.page === "overview" ? (
        <NetworkOverview
          key={route.networkId}
          networkId={route.networkId}
          view={route.view}
        />
      ) : (
        <NetworkList />
      )}
    </main>
  )
}
