import type { NetworkListing } from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { LoaderCircle, Plus, RotateCw, Search, X } from "lucide-react"
import logomark from "@/assets/terminus-logomark.svg"
import logomarkWhite from "@/assets/terminus-logomark-white.svg"
import { AppNav } from "@/components/app-nav"
import { RepositoryIcon } from "@/components/repository-icon"
import { useNow } from "@/components/use-now"
import { lineColor } from "@/map/layout"
import { api, ApiRequestError } from "@/state/api"
import { pollWhileVisible } from "@/state/poll-while-visible"
import { routes } from "@/state/route"
import {
  boardTime,
  networkRemark,
  relativeTime,
  shortCommit,
  sourceRepository,
  type NetworkRemark,
} from "./network-presentation"

const POLL_MS = 10_000

type Filter = "all" | "active" | "attention" | "idle"

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "attention", label: "Needs attention" },
  { id: "idle", label: "Idle" },
]

const inFilter = (filter: Filter, tone: NetworkRemark["tone"]) =>
  filter === "all" ||
  (filter === "attention" && tone === "attention") ||
  (filter === "active" && ["moving", "held", "review"].includes(tone)) ||
  (filter === "idle" && ["idle", "new"].includes(tone))

/** When something last happened, which is what the board is ordered by. */
const lastSeen = (network: NetworkListing) =>
  network.activity.lastEventAt ?? network.createdAt

/**
 * The networks list, styled after a station departures board: one row per
 * network, ordered by latest activity, with where it's going and how it's doing.
 */
export function NetworkList() {
  const [networks, setNetworks] = useState<NetworkListing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const now = useNow(30_000)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await api.networks()
        if (cancelled) return
        setNetworks(next)
        setError(null)
      } catch (caught) {
        if (!cancelled) setError(String(caught))
      }
    }
    const stop = pollWhileVisible(load, POLL_MS)
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const rows = useMemo(
    () =>
      (networks ?? [])
        .map((network) => ({
          network,
          remark: networkRemark(network.activity),
          source: sourceRepository(network.sourceUrl),
        }))
        .sort((a, b) => lastSeen(b.network).localeCompare(lastSeen(a.network))),
    [networks]
  )
  const counts = Object.fromEntries(
    filters.map(({ id }) => [
      id,
      rows.filter((row) => inFilter(id, row.remark.tone)).length,
    ])
  ) as Record<Filter, number>
  const needle = query.trim().toLowerCase()
  const visible = rows.filter(
    (row) =>
      inFilter(filter, row.remark.tone) &&
      (!needle ||
        row.network.name.toLowerCase().includes(needle) ||
        row.source?.label.toLowerCase().includes(needle))
  )
  const empty = networks !== null && networks.length === 0

  return (
    <>
      <AppNav stressTest />
      <div className="board-page">
        <header className="board-header">
          <div>
            <h1>Networks</h1>
            <p>
              Every project Terminus manages, latest activity first. Open one to
              read its docs, then ride the map.
            </p>
          </div>
          <BoardClock />
          {!empty && !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} />
              New network
            </Button>
          )}
        </header>

        {creating && !empty && (
          <CreateNetwork onCancel={() => setCreating(false)} />
        )}

        {error && networks !== null && (
          <p className="board-alert" role="status">
            Couldn't refresh the board: {error}. Retrying…
          </p>
        )}

        {networks === null ? (
          error ? (
            <div className="board-message panel" role="alert">
              <strong>Couldn't load networks</strong>
              <span>{error}</span>
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
              >
                <RotateCw size={14} /> Try again
              </Button>
            </div>
          ) : (
            <BoardSkeleton />
          )
        ) : empty ? (
          <FirstNetwork />
        ) : (
          <>
            <div className="board-toolbar">
              <div
                className="board-filters"
                role="tablist"
                aria-label="Filter networks"
              >
                {filters.map(({ id, label }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={filter === id}
                    className={
                      id === "attention" && counts.attention > 0
                        ? "has-attention"
                        : undefined
                    }
                    onClick={() => setFilter(id)}
                  >
                    {label}
                    <span>{counts[id]}</span>
                  </button>
                ))}
              </div>
              <label className="board-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find a network or repository"
                  aria-label="Find a network or repository"
                />
              </label>
            </div>

            <section className="board panel" aria-label="Networks">
              <div className="board-columns" aria-hidden="true">
                <span>Updated</span>
                <span>Network</span>
                <span>Repository</span>
                <span>Last merge</span>
                <span>Status</span>
              </div>
              {visible.length === 0 ? (
                <div className="board-no-results">
                  <strong>No networks match</strong>
                  <span>
                    {needle
                      ? `Nothing ${filter === "all" ? "" : `in “${filters.find((f) => f.id === filter)!.label}” `}matches “${query.trim()}”.`
                      : `No networks are ${filters.find((f) => f.id === filter)!.label.toLowerCase()} right now.`}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setFilter("all")
                      setQuery("")
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              ) : (
                <ol className="board-rows">
                  {visible.map((row) => (
                    <BoardRow key={row.network.id} {...row} now={now} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}

function BoardRow({
  network,
  remark,
  source,
  now,
}: {
  network: NetworkListing
  remark: NetworkRemark
  source: ReturnType<typeof sourceRepository>
  now: number
}) {
  const { activity } = network
  const seen = lastSeen(network)
  const calling = activity.activeLines.slice(0, 3)
  const more = activity.activeLines.length - calling.length

  return (
    <li className={`board-row tone-${remark.tone}`}>
      <div className="board-time">
        <time dateTime={seen}>{boardTime(seen, now)}</time>
        <span>{relativeTime(seen, now)}</span>
      </div>

      <div className="board-network">
        <a className="board-name" href={routes.overview(network.id)}>
          {network.name}
        </a>
        {calling.length > 0 ? (
          <p className="board-calling">
            <span className="board-calling-label">Lines</span>
            {calling.map((line) => (
              <span key={line.number} className="line-chip">
                <i style={{ background: lineColor(line.color) }} />
                {line.name}
              </span>
            ))}
            {more > 0 && <span className="board-more">+{more} more</span>}
          </p>
        ) : (
          <p className="board-sub">
            {activity.lines === 0
              ? "No Lines laid"
              : `${activity.lines} ${activity.lines === 1 ? "Line" : "Lines"} · ${activity.stations.complete}/${activity.stations.total} Stations accepted`}
          </p>
        )}
      </div>

      <div className="board-repo">
        {source ? (
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            title={`Open ${source.label}`}
          >
            <RepositoryIcon host={source.host} />
            <span>{source.label}</span>
          </a>
        ) : (
          <span className="board-repo-none">No upstream repository</span>
        )}
        <span className="board-sub">
          Created{" "}
          {new Date(network.createdAt).toLocaleDateString([], {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>

      <div className="board-merge">
        {activity.lastPromotion ? (
          <>
            <span>{relativeTime(activity.lastPromotion.at, now)}</span>
            <span className="board-sub">
              <code title={activity.lastPromotion.commit}>
                {shortCommit(activity.lastPromotion.commit)}
              </code>
              {activity.promotions > 1 && ` · ${activity.promotions} merges`}
            </span>
          </>
        ) : (
          <span className="board-none">No merges yet</span>
        )}
      </div>

      <div className="board-status">
        <span className="board-remark">
          <i
            aria-hidden="true"
            className={remark.tone === "moving" ? "pulse" : undefined}
          />
          {remark.label}
        </span>
        <span className="board-sub">{remark.detail}</span>
      </div>
    </li>
  )
}

/** A station clock: the board is live, and it says so. */
function BoardClock() {
  const now = useNow(1_000)
  const time = new Date(now)
  const pad = (value: number) => String(value).padStart(2, "0")
  return (
    <div className="board-clock" aria-hidden="true">
      <span>
        {pad(time.getHours())}
        <b>:</b>
        {pad(time.getMinutes())}
      </span>
      <small>{pad(time.getSeconds())}</small>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <section
      className="board panel"
      aria-busy="true"
      aria-label="Loading networks"
    >
      <div className="board-columns" aria-hidden="true">
        <span>Updated</span>
        <span>Network</span>
        <span>Repository</span>
        <span>Last merge</span>
        <span>Status</span>
      </div>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="board-row board-row-skeleton">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      ))}
    </section>
  )
}

/** The first-run board: nothing to filter, one thing to do. */
function FirstNetwork() {
  return (
    <section className="board-empty panel">
      <span className="board-empty-art" aria-hidden="true">
        <img
          className="logomark-light"
          src={logomark}
          alt=""
          width="72"
          height="72"
        />
        <img
          className="logomark-dark"
          src={logomarkWhite}
          alt=""
          width="72"
          height="72"
        />
      </span>
      <h2>Lay your first network</h2>
      <p>
        A network coordinates many agents working on one project at once. Import
        a public Git repository to get started.
      </p>
      <CreateNetwork />
    </section>
  )
}

function CreateNetwork({ onCancel }: { onCancel?: () => void }) {
  const [name, setName] = useState("")
  const [sourceUrl, setSourceUrl] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [existing, setExisting] = useState<string | null>(null)
  const [demoUrl, setDemoUrl] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (onCancel) nameInput.current?.focus()
  }, [onCancel])

  // Live, start from the demo app unless the user has already typed a URL.
  useEffect(() => {
    let cancelled = false
    api.networkDefaults().then(
      ({ sourceUrl: suggested }) => {
        if (cancelled || !suggested) return
        setDemoUrl(suggested)
        setSourceUrl((current) => current || suggested)
      },
      // Only a convenience: the form works the same without it.
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setExisting(null)
    try {
      const network = await api.createNetwork(
        name.trim() || "Demo network",
        sourceUrl.trim() || undefined
      )
      window.location.hash = routes.overview(network.id)
    } catch (caught) {
      // One network per project: point at the network that already owns it.
      setExisting(existingNetworkId(caught))
      setError(caught instanceof Error ? caught.message : String(caught))
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={create}
      className={onCancel ? "create-network panel" : "create-network"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onCancel) onCancel()
      }}
    >
      {onCancel && <h2>New network</h2>}
      <label className="field">
        <span>Name</span>
        <input
          ref={nameInput}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Demo network"
        />
      </label>
      <label className="field">
        <span>Public Git URL</span>
        <input
          type="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://github.com/owner/repo.git"
        />
      </label>
      <div className="create-network-actions">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            <X size={14} /> Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? (
            <LoaderCircle size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          {pending ? "Creating…" : "Create network"}
        </Button>
      </div>
      <p className="create-network-hint">
        Each project gets one network.{" "}
        {demoUrl && sourceUrl === demoUrl
          ? "The Terminus demo app is filled in; clear the URL to start from an empty repository."
          : "Leave the URL blank to start from an empty repository."}{" "}
        Importing can take a minute for larger projects.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
          {existing && (
            <>
              {" "}
              <a href={routes.overview(existing)}>Open it</a>
            </>
          )}
        </p>
      )}
    </form>
  )
}

function existingNetworkId(caught: unknown): string | null {
  if (!(caught instanceof ApiRequestError) || caught.status !== 409) return null
  const details = caught.details
  return typeof details === "object" &&
    details !== null &&
    "networkId" in details &&
    typeof details.networkId === "string"
    ? details.networkId
    : null
}
