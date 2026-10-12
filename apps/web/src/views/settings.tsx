import {
  MODEL_CATALOG,
  HARNESS_CATALOG,
  roleHarnesses,
  modelForHarness,
  compatibleModels,
  type Harness,
  type HarnessRole,
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
  Fragment,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { RotateCw } from "lucide-react"
import { AppNav } from "@/components/app-nav"
import { api } from "@/state/api"
import { routes, type SettingsSection } from "@/state/route"

/** "general" follows the General settings; only a network offers it. */
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
  alternativesEnabled = false
): Saved {
  return {
    choice: own?.preset ?? "general",
    custom: roleModels(own ?? general),
    harnesses: roleHarnesses(own ?? general),
    general,
    updatedAt,
    alternativesEnabled,
  }
}

type Loaded =
  | { section: "agents"; saved: Saved }
  | { section: "sandboxes"; saved: SavedLimits }

const loadAgents = (networkId: string | null): Promise<Loaded> =>
  (networkId
    ? api
        .networkModelSettings(networkId)
        .then((settings) =>
          toSaved(
            settings.override,
            settings.general,
            settings.updatedAt,
            settings.alternativeHarnessesEnabled
          )
        )
    : api
        .modelSettings()
        .then((general) =>
          toSaved(
            general.settings,
            general.settings,
            general.updatedAt,
            general.alternativeHarnessesEnabled
          )
        )
  ).then((saved) => ({ section: "agents", saved }))

const loadSandboxes = (networkId: string | null): Promise<Loaded> =>
  (networkId
    ? api.networkSandboxLimits(networkId)
    : api.sandboxLimits().then((general) => ({
        override: general.limits,
        general: general.limits,
        updatedAt: general.updatedAt,
      }))
  ).then((saved) => ({ section: "sandboxes", saved }))

const sections: { id: SettingsSection; name: string }[] = [
  { id: "agents", name: "Agents" },
  { id: "sandboxes", name: "Sandboxes" },
]

/**
 * Which models the agents run, and how big and how many Sandboxes a network
 * may run at once. General settings apply to every network; a network's own settings
 * override them.
 */
export function SettingsPage({
  networkId,
  section,
}: {
  networkId: string | null
  section: SettingsSection
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [networkName, setNetworkName] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      section === "agents" ? loadAgents(networkId) : loadSandboxes(networkId),
      networkId ? api.networkSummary(networkId) : null,
    ])
      .then(([settings, summary]) => {
        if (cancelled) return
        setNetworkName(summary?.name ?? null)
        setLoaded(settings)
      })
      .catch((caught) => !cancelled && setLoadError(String(caught)))
    return () => {
      cancelled = true
    }
  }, [networkId, section, attempt])

  const trail = networkId
    ? [
        { label: "Networks", href: routes.networks() },
        { label: networkName ?? "…", href: routes.overview(networkId) },
        { label: "Settings" },
      ]
    : [{ label: "Networks", href: routes.networks() }, { label: "Settings" }]
  const here = networkId
    ? routes.networkSettings(networkId, section)
    : routes.settings(section)
  const scopeName = networkName ?? "this network"

  return (
    <>
      <AppNav trail={trail} settingsHref={here} />
      <div className="settings-page">
        <nav className="settings-nav" aria-label="Settings">
          {sections.map((item) => (
            <Fragment key={item.id}>
              <p className="eyebrow">{item.name}</p>
              <ul>
                <li>
                  <a
                    href={routes.settings(item.id)}
                    aria-current={
                      !networkId && section === item.id ? "page" : undefined
                    }
                  >
                    General
                    <small>All networks</small>
                  </a>
                </li>
                {networkId && (
                  <li>
                    <a
                      href={routes.networkSettings(networkId, item.id)}
                      aria-current={section === item.id ? "page" : undefined}
                    >
                      {networkName ?? "This network"}
                      <small>This network</small>
                    </a>
                  </li>
                )}
              </ul>
            </Fragment>
          ))}
          <p className="eyebrow">Providers</p>
          <ul>
            <li>
              <a
                href="https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/"
                target="_blank"
                rel="noreferrer"
              >
                Provider setup<small>Cloudflare AI Gateway</small>
              </a>
            </li>
          </ul>
        </nav>

        <main className="settings-main">
          {section === "agents" ? (
            <header className="settings-header">
              <h1>{networkId ? `Agents for ${scopeName}` : "Agents"}</h1>
              <p>
                {networkId
                  ? "Follow the General settings, or choose harnesses and models for this network only."
                  : "The default for every network. A network can override these in its own settings."}{" "}
                Changes apply to new Trains, plans and repairs; work already
                running keeps its harnesses and models.
              </p>
            </header>
          ) : (
            <header className="settings-header">
              <h1>{networkId ? `Sandboxes for ${scopeName}` : "Sandboxes"}</h1>
              <p>
                {networkId
                  ? "Follow the General limits, or set how big this network’s Sandboxes are and how many it may run at once."
                  : "How big each network’s Sandboxes are, and how many it may run at once. A network can override these in its own settings."}{" "}
                At its limit, a network’s work waits for a running Sandbox to
                finish; a preview reports the limit instead of waiting.
              </p>
            </header>
          )}

          {loaded?.section === "agents" ? (
            <ModelSettingsForm
              key={JSON.stringify(loaded.saved)}
              networkId={networkId}
              saved={loaded.saved}
              onSaved={(saved) => setLoaded({ section: "agents", saved })}
            />
          ) : loaded?.section === "sandboxes" ? (
            <SandboxLimitsForm
              key={JSON.stringify(loaded.saved)}
              networkId={networkId}
              saved={loaded.saved}
              onSaved={(saved) => setLoaded({ section: "sandboxes", saved })}
            />
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
        </main>
      </div>
    </>
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
  const changeHarness = (role: HarnessRole, harness: Harness) => {
    const model = modelForHarness(
      harness,
      shown[role]
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
            next.alternativeHarnessesEnabled
          )
        )
      } else {
        const next = await api.saveModelSettings(target!)
        onSaved(
          toSaved(
            next.settings,
            next.settings,
            next.updatedAt,
            next.alternativeHarnessesEnabled
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
        All providers run through Cloudflare AI Gateway. To use your own
        Anthropic or OpenAI account, add its API key in your gateway’s Provider
        Keys settings. Gateway configuration controls billing; Terminus never
        stores your provider keys.{" "}
        <a
          href="https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/"
          target="_blank"
          rel="noreferrer"
        >
          Set up providers
        </a>
        .
      </p>
      {!saved.alternativesEnabled && (
        <p className="settings-help" role="status">
          Claude Code, Codex and external-provider models are unavailable until
          this deployment passes live Sandbox verification.
        </p>
      )}
      <section aria-labelledby="settings-preset">
        <h2 id="settings-preset">Preset</h2>
        <div
          className="settings-options panel"
          role="radiogroup"
          aria-labelledby="settings-preset"
        >
          {networkId && (
            <PresetOption
              id="general"
              name="Use General settings"
              detail={`Currently ${presetName(saved.general)}. Follows any change to General.`}
              checked={choice === "general"}
              onChange={choose}
              aside={
                <a className="settings-option-link" href={routes.settings()}>
                  Edit General
                </a>
              }
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
          <h2 id="settings-roles">Role agents</h2>
          <p>
            {choice === "custom"
              ? "Choose a harness and compatible model for each role. The Engineer uses a Clef decision model."
              : "Choose a harness to customize a role, or choose Custom to edit models."}
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
                              option.provider !== "workers-ai" &&
                              !saved.alternativesEnabled
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
          {saving ? "Saving…" : "Save changes"}
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

/** The limits a scope shows. For General, its own limits are also `general`. */
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
          <h2 id="settings-limits-scope">Limits</h2>
          <div
            className="settings-options panel"
            role="radiogroup"
            aria-labelledby="settings-limits-scope"
          >
            <ScopeOption
              name="Use General limits"
              detail={`Currently ${saved.general.agent} agent at ${saved.general.sizes.agent} and ${saved.general.agentless} agentless at ${saved.general.sizes.agentless}. Follows any change to General.`}
              checked={follow}
              onChange={() => {
                setFollow(true)
                setError(null)
              }}
              aside={
                <a
                  className="settings-option-link"
                  href={routes.settings("sandboxes")}
                >
                  Edit General
                </a>
              }
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
          <h2 id="settings-limits">Sandbox sizes and limits</h2>
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
          {saving ? "Saving…" : "Save changes"}
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
  aside,
}: {
  name: string
  detail: string
  checked: boolean
  onChange: () => void
  aside?: ReactNode
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
      {aside}
    </div>
  )
}
