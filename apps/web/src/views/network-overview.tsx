import { Prose } from "@terminus/ui/components/prose"
import type { NetworkListing, RepositoryOverview } from "@terminus/protocol"
import { buttonVariants } from "@terminus/ui/components/button"
import { cn } from "@terminus/ui/lib/utils"
import { useEffect, useState } from "react"
import {
  ChevronDown,
  FolderTree,
  CloudUpload,
  GitCommitHorizontal,
  Map as MapIcon,
  RotateCw,
  Scale,
} from "lucide-react"
import { AppNav } from "@/components/app-nav"
import { RepositoryIcon } from "@/components/repository-icon"
import { useNow } from "@/components/use-now"
import { lineColor } from "@/map/layout"
import { api } from "@/state/api"
import { pollWhileVisible } from "@/state/poll-while-visible"
import { routes } from "@/state/route"
import {
  networkRemark,
  relativeTime,
  shortCommit,
  sourceRepository,
} from "./network-presentation"
import {
  detectLicense,
  formatBytes,
  languages,
  readmeSummary,
} from "./repository-contents"
import {
  DocumentNav,
  DocumentView,
  FileMeta,
  FileTree,
  FileView,
  ReaderPath,
} from "./repository-reader"
import { statusWords } from "./describe"
import { TerminusPreviewButton } from "./terminus-preview-button"
import { NetworkActionsMenu } from "./network-actions-menu"

const POLL_MS = 15_000
const FILES_OPEN_KEY = "terminus.overview.files-open"

/** Follows a network's summary so the page notices new merges into Terminus. */
function useNetworkSummary(networkId: string) {
  const [summary, setSummary] = useState<NetworkListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await api.networkSummary(networkId)
        if (cancelled) return
        setSummary(next)
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
  }, [networkId])
  return { summary, error }
}

const overviewCache = new Map<string, Promise<RepositoryOverview>>()

/** Terminus contents at one commit. Reading them may start a Sandbox, so they're shared. */
function useRepositoryOverview(networkId: string, commit: string | undefined) {
  const key = commit ? `${networkId}\0${commit}` : null
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    key: string | null
    overview?: RepositoryOverview
    error?: string
  }>({ key: null })

  useEffect(() => {
    if (!key || !commit) return
    let cancelled = false
    let request = overviewCache.get(key)
    if (!request) {
      request = api.repositoryOverview(networkId, commit)
      overviewCache.set(key, request)
      request.catch(() => overviewCache.delete(key))
    }
    request.then(
      (overview) => !cancelled && setState({ key, overview }),
      (caught) => !cancelled && setState({ key, error: String(caught) })
    )
    return () => {
      cancelled = true
    }
  }, [key, networkId, commit, attempt])

  // Keep showing the previous commit's contents while a newer one loads.
  return {
    overview: state.overview,
    error: state.key === key ? state.error : undefined,
    current: state.key === key,
    retry: () => setAttempt((value) => value + 1),
  }
}

function readFilesOpen(): boolean {
  try {
    return window.localStorage.getItem(FILES_OPEN_KEY) === "true"
  } catch {
    return false
  }
}

/**
 * Where a network begins: its project's documentation, read straight from
 * Terminus, with the files one step behind and the map one click away.
 */
export function NetworkOverview({
  networkId,
  view,
}: {
  networkId: string
  view: { kind: "docs" | "files"; path: string } | null
}) {
  const { summary, error: summaryError } = useNetworkSummary(networkId)
  const repository = useRepositoryOverview(networkId, summary?.terminusCommit)
  const overview = repository.overview
  const [filesOpen, setFilesOpenState] = useState(
    () => view?.kind === "files" || readFilesOpen()
  )
  const [navOpen, setNavOpen] = useState(false)
  const now = useNow(30_000)

  const setFilesOpen = (open: boolean) => {
    setFilesOpenState(open)
    try {
      window.localStorage.setItem(FILES_OPEN_KEY, String(open))
    } catch {
      // Remembering the choice is a convenience.
    }
  }

  // Opening something closes the mobile picker and reveals files when needed.
  const viewKey = view ? `${view.kind}:${view.path}` : ""
  const [shownView, setShownView] = useState(viewKey)
  if (viewKey !== shownView) {
    setShownView(viewKey)
    setNavOpen(false)
    if (view?.kind === "files") setFilesOpenState(true)
  }
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [viewKey])

  if (!summary)
    return (
      <>
        <AppNav
          trail={[
            { label: "Networks", href: routes.networks() },
            { label: "…" },
          ]}
          settingsNetworkId={networkId}
        />
        <div className="overview-page">
          {summaryError ? (
            <div className="reader-state" role="alert">
              <strong>Couldn't load this network</strong>
              <span>{summaryError}</span>
              <a
                className={buttonVariants({ variant: "outline" })}
                href={routes.networks()}
              >
                Back to networks
              </a>
            </div>
          ) : (
            <OverviewSkeleton />
          )}
        </div>
      </>
    )

  const remark = networkRemark(summary.activity)
  const source = sourceRepository(summary.sourceUrl)
  const license = overview ? detectLicense(overview) : null
  const description = overview ? readmeSummary(overview) : null
  const selectedDocument = overview
    ? view
      ? overview.documents.find((document) => document.path === view.path)
      : overview.documents[0]
    : undefined
  const selectedPath = view?.path ?? selectedDocument?.path ?? null
  const openFile =
    overview && view?.kind === "files" && !selectedDocument ? view.path : null

  return (
    <>
      <AppNav
        trail={[
          { label: "Networks", href: routes.networks() },
          { label: summary.name },
        ]}
        settingsNetworkId={networkId}
      />
      <div className="overview-page">
        <header className="overview-header">
          <div className="overview-heading">
            <div className="overview-title">
              <h1>{summary.name}</h1>
              <span className={`remark-pill tone-${remark.tone}`}>
                <i aria-hidden="true" />
                {remark.label}
              </span>
            </div>
            {description && (
              <Prose
                text={description}
                className="overview-description"
                format="plain"
              />
            )}
            <ul className="overview-meta">
              {source ? (
                <li>
                  <a href={source.href} target="_blank" rel="noreferrer">
                    <RepositoryIcon host={source.host} />
                    {source.label}
                  </a>
                </li>
              ) : (
                <li>No upstream repository</li>
              )}
              <li title={summary.terminusCommit}>
                <GitCommitHorizontal size={14} aria-hidden="true" />
                Terminus at <code>{shortCommit(summary.terminusCommit)}</code>
              </li>
              {summary.activity.lastPromotion && (
                <li>
                  Last merge{" "}
                  {relativeTime(summary.activity.lastPromotion.at, now)}
                </li>
              )}
              {summary.publication && (
                <li title={summary.publication.commit}>
                  <CloudUpload size={14} aria-hidden="true" />
                  {summary.publication.siteUrl ? (
                    <a
                      href={summary.publication.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Live at{" "}
                      <code>{shortCommit(summary.publication.commit)}</code>
                    </a>
                  ) : (
                    <>
                      Published{" "}
                      <code>{shortCommit(summary.publication.commit)}</code>
                    </>
                  )}
                </li>
              )}
              {license && (
                <li>
                  <a href={routes.docs(networkId, license.path)}>
                    <Scale size={14} aria-hidden="true" />
                    {license.name}
                  </a>
                </li>
              )}
            </ul>
          </div>
          <div className="overview-actions">
            <TerminusPreviewButton
              networkId={networkId}
              commit={summary.terminusCommit}
              compact
            />
            <a
              className={cn(
                buttonVariants({ size: "lg" }),
                "overview-map-button"
              )}
              href={routes.map(networkId)}
            >
              <MapIcon size={16} />
              Network Map
            </a>
            <NetworkActionsMenu
              networkId={networkId}
              name={summary.name}
              deleting={summary.deleting}
              onDeleted={() => {
                for (const key of overviewCache.keys())
                  if (key.startsWith(`${networkId}\0`))
                    overviewCache.delete(key)
              }}
            />
          </div>
        </header>
        {summary.deleting && (
          <p className="network-deletion-notice" role="status">
            Network deletion is incomplete. New work is disabled. Use Network
            actions → Retry Delete Network to finish cleanup.
          </p>
        )}

        <div className="overview-body">
          <nav
            className={cn("overview-nav", navOpen && "is-open")}
            aria-label="Project documents and files"
          >
            <button
              className="overview-nav-toggle"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(!navOpen)}
            >
              <span>
                {selectedDocument
                  ? selectedDocument.path
                  : (openFile ?? "Documents")}
              </span>
              <ChevronDown size={14} />
            </button>
            <div className="overview-nav-panel">
              {overview ? (
                <>
                  <DocumentNav
                    networkId={networkId}
                    overview={overview}
                    selected={selectedDocument?.path ?? null}
                  />
                  <section className="doc-nav-files">
                    <button
                      className="doc-nav-files-toggle"
                      aria-expanded={filesOpen}
                      onClick={() => setFilesOpen(!filesOpen)}
                    >
                      <FolderTree size={14} />
                      <span>Browse files</span>
                      <small>{overview.files.length}</small>
                      <ChevronDown
                        size={14}
                        className="doc-nav-files-chevron"
                      />
                    </button>
                    {filesOpen && (
                      <FileTree
                        networkId={networkId}
                        overview={overview}
                        selected={selectedPath}
                      />
                    )}
                  </section>
                </>
              ) : (
                <NavSkeleton />
              )}
            </div>
          </nav>

          <main className="overview-reader panel">
            {repository.error && !overview ? (
              <div className="reader-state" role="alert">
                <strong>Couldn't read Terminus</strong>
                <span>{repository.error}</span>
                <button
                  className={buttonVariants({ variant: "outline" })}
                  onClick={repository.retry}
                >
                  <RotateCw size={14} /> Try again
                </button>
              </div>
            ) : !overview ? (
              <div className="reader-state" role="status">
                <span className="reader-spinner" aria-hidden="true" />
                <strong>
                  Reading Terminus at {shortCommit(summary.terminusCommit)}
                </strong>
                <span>
                  Opening the canonical repository; the first read can take a
                  few seconds.
                </span>
              </div>
            ) : selectedDocument ? (
              <>
                <ReaderPath
                  path={selectedDocument.path}
                  meta={
                    <FileMeta
                      overview={overview}
                      path={selectedDocument.path}
                    />
                  }
                />
                <DocumentView
                  key={selectedDocument.path}
                  networkId={networkId}
                  overview={overview}
                  document={selectedDocument}
                />
              </>
            ) : openFile ? (
              <>
                <ReaderPath
                  path={openFile}
                  meta={<FileMeta overview={overview} path={openFile} />}
                />
                <FileView
                  networkId={networkId}
                  commit={overview.commit}
                  path={openFile}
                />
              </>
            ) : view ? (
              <div className="reader-state">
                <strong>Not in this commit</strong>
                <span>
                  <code>{view.path}</code> isn't part of Terminus at{" "}
                  {shortCommit(overview.commit)}.
                </span>
                <a
                  className={buttonVariants({ variant: "outline" })}
                  href={routes.overview(networkId)}
                >
                  Back to the README
                </a>
              </div>
            ) : (
              <div className="reader-state">
                <strong>No documentation yet</strong>
                <span>
                  This project has no README or other docs. Browse its files, or
                  plan a Line that writes them.
                </span>
                <button
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => setFilesOpen(true)}
                >
                  <FolderTree size={14} /> Browse files
                </button>
              </div>
            )}
            {overview && !repository.current && (
              <p className="reader-note" role="status">
                Terminus moved to {shortCommit(summary.terminusCommit)}; loading
                the new contents…
              </p>
            )}
          </main>

          <aside className="overview-rail">
            <NetworkCard networkId={networkId} summary={summary} now={now} />
            {overview && <AboutCard summary={summary} overview={overview} />}
          </aside>
        </div>
      </div>
    </>
  )
}

function NetworkCard({
  networkId,
  summary,
  now,
}: {
  networkId: string
  summary: NetworkListing
  now: number
}) {
  const { activity } = summary
  const remark = networkRemark(activity)
  return (
    <section className="rail-card panel" aria-labelledby="rail-network">
      <div className="rail-card-heading">
        <h2 id="rail-network">Network</h2>
        <a href={routes.map(networkId)}>Open map</a>
      </div>
      <p className={`rail-remark tone-${remark.tone}`}>
        <i
          aria-hidden="true"
          className={remark.tone === "moving" ? "pulse" : undefined}
        />
        <span>
          <strong>{remark.label}</strong>
          {remark.detail}
        </span>
      </p>
      {activity.activeLines.length > 0 && (
        <ul className="rail-lines" aria-label="Lines with a Train running">
          {activity.activeLines.map((line) => (
            <li key={line.number}>
              <i
                style={{ background: lineColor(line.color) }}
                aria-hidden="true"
              />
              <span>{line.name}</span>
              <small>{statusWords(line.status)}</small>
            </li>
          ))}
        </ul>
      )}
      <dl className="rail-stats">
        <div>
          <dt>Lines</dt>
          <dd>{activity.lines}</dd>
        </div>
        <div>
          <dt>Stations accepted</dt>
          <dd>
            {activity.stations.complete}
            <span>/{activity.stations.total}</span>
          </dd>
        </div>
        <div>
          <dt>Cars accepted</dt>
          <dd>{activity.cars}</dd>
        </div>
        <div>
          <dt>Merged to Terminus</dt>
          <dd>{activity.promotions}</dd>
        </div>
      </dl>
      {activity.lastEventAt && (
        <p className="rail-footnote">
          Last activity {relativeTime(activity.lastEventAt, now)}
        </p>
      )}
    </section>
  )
}

const languageColors: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#e0c000",
  CSS: "#7c4dbd",
  HTML: "#e34c26",
  Markdown: "#6e7781",
  Python: "#3572a5",
  Go: "#00add8",
  Rust: "#c46a3a",
  Other: "#a7b0aa",
}

function AboutCard({
  summary,
  overview,
}: {
  summary: NetworkListing
  overview: RepositoryOverview
}) {
  const breakdown = languages(overview.files)
  const size = overview.files.reduce((sum, file) => sum + file.size, 0)
  return (
    <section className="rail-card panel" aria-labelledby="rail-about">
      <div className="rail-card-heading">
        <h2 id="rail-about">Repository</h2>
      </div>
      {breakdown.length > 0 && (
        <div className="rail-languages">
          <div className="rail-language-bar" aria-hidden="true">
            {breakdown.map((language) => (
              <i
                key={language.name}
                style={{
                  width: `${language.share * 100}%`,
                  background:
                    languageColors[language.name] ?? languageColors.Other,
                }}
              />
            ))}
          </div>
          <ul>
            {breakdown.map((language) => (
              <li key={language.name}>
                <i
                  aria-hidden="true"
                  style={{
                    background:
                      languageColors[language.name] ?? languageColors.Other,
                  }}
                />
                {language.name}
                <span>{Math.max(1, Math.round(language.share * 100))}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="rail-facts">
        <div>
          <dt>Files</dt>
          <dd>
            {overview.files.length.toLocaleString()}
            {overview.filesTruncated && "+"} · {formatBytes(size)}
          </dd>
        </div>
        <div>
          <dt>Documents</dt>
          <dd>{overview.documents.length}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {new Date(summary.createdAt).toLocaleDateString([], {
              dateStyle: "medium",
            })}
          </dd>
        </div>
        <div>
          <dt>Artifacts repo</dt>
          <dd>
            <code title={summary.terminusRepoId}>{summary.terminusRepoId}</code>
          </dd>
        </div>
      </dl>
    </section>
  )
}

function NavSkeleton() {
  return (
    <div className="nav-skeleton" aria-hidden="true">
      {[60, 72, 48, 66, 54].map((width, index) => (
        <i key={index} style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div
      className="overview-skeleton"
      aria-busy="true"
      aria-label="Loading network"
    >
      <i />
      <i />
    </div>
  )
}
