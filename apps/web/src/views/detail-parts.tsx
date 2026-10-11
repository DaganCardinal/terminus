import type { Station } from "@terminus/protocol"
import type { ReactNode } from "react"
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Square,
  TriangleAlert,
} from "lucide-react"

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

export const changeKinds: Record<
  NonNullable<Manifest["repositoryChange"]>["kind"],
  string
> = {
  implementation: "Implementation",
  tests: "Tests",
  documentation: "Documentation",
  configuration: "Configuration",
  verification: "Verification",
}

/** A scope line often names its file first ("src/app.tsx: wire the route").
 * Split that path off so it reads like a cargo line: what, then where. */
export function splitScope(item: string): { path?: string; text: string } {
  const match = /^`?([\w@.~-]*[/.][\w@./~*-]*\w)`?\s*[:—–-]\s+(.+)$/.exec(item)
  return match ? { path: match[1], text: match[2] ?? "" } : { text: item }
}

/** The human-readable half of a Work Manifest, laid out like a shipping
 * manifest: the change up front, hazards marked so they cannot be missed,
 * then the checklist, the cargo, and what it depends on. Contracts and
 * evidence live in {@link manifestFacts} for a Technical details disclosure. */
export function ManifestView({
  manifest,
  name,
  met = false,
}: {
  manifest: Manifest
  name: (id: string) => string
  /** The Conductor accepted this work, so every criterion is met. */
  met?: boolean
}) {
  const change = manifest.repositoryChange
  const MetIcon = met ? CircleCheck : Square
  return (
    <div className="manifest">
      {change && (
        <div className="manifest-change">
          <span className="manifest-kind">{changeKinds[change.kind]}</span>
          <p>{change.description}</p>
        </div>
      )}
      {(manifest.invariants.length > 0 || manifest.avoidAreas.length > 0) && (
        <section className="manifest-block manifest-hazard">
          <h4>
            <TriangleAlert size={13} aria-hidden="true" /> Must stay true
          </h4>
          <List items={manifest.invariants} />
          {manifest.avoidAreas.length > 0 && (
            <div className="manifest-avoid">
              <span>Do not touch</span>
              <Tags items={manifest.avoidAreas} />
            </div>
          )}
        </section>
      )}
      {manifest.acceptanceCriteria.length > 0 && (
        <section className="manifest-block">
          <h4>
            Done when
            <span className="manifest-count">
              {met ? "All met" : manifest.acceptanceCriteria.length}
            </span>
          </h4>
          <ul className={`manifest-checklist${met ? "is-met" : ""}`}>
            {manifest.acceptanceCriteria.map((item, i) => (
              <li key={i}>
                <MetIcon size={14} aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {manifest.scope.length > 0 && (
        <section className="manifest-block">
          <h4>
            Scope
            <span className="manifest-count">{manifest.scope.length}</span>
          </h4>
          <ul className="manifest-cargo">
            {manifest.scope.map((item, i) => {
              const { path, text } = splitScope(item)
              return (
                <li key={i}>
                  {path && <code>{path}</code>}
                  <span>{text}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {manifest.dependencies.length > 0 && (
        <section className="manifest-block">
          <h4>Builds on</h4>
          <ul className="manifest-route">
            {manifest.dependencies.map((id) => (
              <li key={id}>
                <span aria-hidden="true" />
                {name(id)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function manifestFacts(manifest: Manifest): Fact[] {
  return [
    { label: "Expected areas", value: manifest.expectedAreas },
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
