import type { Station } from "@terminus/protocol"
import type { ReactNode } from "react"
import { CircleCheck, CircleMinus, CircleX } from "lucide-react"

type Manifest = Station["manifest"]
type Checks = { name: string; status: string; required: boolean }[]

/** One row in a Technical details disclosure. Lists render as chips, with
 * paths and symbols set in monospace. */
export type Fact = { label: string; value: string | string[] }

export function List({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return empty ? <p>{empty}</p> : null
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

export function Tags({ items }: { items: string[] }) {
  return (
    <ul className="detail-tags">
      {items.map((item, i) => (
        <li key={i} className={/\s/.test(item) ? undefined : "tag-code"}>
          {item}
        </li>
      ))}
    </ul>
  )
}

const checkIcons = {
  passed: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
} as const

/** Validation results as one compact row: an icon and name per check. */
export function CheckRow({ checks }: { checks: Checks }) {
  if (checks.length === 0) return null
  const failed = checks.filter((c) => c.status === "failed" && c.required)
  const passed = checks.filter((c) => c.status === "passed").length
  const summary = failed.length
    ? `${failed.length} required ${failed.length === 1 ? "check" : "checks"} failed`
    : passed === checks.length
      ? "Checks passed"
      : `${passed} of ${checks.length} checks passed`
  return (
    <div className="check-row">
      <span>{summary}</span>
      <ul>
        {checks.map((check, i) => {
          const Icon =
            checkIcons[check.status as keyof typeof checkIcons] ?? CircleMinus
          return (
            <li key={i} className={`check-${check.status}`}>
              <Icon size={13} aria-hidden="true" />
              {check.name}
              <span className="sr-only">{check.status}</span>
              {!check.required && <em>optional</em>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Renders an agent's plain-text report: paragraphs, "- " bullets, and
 * inline `code` and **bold**. Anything else stays as written. */
export function Prose({ text }: { text: string }) {
  const blocks: { kind: "p" | "ul"; lines: string[] }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    const last = blocks.at(-1)
    if (!line) blocks.push({ kind: "p", lines: [] })
    else if (bullet) {
      if (last?.kind === "ul") last.lines.push(bullet[1] ?? "")
      else blocks.push({ kind: "ul", lines: [bullet[1] ?? ""] })
    } else if (last?.kind === "p") last.lines.push(line)
    else blocks.push({ kind: "p", lines: [line] })
  }
  return (
    <div className="prose">
      {blocks
        .filter((block) => block.lines.length > 0)
        .map((block, i) =>
          block.kind === "ul" ? (
            <ul key={i}>
              {block.lines.map((line, j) => (
                <li key={j}>{inline(line)}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>{inline(block.lines.join(" "))}</p>
          )
        )}
    </div>
  )
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .map((part, i) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    )
}

const changeKinds: Record<
  NonNullable<Manifest["repositoryChange"]>["kind"],
  string
> = {
  implementation: "Implementation",
  tests: "Tests",
  documentation: "Documentation",
  configuration: "Configuration",
  verification: "Verification",
}

/** The human-readable half of a Work Manifest: what changes, when it is done,
 * and what must stay true. Files, contracts and evidence live in
 * {@link manifestFacts} for a Technical details disclosure. */
export function ManifestView({
  manifest,
  name,
}: {
  manifest: Manifest
  name: (id: string) => string
}) {
  const change = manifest.repositoryChange
  const rows: { label: ReactNode; body: ReactNode }[] = []
  if (change)
    rows.push({
      label: (
        <>
          What changes <span>{changeKinds[change.kind]}</span>
        </>
      ),
      body: <p>{change.description}</p>,
    })
  if (manifest.acceptanceCriteria.length)
    rows.push({
      label: "Done when",
      body: <List items={manifest.acceptanceCriteria} />,
    })
  if (manifest.invariants.length)
    rows.push({
      label: "Must stay true",
      body: <List items={manifest.invariants} />,
    })
  if (manifest.scope.length)
    rows.push({ label: "Scope", body: <List items={manifest.scope} /> })
  if (manifest.dependencies.length)
    rows.push({
      label: "Builds on",
      body: <List items={manifest.dependencies.map(name)} />,
    })
  return (
    <dl className="manifest-fields">
      {rows.map((row, i) => (
        <div key={i}>
          <dt>{row.label}</dt>
          <dd>{row.body}</dd>
        </div>
      ))}
    </dl>
  )
}

export function manifestFacts(manifest: Manifest): Fact[] {
  return [
    { label: "Expected areas", value: manifest.expectedAreas },
    { label: "Areas to avoid", value: manifest.avoidAreas },
    {
      label: "Contracts",
      value: manifest.contracts.map(
        (c) => `${c.name} · ${c.kind}, ${c.change.replaceAll("_", " ")}`
      ),
    },
    { label: "Expected evidence", value: manifest.expectedEvidence },
  ]
}

/** Implementation detail kept out of the way: commits, files, contracts.
 * Collapsed by default; agents handle this, people rarely need it. */
export function TechnicalDetails({
  facts,
  summary = "Technical details",
}: {
  facts: Fact[]
  summary?: string
}) {
  const shown = facts.filter((f) =>
    Array.isArray(f.value) ? f.value.length > 0 : f.value
  )
  if (shown.length === 0) return null
  return (
    <details className="tech-details">
      <summary>{summary}</summary>
      <dl>
        {shown.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              {Array.isArray(fact.value) ? (
                <Tags items={fact.value} />
              ) : (
                fact.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/** Commits are long hashes; seven characters identify one for anyone who
 * needs to look it up. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit
}
