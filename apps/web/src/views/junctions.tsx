import { useEffect, useState } from "react"
import type {
  Junction,
  NetworkSnapshot,
  RepositoryOverview,
  RepositoryFile,
} from "@terminus/protocol"
import { Button } from "@terminus/ui/components/button"
import { api } from "@/state/api"
import {
  CheckRow,
  TechnicalDetails,
  shortCommit as baseShortCommit,
} from "./detail-parts"
import { statusWords, trainDisplayStatus } from "./describe"

const shortCommit = (commit: string) =>
  commit.startsWith("fake-")
    ? `fake-…${commit.slice(-14)}`
    : baseShortCommit(commit)
export function JunctionDetails({
  junction: j,
  snapshot,
  run,
  pending,
  onSource,
}: {
  junction: Junction
  snapshot: NetworkSnapshot
  run: (command: () => Promise<unknown>) => Promise<void>
  pending: boolean
  onSource: (lineId: string) => void
}) {
  const [details, setDetails] = useState<Awaited<
      ReturnType<typeof api.junction>
    > | null>(null),
    [error, setError] = useState<string | null>(null),
    [scope, setScope] = useState(""),
    [repository, setRepository] = useState<RepositoryOverview | null>(null),
    [file, setFile] = useState<RepositoryFile | null>(null)
  useEffect(() => {
    let live = true
    api
      .junction(j.id)
      .then((d) => {
        if (live) {
          setDetails(d)
          setError(null)
        }
      })
      .catch((e) => {
        if (live) setError(String(e))
      })
    return () => {
      live = false
    }
  }, [j.id, snapshot.lastSeq])
  const failureId =
    j.state.status === "blocked"
      ? (j.state.integrationId ?? `${j.id}-feature-${j.attempt}`)
      : null
  const approved = snapshot.junctionApprovals?.some(
    (a) => a.junctionId === j.id && a.commit === j.headCommit
  )
  const outgoingStops =
    snapshot.lines.find((l) => l.id === j.outgoingLineId)?.stationIds.length ??
    0
  const seen = new Set<string>()
  const cars = j.inputs
    .flatMap((i) =>
      i.carIds
        .map((id) => (details?.cars ?? snapshot.cars).find((c) => c.id === id))
        .filter((c) => !!c)
    )
    .filter((c) => {
      const id = c.originCarId ?? c.id
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  return (
    <>
      <p className="detail-lead">{j.brief.goal}</p>
      <p>
        {j.state.status === "ready"
          ? "The complete feature is accepted and waiting for your release."
          : `${j.state.status[0]!.toUpperCase()}${j.state.status.slice(1)}`}{" "}
        · {j.inputs.length} of {j.incomingTrainIds.length} inputs accepted
      </p>
      <TechnicalDetails
        facts={[
          { label: "Feature snapshot", value: shortCommit(j.headCommit) },
          {
            label: "Frozen Terminus baseline",
            value: shortCommit(j.terminusBaseline),
          },
        ]}
      />
      <section className="detail-section">
        <h3>Incoming Lines</h3>
        <ul>
          {j.incomingLineIds.map((id, i) => {
            const train = snapshot.trains.find(
              (t) => t.train.id === j.incomingTrainIds[i]
            )?.train
            return (
              <li key={id}>
                <Button variant="ghost" size="sm" onClick={() => onSource(id)}>
                  {snapshot.lines.find((l) => l.id === id)?.name ?? id}
                </Button>{" "}
                ·{" "}
                {j.inputs.some((input) => input.lineId === id)
                  ? "Accepted into Junction"
                  : train
                    ? statusWords(
                        trainDisplayStatus(train.state, snapshot.stations)
                      )
                    : "Waiting"}
              </li>
            )
          })}
        </ul>
      </section>
      <section className="detail-section">
        <h3>Feature acceptance</h3>
        <ul>
          {j.brief.acceptanceCriteria.map((criterion, i) => (
            <li key={i}>{criterion}</li>
          ))}
        </ul>
        <details>
          <summary>Scope, contracts and invariants</summary>
          <ul>
            {[
              ...j.brief.scope,
              ...j.brief.invariants,
              ...j.brief.contracts.map((c) => `${c.name}: ${c.change}`),
            ].map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </details>
        {j.acceptance && (
          <>
            <CheckRow checks={j.acceptance.evidence.checks} />
            <p>{j.acceptance.review.summary}</p>
            <ul>
              {j.acceptance.review.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
            <details>
              <summary>Combined feature diff</summary>
              <pre className="unload-diff">
                {j.acceptance.diff || "No file changes"}
              </pre>
            </details>
          </>
        )}
      </section>
      {j.state.status === "ready" && (
        <Button
          disabled={pending || approved}
          onClick={() =>
            void run(() => api.releaseJunction(j.id, j.headCommit))
          }
        >
          {approved
            ? "Release approved · waiting for gates"
            : "Approve and release feature"}
        </Button>
      )}
      <section className="detail-section">
        <h3>Outgoing Line</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSource(j.outgoingLineId)}
        >
          {snapshot.lines.find((l) => l.id === j.outgoingLineId)?.name ??
            "Delivery Line"}
        </Button>
        <p>
          {outgoingStops || "No additional"}{" "}
          {outgoingStops === 1 ? "Station" : "Stations"} before Terminus.{" "}
          {j.state.status !== "released" &&
            "Its Train is created when you release the feature."}
        </p>
      </section>
      {j.state.status === "blocked" && (
        <section className="detail-section">
          <h3>Needs intervention</h3>
          <ul>
            {j.state.issues.map((i, n) => (
              <li key={n}>{i.detail}</li>
            ))}
          </ul>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => api.retryJunction(j.id))}
          >
            Retry convergence
          </Button>
          <div className="detail-section">
            <label htmlFor={`repair-scope-${j.id}`}>Repair files</label>
            <input
              id={`repair-scope-${j.id}`}
              className="junction-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="src/App.tsx, src/App.test.tsx"
            />
            <p className="detail-note">
              Required for check or review failures. Conflict repairs use the
              recorded conflict files.
            </p>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(() =>
                  api.dispatchJunctionRepair(j.id, {
                    failureId: failureId!,
                    ...(scope.trim()
                      ? {
                          scope: scope
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }
                      : {}),
                  })
                )
              }
            >
              Dispatch Technician
            </Button>
          </div>
        </section>
      )}
      <section className="detail-section">
        <h3>Integration order</h3>
        <ol>
          {j.inputs.map((i) => (
            <li key={i.trainId}>
              {snapshot.lines.find((l) => l.id === i.lineId)?.name} ·{" "}
              {shortCommit(i.mergeCommit)}
            </li>
          ))}
        </ol>
      </section>
      <section className="detail-section">
        <h3>Accepted work</h3>
        <ol>
          {cars.map((c) => (
            <li key={c.id}>
              <details>
                <summary>
                  {snapshot.stations.find((s) => s.id === c.stationId)?.name ??
                    c.manifest.goal}{" "}
                  · {shortCommit(c.acceptedCommit)}
                  {c.originCarId && " · inherited Car"}
                </summary>
                <p>{c.manifest.goal}</p>
                <CheckRow checks={c.evidence.checks} />
                <p>{c.review.summary}</p>
                <ul>
                  {c.review.findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
                <p>Accepted {c.acceptedAt}</p>
                <pre className="unload-diff">
                  {c.diff ?? "No recorded Station diff"}
                </pre>
                <details>
                  <summary>Work manifest</summary>
                  <pre className="unload-diff">
                    {JSON.stringify(c.manifest, null, 2)}
                  </pre>
                </details>
              </details>
            </li>
          ))}
        </ol>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void run(async () =>
              setRepository(await api.junctionRepository(j.id))
            )
          }
        >
          Browse feature repository
        </Button>
        {repository && (
          <ul>
            {repository.files.map((f) => (
              <li key={f.path}>
                <button
                  className="dmsg-link"
                  onClick={() =>
                    void run(async () =>
                      setFile(
                        await api.junctionFile(j.id, repository.commit, f.path)
                      )
                    )
                  }
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        )}
        {file && (
          <details open>
            <summary>{file.path}</summary>
            <pre className="unload-diff">{file.content}</pre>
          </details>
        )}
      </section>
      {details?.attempts.map((a) => (
        <details key={a.input.id}>
          <summary>
            Input integration · {a.status} · {shortCommit(a.input.trainCommit)}
          </summary>
          {a.evidence && <CheckRow checks={a.evidence.checks} />}
          <p>{a.review?.summary}</p>
          <ul>
            {a.review?.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
          <pre className="unload-diff">{a.diff}</pre>
        </details>
      ))}
      {details?.repairs.map((r) => (
        <details key={r.id}>
          <summary>Technician repair · {r.state.status}</summary>
          <p>{r.description}</p>
          <ul>
            {r.scope.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {"proposal" in r.state && (
            <>
              <CheckRow checks={r.state.proposal.evidence.checks} />
              <pre className="unload-diff">{r.state.repairDiff}</pre>
            </>
          )}
          {"review" in r.state && <p>{r.state.review.summary}</p>}
          {r.state.status === "ready" && (
            <Button
              disabled={pending}
              onClick={() =>
                void run(() =>
                  api.approveJunctionRepair(
                    j.id,
                    r.id,
                    "proposal" in r.state ? r.state.proposal.headCommit : ""
                  )
                )
              }
            >
              Approve repair candidate
            </Button>
          )}
        </details>
      ))}
      {!["released", "abandoned"].includes(j.state.status) && (
        <details className="detail-section">
          <summary>Abandon feature</summary>
          <p>
            Unfinished members move to the siding. Accepted work stays
            inspectable.
          </p>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(() =>
                api.abandonJunction(j.id, "Feature abandoned by user")
              )
            }
          >
            Abandon Junction
          </Button>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  )
}
