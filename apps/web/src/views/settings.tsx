import {
  MODEL_CATALOG,
  HARNESS_CATALOG,
  roleHarnesses,
  modelForHarness,
  compatibleModels,
  utilityModel,
  type Harness,
  type HarnessRole,
  type ModelProviderId,
  type RoleHarnesses,
  MODEL_PRESETS,
  roleModels,
  type FixedModelPreset,
  type ModelRole,
  type ModelSettings,
  type RoleModels,
  MAX_SANDBOX_INSTANCES,
  SANDBOX_SIZES,
  sandboxLimitsSchema,
  type NetworkSandboxLimits,
  type SandboxKind,
  type SandboxLimits,
  type SandboxSize,
} from "@terminus/protocol"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { cn } from "@terminus/ui/lib/utils"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { RotateCw, X } from "lucide-react"
import { api } from "@/state/api"

/** "general" follows the global settings; only a network offers it. */
type Choice = "general" | FixedModelPreset | "custom"

const presets: {
  id: FixedModelPreset | "heavy" | "custom"
  name: string
  detail: string
}[] = [
  {
    id: "extra_light",
    name: "Extra-light",
    detail: "GLM-5.3 Flash for every role. The lowest cost.",
  },
  {
    id: "light",
    name: "Light",
    detail: "Extra-light, with GLM-5.3 planning for the Dispatcher.",
  },
  {
    id: "medium",
    name: "Medium",
    detail:
      "GLM-5.3 plans, reviews and repairs; Kimi K2.7 Code writes Station work.",
  },
  { id: "heavy", name: "Heavy", detail: "Larger models for every role." },
  {
    id: "custom",
    name: "Custom",
    detail: "Choose a harness and model for each role.",
  },
]

const presetName = (settings: ModelSettings) =>
  presets.find((preset) => preset.id === settings.preset)!.name

const roles: { id: ModelRole; name: string; detail: string }[] = [
  {
    id: "dispatcher",
    name: "Dispatcher",
    detail: "Plans goals into Lines and Stations",
  },
  {
    id: "conductor",
    name: "Conductor",
    detail: "Reviews Station work before it joins a Train",
  },
  {
    id: "stationAgent",
    name: "Station Agent",
    detail: "Writes the code for each Station",
  },
  {
    id: "technician",
    name: "Technician",
    detail: "Repairs merges that fail at Terminus",
  },
  {
    id: "engineer",
    name: "Engineer",
    detail: "Settles movement calls the hard rules leave open",
  },
]

const catalog = (id: string) => MODEL_CATALOG.find((model) => model.id === id)

/** The models a role may use: the Engineer only answers fixed questions. */
const options = (role: ModelRole, harness: Harness = "opencode") =>
  role === "engineer"
    ? MODEL_CATALOG.filter((model) => model.kind === "decision")
    : compatibleModels(harness)

interface Saved {
  choice: Choice
  custom: RoleModels
  harnesses: RoleHarnesses
  general: ModelSettings
  updatedAt: string | null
  alternativesEnabled: boolean
  opencodeExternalEnabled: boolean
}

const settingsFor = (
  choice: Choice,
  custom: RoleModels,
  harnesses: RoleHarnesses
): ModelSettings | null =>
  choice === "general"
    ? null
    : choice === "custom"
      ? { preset: "custom", models: custom, harnesses }
      : { preset: choice }

function toSaved(
  own: ModelSettings | null,
  general: ModelSettings,
  updatedAt: string | null,
  alternativesEnabled = false,
  opencodeExternalEnabled = false
): Saved {
  return {
    choice: own?.preset ?? "general",
    custom: roleModels(own ?? general),
    harnesses: roleHarnesses(own ?? general),
    general,
    updatedAt,
    alternativesEnabled,
    opencodeExternalEnabled,
  }
}

interface Loaded {
  agents: Saved
  containers: SavedLimits
  networkName: string | null
}

const loadAgents = (networkId: string | null): Promise<Saved> =>
  networkId
    ? api
        .networkModelSettings(networkId)
        .then((settings) =>
          toSaved(
            settings.override,
            settings.general,
            settings.updatedAt,
            settings.alternativeHarnessesEnabled,
            settings.opencodeExternalProvidersEnabled
          )
        )
    : api
        .modelSettings()
        .then((general) =>
          toSaved(
            general.settings,
            general.settings,
            general.updatedAt,
            general.alternativeHarnessesEnabled,
            general.opencodeExternalProvidersEnabled
          )
        )

const loadContainers = (networkId: string | null): Promise<SavedLimits> =>
  networkId
    ? api.networkSandboxLimits(networkId)
    : api.sandboxLimits().then((general) => ({
        override: general.limits,
        general: general.limits,
        updatedAt: general.updatedAt,
      }))

/** Settings for the current page's scope, over the page without navigating. */
export function SettingsDialog({
  networkId,
  onClose,
}: {
  networkId: string | null
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const element = dialog.current!
    const overflow = document.body.style.overflow
    element.showModal()
    document.body.style.overflow = "hidden"
    return () => {
      element.close()
      document.body.style.overflow = overflow
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadAgents(networkId),
      loadContainers(networkId),
      networkId ? api.networkSummary(networkId) : null,
    ])
      .then(([agents, containers, summary]) => {
        if (cancelled) return
        setLoaded({ agents, containers, networkName: summary?.name ?? null })
      })
      .catch((caught) => !cancelled && setLoadError(String(caught)))
    return () => {
      cancelled = true
    }
  }, [networkId, attempt])

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={() => {
        if (!dialog.current?.open) onClose()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dialog.current?.close()
      }}
    >
      <header className="settings-dialog-header">
        <div>
          <p className="eyebrow">
            {networkId
              ? (loaded?.networkName ?? "This network")
              : "All networks"}
          </p>
          <h2 id={titleId}>
            {networkId ? "Network settings" : "Global settings"}
          </h2>
          <p id={descriptionId}>
            {networkId
              ? "Configure this network, or follow the global defaults."
              : "Default settings for every network. Networks can override these settings."}
          </p>
        </div>
        <button
          type="button"
          className="theme-button"
          aria-label="Close settings"
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="settings-dialog-body">
        {loaded ? (
          <>
            <section
              className="settings-group"
              aria-labelledby="settings-agents-heading"
            >
              <header className="settings-header">
                <h3 id="settings-agents-heading">Roles &amp; Models</h3>
                <p>
                  {networkId
                    ? "Choose harnesses and models for this network."
                    : "Choose default harnesses and models for every network."}{" "}
                  Changes apply to new Trains, plans and repairs; work already
                  running keeps its harnesses and models.
                </p>
              </header>
              <ModelSettingsForm
                key={JSON.stringify(loaded.agents)}
                networkId={networkId}
                saved={loaded.agents}
                onSaved={(agents) =>
                  setLoaded((current) => current && { ...current, agents })
                }
              />
            </section>
            <section
              className="settings-group"
              aria-labelledby="settings-containers-heading"
            >
              <header className="settings-header">
                <h3 id="settings-containers-heading">Containers</h3>
                <p>
                  Set Sandbox sizes and how many each network may run at once.
                  At its limit, work waits for a running Sandbox to finish; a
                  preview reports the limit instead of waiting.
                </p>
              </header>
              <SandboxLimitsForm
                key={JSON.stringify(loaded.containers)}
                networkId={networkId}
                saved={loaded.containers}
                onSaved={(containers) =>
                  setLoaded((current) => current && { ...current, containers })
                }
              />
            </section>
          </>
        ) : loadError ? (
          <div className="reader-state" role="alert">
            <strong>Couldn't load settings</strong>
            <span>{loadError}</span>
            <Button
              variant="outline"
              onClick={() => {
                setLoadError(null)
                setAttempt((value) => value + 1)
              }}
            >
              <RotateCw size={14} /> Try again
            </Button>
          </div>
        ) : (
          <div
            className="settings-skeleton"
            aria-busy="true"
            aria-label="Loading settings"
          >
            <i />
            <i />
          </div>
        )}
      </div>
    </dialog>
  )
}

function ModelSettingsForm({
  networkId,
  saved,
  onSaved,
}: {
  networkId: string | null
  saved: Saved
  onSaved: (saved: Saved) => void
}) {
  const [choice, setChoice] = useState<Choice>(saved.choice)
  const [custom, setCustom] = useState<RoleModels>(saved.custom)
  const [harnesses, setHarnesses] = useState<RoleHarnesses>(saved.harnesses)
  const [modelChange, setModelChange] = useState<string | null>(null)
  const [customEdited, setCustomEdited] = useState(saved.choice === "custom")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shown: RoleModels =
    choice === "general"
      ? roleModels(saved.general)
      : choice === "custom"
        ? custom
        : MODEL_PRESETS[choice]
  const shownHarnesses =
    choice === "general"
      ? roleHarnesses(saved.general)
      : choice === "custom"
        ? harnesses
        : roleHarnesses({ preset: choice })
  /** Whether this deployment runs a harness with a model's provider. */
  const runnable = (harness: Harness, provider: ModelProviderId) =>
    harness === "opencode"
      ? provider === "workers-ai" || saved.opencodeExternalEnabled
      : saved.alternativesEnabled
  const changeHarness = (role: HarnessRole, harness: Harness) => {
    const kept = modelForHarness(harness, shown[role])
    const model = (
      runnable(harness, catalog(kept)!.provider)
        ? kept
        : compatibleModels(harness)[0]!.id
    ) as RoleModels[HarnessRole]
    setCustom({ ...shown, [role]: model })
    setHarnesses({ ...shownHarnesses, [role]: harness })
    setCustomEdited(true)
    setChoice("custom")
    setError(null)
    setModelChange(
      model === shown[role]
        ? null
        : `${roles.find((item) => item.id === role)!.name} now uses ${catalog(model)!.name}, the lowest-cost compatible catalog model. Save to apply.`
    )
  }
  const target = settingsFor(choice, custom, harnesses)
  const dirty =
    JSON.stringify(target) !==
    JSON.stringify(settingsFor(saved.choice, saved.custom, saved.harnesses))

  const choose = (next: Choice) => {
    // Custom starts from whatever is showing, until someone edits it.
    if (next === "custom" && !customEdited) {
      setCustom(shown)
      setHarnesses(shownHarnesses)
    }
    setModelChange(null)
    setChoice(next)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      if (networkId) {
        const next = await api.saveNetworkModelSettings(networkId, target)
        onSaved(
          toSaved(
            next.override,
            next.general,
            next.updatedAt,
            next.alternativeHarnessesEnabled,
            next.opencodeExternalProvidersEnabled
          )
        )
      } else {
        const next = await api.saveModelSettings(target!)
        onSaved(
          toSaved(
            next.settings,
            next.settings,
            next.updatedAt,
            next.alternativeHarnessesEnabled,
            next.opencodeExternalProvidersEnabled
          )
        )
      }
    } catch (caught) {
      setError(String(caught))
      setSaving(false)
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <p className="settings-help">
        All providers run through Cloudflare AI Gateway. Anthropic and OpenAI
        models are paid from your gateway’s Unified Billing credits; Terminus
        never handles provider keys.{" "}
        <a
          href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
          target="_blank"
          rel="noreferrer"
        >
          Set up Unified Billing
        </a>
        .
      </p>
      {!saved.alternativesEnabled && (
        <p className="settings-help" role="status">
          Claude Code, Codex and external-provider models are unavailable until
          this deployment passes live Sandbox verification.
        </p>
      )}
      {saved.alternativesEnabled && !saved.opencodeExternalEnabled && (
        <p className="settings-help" role="status">
          Anthropic and OpenAI models run under Claude Code and Codex. OpenCode
          uses Workers AI models until it passes live verification with those
          providers.
        </p>
      )}
      <section aria-labelledby="settings-preset">
        <h4 id="settings-preset">Preset</h4>
        <div
          className="settings-options panel"
          role="radiogroup"
          aria-labelledby="settings-preset"
        >
          {networkId && (
            <PresetOption
              id="general"
              name="Use global settings"
              detail={`Currently ${presetName(saved.general)}. Follows changes to global settings.`}
              checked={choice === "general"}
              onChange={choose}
            />
          )}
          {presets.map((preset) => (
            <PresetOption
              key={preset.id}
              id={preset.id}
              name={preset.name}
              detail={preset.detail}
              checked={choice === preset.id}
              onChange={choose}
              aside={
                preset.id === "heavy" ? (
                  <span className="settings-tag">Coming soon</span>
                ) : preset.id === "extra_light" ? (
                  <span className="settings-tag">Default</span>
                ) : null
              }
            />
          ))}
        </div>
      </section>

      {modelChange && <p role="status">{modelChange}</p>}
      <section aria-labelledby="settings-roles">
        <div className="settings-section-heading">
          <h4 id="settings-roles">Role agents</h4>
          <p>
            {choice === "custom"
              ? "Choose a harness and compatible model for each role. The Engineer uses a Clef decision model."
              : "Choose a harness to customize a role, or choose Custom to edit models."}{" "}
            Each harness names its sessions with the lowest-cost model from its
            role model’s provider. That model never plans, writes code or
            reviews.
          </p>
        </div>
        <table className="settings-roles panel">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Harness</th>
              <th scope="col">Model</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const model = catalog(shown[role.id])
              const utility =
                role.id === "engineer" ? null : utilityModel(shown[role.id])
              return (
                <tr key={role.id}>
                  <th scope="row">
                    <span>{role.name}</span>
                    <small>{role.detail}</small>
                    {role.id === "engineer" && (
                      <small className="settings-role-note">
                        Not called yet: hard rules decide until model-assisted
                        Engineer decisions ship.
                      </small>
                    )}
                  </th>
                  <td data-label="Harness">
                    {role.id === "engineer" ? (
                      <span>Direct model</span>
                    ) : (
                      <select
                        aria-label={`${role.name} harness`}
                        value={shownHarnesses[role.id]}
                        onChange={(event) =>
                          changeHarness(
                            role.id as HarnessRole,
                            event.target.value as Harness
                          )
                        }
                      >
                        {HARNESS_CATALOG.map((harness) => (
                          <option
                            key={harness.id}
                            value={harness.id}
                            disabled={
                              harness.id !== "opencode" &&
                              !saved.alternativesEnabled
                            }
                          >
                            {harness.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td data-label="Model">
                    {choice === "custom" ? (
                      <select
                        aria-label={`${role.name} model`}
                        value={custom[role.id]}
                        onChange={(event) => {
                          setCustomEdited(true)
                          setCustom({
                            ...custom,
                            [role.id]: event.target.value,
                          } as RoleModels)
                        }}
                      >
                        {options(
                          role.id,
                          role.id === "engineer"
                            ? "opencode"
                            : harnesses[role.id]
                        ).map((option) => (
                          <option
                            key={option.id}
                            value={option.id}
                            disabled={
                              role.id !== "engineer" &&
                              !runnable(harnesses[role.id], option.provider)
                            }
                          >
                            {option.name} · {option.maker}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="settings-model">
                        {model?.name ?? shown[role.id]}
                        <small>{model?.maker}</small>
                      </span>
                    )}
                    {utility && utility !== shown[role.id] && (
                      <small className="settings-utility">
                        Session titles: {catalog(utility)!.name}
                      </small>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <footer className={cn("settings-footer", dirty && "is-dirty")}>
        <p role="status" className={cn(error && "is-error")}>
          {error
            ? `Couldn't save: ${error}`
            : dirty
              ? "Unsaved changes"
              : saved.updatedAt
                ? `Saved ${new Date(saved.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                : networkId
                  ? null
                  : "Using the default preset"}
        </p>
        <button
          type="button"
          className={buttonVariants({ variant: "ghost" })}
          disabled={!dirty || saving}
          onClick={() => {
            setChoice(saved.choice)
            setCustom(saved.custom)
            setHarnesses(saved.harnesses)
            setModelChange(null)
            setCustomEdited(saved.choice === "custom")
            setError(null)
          }}
        >
          Discard
        </button>
        <Button type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save roles & models"}
        </Button>
      </footer>
    </form>
  )
}

function PresetOption({
  id,
  name,
  detail,
  checked,
  onChange,
  aside,
}: {
  id: Choice | "heavy"
  name: string
  detail: string
  checked: boolean
  onChange: (choice: Choice) => void
  aside?: ReactNode
}) {
  const disabled = id === "heavy"
  return (
    <div
      className={cn(
        "settings-option",
        checked && "is-checked",
        disabled && "is-disabled"
      )}
    >
      <label>
        <input
          type="radio"
          name="preset"
          value={id}
          checked={checked}
          disabled={disabled}
          onChange={() => id !== "heavy" && onChange(id)}
        />
        <span>
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
      </label>
      {aside}
    </div>
  )
}

/** The limits a scope shows. For global settings, its own limits are also `general`. */
type SavedLimits = Pick<
  NetworkSandboxLimits,
  "override" | "general" | "updatedAt"
>

const sandboxKinds: {
  id: SandboxKind
  name: string
  detail: string
}[] = [
  {
    id: "agent",
    name: "Agent Sandboxes",
    detail:
      "Run harnesses: Station work, Conductor reviews, Dispatcher planning and Technician repairs",
  },
  {
    id: "agentless",
    name: "Agentless Sandboxes",
    detail: "Run Git operations, integration validation and previews",
  },
]

/** Cloudflare's resources for each instance type. */
const sandboxSizeResources: Record<SandboxSize, string> = {
  "standard-1": "½ vCPU · 4 GiB",
  "standard-2": "1 vCPU · 6 GiB",
  "standard-3": "2 vCPU · 8 GiB",
}

type LimitInputs = Record<SandboxKind, string> & {
  sizes: Record<SandboxKind, SandboxSize>
}
const inputsFor = (limits: SandboxLimits): LimitInputs => ({
  agent: String(limits.agent),
  agentless: String(limits.agentless),
  sizes: { ...limits.sizes },
})

function SandboxLimitsForm({
  networkId,
  saved,
  onSaved,
}: {
  networkId: string | null
  saved: SavedLimits
  onSaved: (saved: SavedLimits) => void
}) {
  const [follow, setFollow] = useState(!!networkId && !saved.override)
  const [inputs, setInputs] = useState<LimitInputs>(
    inputsFor(saved.override ?? saved.general)
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = sandboxLimitsSchema.safeParse({
    agent: Number(inputs.agent),
    agentless: Number(inputs.agentless),
    sizes: inputs.sizes,
  })
  const target: SandboxLimits | null = follow
    ? null
    : parsed.success
      ? parsed.data
      : null
  const invalid = !follow && !parsed.success
  const dirty = follow
    ? !!saved.override
    : JSON.stringify(inputs) !==
        JSON.stringify(inputsFor(saved.override ?? saved.general)) ||
      !saved.override

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (invalid) return
    setSaving(true)
    setError(null)
    try {
      if (networkId)
        onSaved(await api.saveNetworkSandboxLimits(networkId, target))
      else {
        const next = await api.saveSandboxLimits(target!)
        onSaved({
          override: next.limits,
          general: next.limits,
          updatedAt: next.updatedAt,
        })
      }
    } catch (caught) {
      setError(String(caught))
      setSaving(false)
    }
  }

  const shown = follow ? inputsFor(saved.general) : inputs
  return (
    <form className="settings-form" onSubmit={submit}>
      {networkId && (
        <section aria-labelledby="settings-limits-scope">
          <h4 id="settings-limits-scope">Limits</h4>
          <div
            className="settings-options panel"
            role="radiogroup"
            aria-labelledby="settings-limits-scope"
          >
            <ScopeOption
              name="Use global limits"
              detail={`Currently ${saved.general.agent} agent at ${saved.general.sizes.agent} and ${saved.general.agentless} agentless at ${saved.general.sizes.agentless}. Follows changes to global settings.`}
              checked={follow}
              onChange={() => {
                setFollow(true)
                setError(null)
              }}
            />
            <ScopeOption
              name="Custom limits"
              detail="Set this network’s own limits."
              checked={!follow}
              onChange={() => {
                setFollow(false)
                setError(null)
              }}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="settings-limits">
        <div className="settings-section-heading">
          <h4 id="settings-limits">Sandbox sizes and limits</h4>
          <p>
            Each kind counts separately, from 1 to {MAX_SANDBOX_INSTANCES}.
            Changing a size or lowering a limit never stops running Sandboxes;
            it applies as they finish and new ones start.
          </p>
        </div>
        <table className="settings-roles settings-limits panel">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Instance</th>
              <th scope="col">Limit</th>
            </tr>
          </thead>
          <tbody>
            {sandboxKinds.map((kind) => (
              <tr key={kind.id}>
                <th scope="row">
                  <span>{kind.name}</span>
                  <small>{kind.detail}</small>
                </th>
                <td data-label="Instance">
                  {follow ? (
                    <span className="settings-model">
                      {shown.sizes[kind.id]}
                      <small>
                        {sandboxSizeResources[shown.sizes[kind.id]]}
                      </small>
                    </span>
                  ) : (
                    <>
                      <select
                        aria-label={`${kind.name} instance`}
                        value={inputs.sizes[kind.id]}
                        onChange={(event) => {
                          setInputs({
                            ...inputs,
                            sizes: {
                              ...inputs.sizes,
                              [kind.id]: event.target.value as SandboxSize,
                            },
                          })
                          setError(null)
                        }}
                      >
                        {SANDBOX_SIZES.map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                      <small>
                        {sandboxSizeResources[inputs.sizes[kind.id]]}
                      </small>
                    </>
                  )}
                </td>
                <td data-label="Limit">
                  {follow ? (
                    <span className="settings-model">{shown[kind.id]}</span>
                  ) : (
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_SANDBOX_INSTANCES}
                      step={1}
                      required
                      aria-label={`${kind.name} limit`}
                      value={inputs[kind.id]}
                      onChange={(event) => {
                        setInputs({ ...inputs, [kind.id]: event.target.value })
                        setError(null)
                      }}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className={cn("settings-footer", dirty && "is-dirty")}>
        <p role="status" className={cn((error || invalid) && "is-error")}>
          {error
            ? `Couldn't save: ${error}`
            : invalid
              ? `Limits must be whole numbers from 1 to ${MAX_SANDBOX_INSTANCES}.`
              : dirty
                ? "Unsaved changes"
                : saved.updatedAt
                  ? `Saved ${new Date(saved.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                  : networkId
                    ? null
                    : "Using the default limits"}
        </p>
        <button
          type="button"
          className={buttonVariants({ variant: "ghost" })}
          disabled={!dirty || saving}
          onClick={() => {
            setFollow(!!networkId && !saved.override)
            setInputs(inputsFor(saved.override ?? saved.general))
            setError(null)
          }}
        >
          Discard
        </button>
        <Button type="submit" disabled={!dirty || invalid || saving}>
          {saving ? "Saving…" : "Save containers"}
        </Button>
      </footer>
    </form>
  )
}

function ScopeOption({
  name,
  detail,
  checked,
  onChange,
}: {
  name: string
  detail: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div className={cn("settings-option", checked && "is-checked")}>
      <label>
        <input
          type="radio"
          name="limits-scope"
          checked={checked}
          onChange={onChange}
        />
        <span>
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
      </label>
    </div>
  )
}
