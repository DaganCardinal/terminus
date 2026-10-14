import {
  assessPlan,
  type BaselineReport,
  type DispatchProposal,
  type PlannedLine,
  type PlanningContext,
  type WorkManifest,
} from "@terminus/domain"
import {
  dispatchProposalSchema,
  lineSharedFields,
  planLimits,
  planOutlineSchema,
  planStationSchema,
  type PlanDraft,
  type PlanOutline,
  type PlanStation,
} from "@terminus/protocol"
import { z } from "zod"
import {
  validationIssues,
  type DispatchValidationIssue,
} from "./dispatch-proposal"
import { finalMessageJson, jsonParseHint, planToolServer } from "./opencode"

/**
 * The Dispatcher builds its plan piece by piece: one outline (the network
 * layout) and one call per Station. Terminus keeps the pieces between calls
 * and assembles the proposal in code, so a slip costs one piece, never the
 * whole plan. Every function here is pure; the caller stores the draft.
 */
export const planToolNames = {
  outline: "set_plan_outline",
  station: "put_station",
  inspect: "inspect_plan",
  finalize: "finalize_plan",
} as const
type PlanToolName = (typeof planToolNames)[keyof typeof planToolNames]

/** How OpenCode names a plan tool to the agent. */
export function planToolAgentName(name: PlanToolName): string {
  return `${planToolServer.name}_${name}`
}

/** How `finalize_plan`'s reply begins when Terminus accepts the plan. */
export const planAcceptedReply = "Accepted:"
/** How a reply begins when the outline or Station was not saved. */
export const notSavedReply = "Not saved:"
/**
 * After this many outline or Station calls that were not saved, including
 * calls the harness could not parse, the live runner stops the Dispatcher
 * and the saved draft is final. Each costs one piece, not the whole plan.
 */
export const maxRejectedPlanCalls = 20
/** After this many rejected `finalize_plan` calls, the draft is final. */
export const maxRejectedFinalizations = 3

const call = {
  outline: `\`${planToolAgentName(planToolNames.outline)}\``,
  station: `\`${planToolAgentName(planToolNames.station)}\``,
  inspect: `\`${planToolAgentName(planToolNames.inspect)}\``,
  finalize: `\`${planToolAgentName(planToolNames.finalize)}\``,
}

export const emptyPlanDraft: PlanDraft = { stations: {} }

/** What plan checks run against: the same inputs the Workflow uses. */
export interface PlanCheckContext {
  network: PlanningContext
  baseline: BaselineReport | null
}

type OutlineLine = PlanOutline["lines"][number]
type SharedValues = Partial<Record<(typeof lineSharedFields)[number], string[]>>

/**
 * A Station's shared-field values with its Line's values ahead of them, each
 * kept once. `projectFacts` is left out when neither has any.
 */
export function mergeLineShared(
  shared: SharedValues | undefined,
  own: SharedValues
): SharedValues {
  const merged: SharedValues = {}
  for (const field of lineSharedFields) {
    const values = [...(shared?.[field] ?? []), ...(own[field] ?? [])]
    if (values.length || field !== "projectFacts")
      merged[field] = [...new Set(values)]
  }
  return merged
}

function stationManifest(
  station: PlanStation,
  shared: OutlineLine["shared"]
): WorkManifest {
  const merged = mergeLineShared(shared, station)
  return {
    goal: station.goal,
    repositoryChange: {
      kind: station.changeKind,
      description: station.changeDescription,
    },
    scope: station.scope,
    expectedAreas: station.expectedAreas,
    avoidAreas: merged.avoidAreas ?? [],
    contracts: station.contracts ?? [],
    invariants: merged.invariants ?? [],
    dependencies: station.dependencies ?? [],
    acceptanceCriteria: station.acceptanceCriteria,
    expectedEvidence: merged.expectedEvidence ?? [],
    ...(merged.projectFacts ? { projectFacts: merged.projectFacts } : {}),
  }
}

/** Stands in for a Station that is not saved yet, so the rest of the plan
 * can still be checked. Problems it causes are never reported. */
function placeholderManifest(): WorkManifest {
  return {
    goal: "Not saved",
    scope: [],
    expectedAreas: [],
    avoidAreas: [],
    contracts: [],
    invariants: [],
    dependencies: [],
    acceptanceCriteria: [],
    expectedEvidence: [],
  }
}

function savedStation(
  stations: PlanDraft["stations"],
  key: string
): PlanStation | undefined {
  return Object.hasOwn(stations, key) ? stations[key] : undefined
}

interface Assembly {
  proposal: DispatchProposal
  /** Outline Station keys with no saved Station, in outline order. */
  missing: string[]
  /** Saved Stations' merged Manifests, in outline order. */
  manifests: { key: string; manifest: WorkManifest }[]
  /** Where each Line and Station sits in the proposal, to name it in schema problems. */
  paths: { path: string; owner: string }[]
  /** Each Station's assessment label ("Line / Station"). */
  labels: { label: string; key: string; placeholder: boolean }[]
}

/**
 * Builds the proposal from an outline and saved Stations. Junction and
 * baseline-fix Lines move to their places, Line-shared values merge into
 * every Station, and unsaved Stations get placeholders.
 */
function assemble(
  outline: PlanOutline,
  saved: PlanDraft["stations"]
): Assembly {
  const assembly: Omit<Assembly, "proposal"> = {
    missing: [],
    manifests: [],
    paths: [],
    labels: [],
  }
  const byKey = new Map(outline.lines.map((line) => [line.key, line]))
  const placed = new Set([
    ...(outline.junctions ?? []).flatMap((j) => [...j.incoming, j.outgoing]),
    ...(outline.baselineFix ? [outline.baselineFix.line] : []),
  ])
  const stations = (
    line: OutlineLine,
    path: string
  ): PlannedLine["stations"] => {
    assembly.paths.push({ path, owner: `Line \`${line.key}\`` })
    return line.stations.map((key, index) => {
      const station = savedStation(saved, key)
      const name = station?.name ?? `${key} (not saved)`
      assembly.paths.push({
        path: `${path}.stations.${index}`,
        owner: `Station \`${key}\``,
      })
      assembly.labels.push({
        label: `${line.name} / ${name}`,
        key,
        placeholder: !station,
      })
      if (!station) {
        assembly.missing.push(key)
        return { key, name, manifest: placeholderManifest() }
      }
      const manifest = stationManifest(station, line.shared)
      assembly.manifests.push({ key, manifest })
      return { key, name, manifest }
    })
  }
  const route = (line: OutlineLine) => (line.route ? { route: line.route } : {})
  const recommendation = (line: OutlineLine) =>
    line.unloadRecommendation
      ? { unloadRecommendation: line.unloadRecommendation }
      : {}

  const lines = outline.lines
    .filter((line) => !placed.has(line.key))
    .map((line, index) => ({
      key: line.key,
      name: line.name,
      ...recommendation(line),
      ...route(line),
      stations: stations(line, `lines.${index}`),
    }))
  const junctions = (outline.junctions ?? []).map((junction, index) => {
    const path = `junctions.${index}`
    const outgoing = byKey.get(junction.outgoing)
    return {
      key: junction.key,
      name: junction.name,
      brief: junction.brief,
      incoming: junction.incoming
        .flatMap((key) => byKey.get(key) ?? [])
        .map((line, i) => ({
          name: line.name,
          ...route(line),
          stations: stations(line, `${path}.incoming.${i}`),
        })),
      outgoing: outgoing
        ? {
            name: outgoing.name,
            ...route(outgoing),
            ...(outgoing.unloadRecommendation
              ? { unloadMode: outgoing.unloadRecommendation.mode }
              : {}),
            stations: stations(outgoing, `${path}.outgoing`),
          }
        : { name: junction.name, stations: [] },
    }
  })
  const fix = outline.baselineFix
  const fixLine = fix && byKey.get(fix.line)
  return {
    ...assembly,
    proposal: {
      summary: outline.summary,
      lines,
      ...(junctions.length ? { junctions } : {}),
      ...(outline.findings?.length ? { findings: outline.findings } : {}),
      ...(fix && fixLine
        ? {
            baselineFix: {
              reason: fix.reason,
              line: {
                key: fixLine.key,
                name: fixLine.name,
                ...recommendation(fixLine),
                stations: stations(fixLine, "baselineFix.line"),
              },
            },
          }
        : {}),
    },
  }
}

/** Where a Line sits in the plan, in words. */
function placements(outline: PlanOutline): Map<string, string> {
  const placement = new Map<string, string>()
  for (const junction of outline.junctions ?? []) {
    for (const key of junction.incoming)
      placement.set(key, `incoming to Junction \`${junction.key}\``)
    placement.set(
      junction.outgoing,
      `outgoing from Junction \`${junction.key}\``
    )
  }
  if (outline.baselineFix)
    placement.set(outline.baselineFix.line, "the baseline fix")
  return placement
}

/**
 * Checks the outline's own structure: keys, where each Line sits, and the
 * plan's size limits. These need no Station Manifests.
 */
function layoutProblems(outline: PlanOutline): string[] {
  const problems: string[] = []
  const lines = new Map<string, OutlineLine>()
  for (const line of outline.lines) {
    if (lines.has(line.key))
      problems.push(`Line key \`${line.key}\` is used more than once.`)
    lines.set(line.key, line)
  }
  const owners = new Map<string, string>()
  for (const line of outline.lines)
    for (const key of line.stations) {
      const owner = owners.get(key)
      if (owner === undefined) owners.set(key, line.key)
      else
        problems.push(
          owner === line.key
            ? `Station \`${key}\` is listed twice on Line \`${line.key}\`.`
            : `Station \`${key}\` is listed on Line \`${owner}\` and Line \`${line.key}\`; a Station belongs to one Line.`
        )
    }
  if (owners.size > planLimits.stations)
    problems.push(
      `The plan has ${owners.size} Stations; the most is ${planLimits.stations}.`
    )

  const placed = new Map<string, string>()
  const place = (key: string, role: string, by: string) => {
    if (!lines.has(key))
      problems.push(`${by} names Line \`${key}\`, which is not in \`lines\`.`)
    else if (placed.has(key))
      problems.push(
        `Line \`${key}\` is placed twice: ${placed.get(key)} and ${role}.`
      )
    else placed.set(key, role)
  }
  const junctionKeys = new Set<string>()
  for (const junction of outline.junctions ?? []) {
    if (junctionKeys.has(junction.key))
      problems.push(`Junction key \`${junction.key}\` is used more than once.`)
    junctionKeys.add(junction.key)
    const by = `Junction \`${junction.key}\``
    for (const key of junction.incoming) place(key, `incoming to ${by}`, by)
    place(junction.outgoing, `outgoing from ${by}`, by)
    for (const key of junction.incoming)
      if (lines.get(key)?.stations.length === 0)
        problems.push(
          `Line \`${key}\` is incoming to ${by} and needs at least one Station.`
        )
  }
  const fix = outline.baselineFix
  if (fix) {
    place(fix.line, "the baseline fix", "`baselineFix.line`")
    const line = lines.get(fix.line)
    if (line && line.stations.length !== 1)
      problems.push(
        `The baseline fix Line \`${fix.line}\` needs exactly one Station.`
      )
    if (line?.route)
      problems.push(
        `The baseline fix Line \`${fix.line}\` cannot have a route; Terminus routes the other Lines through it.`
      )
    if (line && !line.unloadRecommendation)
      problems.push(`Line \`${fix.line}\` needs an \`unloadRecommendation\`.`)
  }

  const topLevel = [...lines.values()].filter((line) => !placed.has(line.key))
  if (!topLevel.length && !outline.junctions?.length)
    problems.push("The plan needs at least one top-level Line or Junction.")
  if (topLevel.length > planLimits.lines)
    problems.push(
      `The plan has ${topLevel.length} top-level Lines; the most is ${planLimits.lines}. Junction and baseline-fix Lines do not count.`
    )
  for (const line of topLevel) {
    if (!line.stations.length)
      problems.push(`Line \`${line.key}\` needs at least one Station.`)
    if (line.stations.length > planLimits.stationsPerLine)
      problems.push(
        `Line \`${line.key}\` has ${line.stations.length} Stations; a top-level Line has at most ${planLimits.stationsPerLine}.`
      )
    if (!line.unloadRecommendation)
      problems.push(`Line \`${line.key}\` needs an \`unloadRecommendation\`.`)
  }
  return problems
}

interface Attributed {
  /** Problems with the plan as a whole, or with Lines. */
  general: string[]
  /** Problems with saved Stations, by key. */
  stations: Map<string, string[]>
}

/** Assessment errors start with "Line / Station:" when they concern one
 * Station. Errors about placeholders are dropped. */
function attribute(errors: string[], labels: Assembly["labels"]): Attributed {
  const result: Attributed = { general: [], stations: new Map() }
  for (const error of errors) {
    const owners = labels.filter(({ label }) => error.startsWith(`${label}: `))
    if (!owners.length) result.general.push(error)
    for (const { key, placeholder } of owners)
      if (!placeholder) addProblem(result.stations, key, error)
  }
  return result
}

function addProblem(
  problems: Map<string, string[]>,
  key: string,
  problem: string
): void {
  problems.set(key, [...(problems.get(key) ?? []), problem])
}

/**
 * Checks the outline as a whole: its structure first, then the launch rules
 * that need only the layout (routes, Crossings, Junctions, baseline fix),
 * with every Station as a placeholder.
 */
function outlineProblems(
  outline: PlanOutline,
  context: PlanCheckContext
): string[] {
  const layout = layoutProblems(outline)
  if (layout.length) return layout
  const assembly = assemble(outline, {})
  return attribute(assess(assembly.proposal, context), assembly.labels).general
}

function assess(
  proposal: DispatchProposal,
  context: PlanCheckContext
): string[] {
  return assessPlan(proposal, context.network, context.baseline ?? undefined)
    .errors
}

const plannedManifestSchema =
  dispatchProposalSchema.shape.lines.element.shape.stations.element.shape
    .manifest

/** A saved Station checked with its Line's shared values merged in. */
function manifestProblems(manifest: WorkManifest): string[] {
  const result = plannedManifestSchema.safeParse(manifest)
  if (result.success) return []
  return result.error.issues.map((issue) => {
    const field = String(issue.path[0] ?? "")
    if (
      issue.code === "too_small" &&
      issue.path.length === 1 &&
      (field === "invariants" || field === "expectedEvidence")
    )
      return `\`${field}\` is empty, and the Line's \`shared.${field}\` has none either. Give the Station at least one, or add one to the Line's shared values.`
    return `${issue.path.join(".") || "(the Station)"}: ${issue.message}`
  })
}

/** Every problem Terminus can find in the draft so far. Unsaved Stations
 * are reported separately, as progress, not as problems. */
function checkDraft(draft: PlanDraft, context: PlanCheckContext): Attributed {
  if (!draft.outline) return { general: [], stations: new Map() }
  const assembly = assemble(draft.outline, draft.stations)
  const assessed = attribute(
    assess(assembly.proposal, context),
    assembly.labels
  )
  const stations = new Map<string, string[]>()
  for (const { key, manifest } of assembly.manifests)
    for (const problem of [
      ...manifestProblems(manifest),
      ...(assessed.stations.get(key) ?? []),
    ])
      addProblem(stations, key, problem)
  return { general: assessed.general, stations }
}

function problemList(check: Attributed): string[] {
  return [
    ...check.general,
    ...[...check.stations].flatMap(([key, problems]) =>
      problems.map((problem) => `Station \`${key}\`: ${problem}`)
    ),
  ]
}

export type PlanDraftReview =
  | { kind: "valid"; proposal: DispatchProposal }
  | {
      kind: "schema"
      /** Safe field paths and codes, for diagnostics. */
      issues: DispatchValidationIssue[]
      /** For the model only; they may quote model output. */
      problems: string[]
    }
  | {
      kind: "assessment"
      proposal: DispatchProposal
      errors: string[]
      /** The errors, naming the Station each concerns. */
      problems: string[]
    }

/**
 * Assembles the draft and checks the result exactly as a submitted proposal
 * is checked: the proposal schema, then Terminus assessment.
 */
export function reviewPlanDraft(
  draft: PlanDraft,
  context: PlanCheckContext
): PlanDraftReview {
  if (!draft.outline)
    return {
      kind: "schema",
      issues: [{ path: "$", code: "missing_outline" }],
      problems: [`No outline is saved yet. Save one with ${call.outline}.`],
    }
  const assembly = assemble(draft.outline, draft.stations)
  if (assembly.missing.length)
    return {
      kind: "schema",
      issues: [{ path: "stations", code: "missing_station" }],
      problems: [
        `These Stations are in the outline but not saved: ${keys(assembly.missing)}. Save each with ${call.station}.`,
        ...problemList(checkDraft(draft, context)),
      ],
    }
  const parsed = dispatchProposalSchema.safeParse(assembly.proposal)
  if (!parsed.success)
    return {
      kind: "schema",
      issues: validationIssues(parsed.error),
      problems: parsed.error.issues.map((issue) =>
        describeIssue(issue, assembly.paths)
      ),
    }
  const errors = assess(parsed.data, context)
  if (!errors.length) return { kind: "valid", proposal: parsed.data }
  return {
    kind: "assessment",
    proposal: parsed.data,
    errors,
    problems: problemList(attribute(errors, assembly.labels)),
  }
}

/** The correction sent when a session ends without an accepted plan. */
export function planCorrection(
  review: Exclude<PlanDraftReview, { kind: "valid" }>
): string {
  return [
    review.kind === "assessment"
      ? "Your saved plan is complete, but Terminus assessment found problems that would block launch:"
      : "Your saved plan is not complete:",
    bullets(review.problems),
    `Fix every problem with ${call.station} or ${call.outline}, then call ${call.finalize} until it accepts the plan, and end with a one-line final message.`,
  ].join("\n\n")
}

/** Names the Line or Station a proposal schema issue concerns. */
function describeIssue(
  issue: z.core.$ZodIssue,
  paths: Assembly["paths"]
): string {
  const path = issue.path.map(String).join(".")
  const owner = paths
    .filter((p) => path === p.path || path.startsWith(`${p.path}.`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  if (!owner) return `${path || "(the plan)"}: ${issue.message}`
  const field = path.slice(owner.path.length + 1)
  return `${owner.owner}: ${field ? `${field}: ` : ""}${issue.message}`
}

/** One plan tool call's outcome. The caller stores `draft` for the next call. */
export interface PlanToolReply {
  draft: PlanDraft
  text: string
  outcome: "saved" | "rejected" | "read" | "accepted"
  /** The accepted proposal, from `finalize_plan` only. */
  proposal?: DispatchProposal
}

/** Answers one plan tool call against the current draft. */
export function planToolReply(
  name: string,
  args: unknown,
  draft: PlanDraft,
  context: PlanCheckContext
): PlanToolReply {
  switch (name) {
    case planToolNames.outline:
      return outlineReply(args, draft, context)
    case planToolNames.station:
      return stationReply(args, draft, context)
    case planToolNames.inspect:
      return inspectReply(args, draft, context)
    case planToolNames.finalize:
      return finalizeReply(draft, context)
    default:
      return { draft, outcome: "rejected", text: `Unknown tool: ${name}` }
  }
}

function outlineReply(
  args: unknown,
  draft: PlanDraft,
  context: PlanCheckContext
): PlanToolReply {
  const rejected = (lines: string[]): PlanToolReply => ({
    draft,
    outcome: "rejected",
    text: [
      ...lines,
      `Fix every problem, then call ${call.outline} again with the complete outline. Saved Stations are kept.`,
    ].join("\n\n"),
  })
  // The outline may arrive as JSON text, as an object, or spread over the arguments.
  let value: unknown = isRecord(args) && "outline" in args ? args.outline : args
  if (typeof value === "string") {
    const text = value
    try {
      value = finalMessageJson(text)
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error)
      return rejected([
        `${notSavedReply} the outline is not valid JSON.`,
        jsonParseHint(parseError, text),
      ])
    }
  }
  const parsed = planOutlineSchema.safeParse(normalizeOutline(value))
  if (!parsed.success)
    return rejected([
      `${notSavedReply} the outline does not match the outline schema.`,
      bullets(parsed.error.issues.map(issueLine)),
    ])
  const outline = parsed.data
  const problems = outlineProblems(outline, context)
  if (problems.length)
    return rejected([
      `${notSavedReply} the outline has problems that would block launch.`,
      bullets(problems),
    ])
  const next: PlanDraft = { ...draft, outline }
  const check = checkDraft(next, context)
  const stationCount = outline.lines.reduce(
    (sum, line) => sum + line.stations.length,
    0
  )
  const ignored = Object.keys(next.stations).filter(
    (key) => !outline.lines.some((line) => line.stations.includes(key))
  )
  const found = problemList(check)
  return {
    draft: next,
    outcome: "saved",
    text: [
      `Saved the outline: ${count(outline.lines.length, "Line")} and ${count(stationCount, "Station")}.`,
      ...(ignored.length
        ? [
            `Saved Stations not in this outline, ignored unless you add them back: ${keys(ignored)}.`,
          ]
        : []),
      ...(found.length ? ["Problems in the plan so far:", bullets(found)] : []),
      progress(next, null),
    ].join("\n\n"),
  }
}

/** Optional outline values sent as null are treated as absent. */
function normalizeOutline(value: unknown): unknown {
  if (!isRecord(value)) return value
  const outline = withoutNulls(value, ["junctions", "findings", "baselineFix"])
  if (Array.isArray(outline.lines))
    outline.lines = outline.lines.map((line: unknown) =>
      isRecord(line)
        ? withoutNulls(line, ["unloadRecommendation", "route", "shared"])
        : line
    )
  return outline
}

const stringListFields = [
  "scope",
  "expectedAreas",
  "avoidAreas",
  "invariants",
  "dependencies",
  "acceptanceCriteria",
  "expectedEvidence",
  "projectFacts",
] as const

/**
 * Accepts the slips models make with flat arguments: the Station wrapped in
 * a `station` argument, null for an absent value, and a list sent as JSON
 * text or as one item per line. Everything else is left to the schema.
 */
function normalizeStation(args: unknown): unknown {
  let value = args
  if (isRecord(value) && !("key" in value) && "station" in value) {
    value = value.station
    if (typeof value === "string") {
      try {
        value = finalMessageJson(value)
      } catch {
        return value
      }
    }
  }
  if (!isRecord(value)) return value
  const station = withoutNulls(value, Object.keys(value))
  for (const field of stringListFields)
    if (typeof station[field] === "string")
      station[field] = textList(station[field])
  if (typeof station.contracts === "string")
    station.contracts = jsonList(station.contracts)
  return station
}

function textList(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("[")) return jsonList(trimmed)
  return trimmed
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
}

function jsonList(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function stationReply(
  args: unknown,
  draft: PlanDraft,
  context: PlanCheckContext
): PlanToolReply {
  const parsed = planStationSchema.safeParse(normalizeStation(args))
  if (!parsed.success) {
    const key = isRecord(args) && typeof args.key === "string" ? args.key : ""
    return {
      draft,
      outcome: "rejected",
      text: [
        `${notSavedReply} ${key ? `Station \`${key}\`` : "the Station"} does not match the ${planToolNames.station} schema.`,
        bullets(parsed.error.issues.map(issueLine)),
        `Fix every problem, then call ${call.station} again with the complete Station.`,
        progress(draft, checkDraft(draft, context)),
      ].join("\n\n"),
    }
  }
  const station = parsed.data
  const replaced = !!savedStation(draft.stations, station.key)
  const next: PlanDraft = {
    ...draft,
    stations: { ...draft.stations, [station.key]: station },
  }
  const check = checkDraft(next, context)
  const problems = stationProblems(station.key, next, check)
  return {
    draft: next,
    outcome: "saved",
    text: [
      `Saved Station \`${station.key}\`${replaced ? ", replacing the earlier version" : ""}.`,
      ...(problems.length
        ? [
            `Problems with this Station. Fix them with another ${call.station} call, or in the outline when they come from the Line:`,
            bullets(problems),
          ]
        : []),
      progress(next, check, station.key),
    ].join("\n\n"),
  }
}

function stationProblems(
  key: string,
  draft: PlanDraft,
  check: Attributed
): string[] {
  if (!draft.outline) return []
  if (!draft.outline.lines.some((line) => line.stations.includes(key)))
    return [
      `It is not on any Line in the outline, so the plan ignores it. To use it, add \`${key}\` to a Line's \`stations\` with ${call.outline}.`,
    ]
  return check.stations.get(key) ?? []
}

function inspectReply(
  args: unknown,
  draft: PlanDraft,
  context: PlanCheckContext
): PlanToolReply {
  const check = checkDraft(draft, context)
  const requested =
    isRecord(args) && typeof args.station === "string"
      ? args.station.trim()
      : ""
  if (requested) {
    const station = savedStation(draft.stations, requested)
    const problems = station ? stationProblems(requested, draft, check) : []
    return {
      draft,
      outcome: "read",
      text: [
        station
          ? `Station \`${requested}\` as saved:\n${JSON.stringify(station)}`
          : `Station \`${requested}\` is not saved.`,
        ...(problems.length
          ? ["Problems with this Station:", bullets(problems)]
          : []),
        progress(draft, check, requested),
      ].join("\n\n"),
    }
  }
  const outline = draft.outline
  if (!outline) return { draft, outcome: "read", text: progress(draft, null) }
  const placement = placements(outline)
  const ignored = Object.keys(draft.stations).filter(
    (key) => !outline.lines.some((line) => line.stations.includes(key))
  )
  const found = problemList(check)
  return {
    draft,
    outcome: "read",
    text: [
      "Lines:",
      bullets(
        outline.lines.map(
          (line) =>
            `\`${line.key}\` ${line.name} (${placement.get(line.key) ?? "top-level"}): ${
              line.stations
                .map((key) =>
                  savedStation(draft.stations, key) ? key : `${key} (not saved)`
                )
                .join(", ") || "no Stations"
            }`
        )
      ),
      ...(ignored.length
        ? [`Saved Stations not in the outline, ignored: ${keys(ignored)}.`]
        : []),
      ...(found.length
        ? ["Problems in the plan so far:", bullets(found)]
        : ["No problems found so far."]),
      progress(draft, null),
      `The saved outline, to edit when you change it:\n${JSON.stringify(outline)}`,
    ].join("\n\n"),
  }
}

function finalizeReply(
  draft: PlanDraft,
  context: PlanCheckContext
): PlanToolReply {
  const review = reviewPlanDraft(draft, context)
  if (review.kind === "valid")
    return {
      draft,
      outcome: "accepted",
      proposal: review.proposal,
      text: `${planAcceptedReply} the plan passed schema validation and Terminus assessment, and Terminus will use it. End now with a one-line final message such as \`Plan submitted.\` Do not repeat the plan.`,
    }
  return {
    draft,
    outcome: "rejected",
    text: [
      "Not accepted.",
      review.kind === "assessment"
        ? "The plan is complete, but Terminus assessment found problems that would block launch:"
        : "The plan is not complete:",
      bullets(review.problems),
      `Fix every problem with ${call.station} or ${call.outline}, then call ${call.finalize} again.`,
    ].join("\n\n"),
  }
}

/**
 * Where the plan stands, ending every reply. With `check`, it names where
 * problems the reply did not list remain (all but Station `except`).
 */
function progress(
  draft: PlanDraft,
  check: Attributed | null,
  except?: string
): string {
  const saved = Object.keys(draft.stations)
  const outline = draft.outline
  if (!outline)
    return [
      `No outline is saved yet; save it with ${call.outline}.`,
      ...(saved.length ? [`Saved Stations: ${keys(saved)}.`] : []),
    ].join(" ")
  const planned = outline.lines.flatMap((line) => line.stations)
  const missing = planned.filter((key) => !savedStation(draft.stations, key))
  const stations = [...(check?.stations.keys() ?? [])].filter(
    (key) => key !== except
  )
  const places = [
    ...(stations.length
      ? [`${stations.length === 1 ? "Station" : "Stations"} ${keys(stations)}`]
      : []),
    ...(check?.general.length ? ["the plan as a whole"] : []),
  ]
  const elsewhere = places.length
    ? ` Problems remain in ${places.join(" and ")}; ${call.inspect} lists them.`
    : ""
  if (missing.length)
    return `Saved ${planned.length - missing.length} of ${count(planned.length, "Station")}. Still to save: ${keys(missing)}.${elsewhere}`
  const done =
    planned.length === 1
      ? "The plan's one Station is saved."
      : `All ${planned.length} Stations are saved.`
  return `${done}${elsewhere || ` Call ${call.finalize} when the plan is complete.`}`
}

/**
 * The plan tools as an MCP server lists them. With `asText`, the outline
 * travels as JSON text (see `proposalAsText`); Stations always use flat
 * arguments, so no value nests deeper than a list.
 */
export function planTools(asText: boolean) {
  return [
    {
      name: planToolNames.outline,
      description: `Saves the plan's layout: the summary, findings, every Line (key, name, unload recommendation, ordered Station keys, optional route and shared Manifest values), Junctions and an optional baseline fix. Station Manifests are not part of the outline: save each with ${call.station}, before or after the outline. Replaces any earlier outline and keeps saved Stations. The reply says whether the outline was saved and lists every problem.`,
      inputSchema: {
        type: "object",
        properties: {
          outline: asText
            ? {
                type: "string",
                description:
                  "The complete outline as JSON text, matching the outline JSON schema in your instructions. Write the JSON itself, with no code fence.",
              }
            : {
                ...planOutlineJsonSchema(),
                description: "The complete outline.",
              },
        },
        required: ["outline"],
        additionalProperties: false,
      },
    },
    {
      name: planToolNames.station,
      description: `Saves one Station's name and complete Manifest, replacing any earlier version of that Station. Every list holds plain strings, except contracts. Save each Station with its own call; several calls may go in one message. The reply says whether the Station was saved, lists its problems, and says what is still missing.`,
      inputSchema: toolSchema(planStationSchema),
    },
    {
      name: planToolNames.inspect,
      description:
        "Lists the saved outline, which Stations are saved or still missing, and every problem Terminus can find so far. Pass `station` to read back one saved Station.",
      inputSchema: {
        type: "object",
        properties: {
          station: {
            type: "string",
            description:
              "Optional. A Station key, to read back everything saved for that Station.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: planToolNames.finalize,
      description: `Assembles the saved outline and Stations into the proposal and checks it against the proposal schema and Terminus launch rules. When it passes, Terminus records the plan as your answer. When it fails, the reply lists every problem; fix them with ${call.station} or ${call.outline}, then call ${call.finalize} again.`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ]
}

/** The outline's JSON schema, for instructions when it travels as text. */
export function planOutlineJsonSchema(): Record<string, unknown> {
  return toolSchema(planOutlineSchema)
}

/**
 * A tool input schema. Patterns with lookahead are dropped: some model
 * providers compile tool schemas into grammars that cannot express them.
 * Terminus validates every value against the full schema anyway.
 */
function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (!isRecord(value)) return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([name, item]) =>
            name !== "$schema" &&
            !(
              name === "pattern" &&
              typeof item === "string" &&
              item.includes("(?")
            )
        )
        .map(([name, item]) => [name, strip(item)])
    )
  }
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>
}

function withoutNulls(
  value: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  const result = { ...value }
  for (const field of fields) if (result[field] === null) delete result[field]
  return result
}

function issueLine(issue: z.core.$ZodIssue): string {
  return `${issue.path.map(String).join(".") || "(top level)"}: ${issue.message}`
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n")
}

function keys(items: string[]): string {
  return items.map((key) => `\`${key}\``).join(", ")
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
