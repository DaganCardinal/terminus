import { useEffect, useState } from "react"
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Play,
  XCircle,
} from "lucide-react"
import {
  stressReportPending,
  type NetworkSnapshot,
  type StressLaunch,
  type StressReport,
} from "@terminus/protocol"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { AppNav } from "@/components/app-nav"
import { api } from "@/state/api"
import { routes } from "@/state/route"
import { pollWhileVisible } from "@/state/poll-while-visible"

const pendingKey = "terminus.stress.pending-launch"
function launchIdentity() {
  try {
    const saved = sessionStorage.getItem(pendingKey)
    if (saved) return saved
    const id = crypto.randomUUID()
    sessionStorage.setItem(pendingKey, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
}
function download(report: StressReport) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = `terminus-stress-${report.run.runId}.json`
  link.click()
  URL.revokeObjectURL(url)
}

/** Read-only progress; the backend command and Train Workflows own execution. */
export function StressTestPage({ networkId }: { networkId?: string }) {
  const [requestId] = useState(launchIdentity)
  const [mode, setMode] = useState<"artifacts" | "fake" | null>(null)
  const [run, setRun] = useState<StressLaunch | null>(null)
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null)
  const [resources, setResources] = useState<Awaited<
    ReturnType<typeof api.stressStatus>
  > | null>(null)
  const [busy, setBusy] = useState<"launch" | "verify" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<StressReport | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        if (!networkId) {
          const next = await api.stressCapabilities()
          if (!cancelled) setMode(next.repositoryMode)
        } else {
          const [next, state, status] = await Promise.all([
            api.stressRun(networkId),
            api.snapshot(networkId),
            api.stressStatus(networkId),
          ])
          if (!cancelled) {
            setRun(next)
            setMode(next.mode)
            setSnapshot(state)
            setResources(status)
          }
        }
      } catch (caught) {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
    const stop = pollWhileVisible(load, 3000)
    return () => {
      cancelled = true
      stop()
    }
  }, [networkId])

  async function start() {
    setBusy("launch")
    setError(null)
    try {
      const next = await api.launchStressTest(requestId)
      try {
        sessionStorage.removeItem(pendingKey)
      } catch {
        /* Optional retry identity. */
      }
      window.location.hash = routes.stressTest(next.networkId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  async function verify() {
    if (!networkId) return
    setBusy("verify")
    setError(null)
    try {
      const next = await api.stressReport(networkId)
      setReport(next)
      download(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const unloaded =
    snapshot?.trains.filter(({ train }) => train.state.status === "unloaded")
      .length ?? 0
  const blocked =
    snapshot?.trains.filter(
      ({ train }) =>
        train.state.status === "blocked" || train.state.status === "siding"
    ).length ?? 0
  const queued =
    snapshot?.trains.filter(
      ({ train }) =>
        train.state.status === "returning" &&
        train.state.phase === "awaiting_clearance"
    ).length ?? 0
  // The same rule the report command applies; a failed run still gets a report.
  const pending =
    snapshot && resources
      ? stressReportPending(snapshot, resources)
      : "Loading progress"
  const canVerify = !pending
  return (
    <>
      <AppNav
        trail={[
          { label: "Networks", href: routes.networks() },
          { label: "Stress test" },
        ]}
      />
      <div className="overview-page">
        <section
          className="rail-card panel mx-auto max-w-3xl space-y-5 p-6"
          aria-labelledby="stress-title"
        >
          <div className="space-y-2">
            <h1 id="stress-title" className="text-xl font-semibold">
              Ten-Train stress test
            </h1>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              Run ten concurrent Trains through Station work, independent
              review, and integration into Terminus. A separate fixture Network
              keeps the test easy to inspect and repeat.
            </p>
            {mode && (
              <p className="text-sm font-medium">
                {mode === "artifacts"
                  ? "Cloudflare pipeline verification"
                  : "Local rehearsal"}
              </p>
            )}
            {mode === "fake" && (
              <p className="max-w-prose text-sm text-muted-foreground">
                This local run uses simulated repositories and agents.
                Cloudflare execution and the final Git tree are verified in an
                app configured with Artifacts.
              </p>
            )}
          </div>
          {!networkId ? (
            <div className="space-y-3">
              <p className="max-w-prose text-sm">
                The test creates its own project, validation commands, Lines,
                and scripted agents. Results stay available in Networks.
              </p>
              <Button onClick={start} disabled={!!busy || !mode}>
                {busy === "launch" ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <Play size={16} />
                )}
                {busy === "launch"
                  ? "Preparing the test…"
                  : "Run ten-Train stress test"}
              </Button>
            </div>
          ) : (
            <>
              <div
                className="flex flex-wrap gap-6"
                role="status"
                aria-live="polite"
              >
                <p>
                  <strong className="text-xl tabular-nums">
                    {unloaded}/10
                  </strong>
                  <span className="block text-sm text-muted-foreground">
                    Trains unloaded
                  </span>
                </p>
                <p>
                  <strong className="text-xl tabular-nums">{queued}</strong>
                  <span className="block text-sm text-muted-foreground">
                    Waiting to integrate
                  </span>
                </p>
                <p>
                  <strong className="text-xl tabular-nums">
                    {resources?.leases ?? "…"}
                  </strong>
                  <span className="block text-sm text-muted-foreground">
                    Active Sandbox leases
                  </span>
                </p>
              </div>
              {blocked > 0 && (
                <p role="status">
                  {blocked} Train{blocked === 1 ? " needs" : "s need"}{" "}
                  attention. Open the map to inspect the failure, or verify once
                  every Train has stopped to download a failure report.
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <a
                  href={routes.map(networkId)}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Watch the map
                </a>
                <Button onClick={verify} disabled={!!busy || !canVerify}>
                  {busy === "verify" ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}
                  {busy === "verify"
                    ? "Verifying the result…"
                    : "Verify and download report"}
                </Button>
              </div>
              <p className="max-w-prose text-sm text-muted-foreground">
                {pending && !report ? `${pending}. ` : ""}
                Execution continues if you close this page. Come back when every
                Train has stopped to verify the result and download the timing
                report.
              </p>
            </>
          )}
          {report && (
            <div className="space-y-2" role="status">
              <p className="flex items-center gap-2 font-medium">
                {report.passed ? (
                  <CheckCircle2 size={18} />
                ) : (
                  <XCircle size={18} />
                )}
                {report.passed
                  ? report.mode === "artifacts"
                    ? "Full verification passed"
                    : "Local rehearsal passed"
                  : "Verification failed"}
              </p>
              {report.passed ? (
                <p className="text-sm text-muted-foreground">
                  {report.verification
                    ? "Twenty files, ten accepted Car commits, ten canonical merges, and resource cleanup verified."
                    : "Ten simulated Trains completed. Cloudflare and final Git verification are not included in this rehearsal."}
                </p>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {report.findings.map((finding, index) => (
                    <li key={index}>{finding}</li>
                  ))}
                </ul>
              )}
              {report.warnings.map((warning) => (
                <p key={warning} className="text-sm text-muted-foreground">
                  {warning}
                </p>
              ))}
              <p className="text-sm">
                Peak integration queue: {report.timings.maxQueueDepth} · Queue
                drained in{" "}
                {report.timings.drainMs === null
                  ? "unknown"
                  : `${(report.timings.drainMs / 1000).toFixed(1)} seconds`}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => download(report)}
              >
                Download report again
              </Button>
              <a className="ml-3 text-sm underline" href={routes.stressTest()}>
                Start another test
              </a>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {run && (
            <p className="text-xs text-muted-foreground">Run {run.runId}</p>
          )}
        </section>
      </div>
    </>
  )
}
