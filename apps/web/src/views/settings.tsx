import {
  MODEL_CATALOG,
  MODEL_PRESETS,
  roleModels,
  type FixedModelPreset,
  type ModelRole,
  type ModelSettings,
  type RoleModels,
} from "@terminus/protocol"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { cn } from "@terminus/ui/lib/utils"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { KeyRound, RotateCw } from "lucide-react"
import { AppNav } from "@/components/app-nav"
import { api } from "@/state/api"
import { routes } from "@/state/route"

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
  { id: "custom", name: "Custom", detail: "Choose a model for each role." },
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
const options = (role: ModelRole) =>
  MODEL_CATALOG.filter(
    (model) => (model.kind === "decision") === (role === "engineer")
  )

interface Saved {
  choice: Choice
  custom: RoleModels
  general: ModelSettings
  updatedAt: string | null
}

const settingsFor = (
  choice: Choice,
  custom: RoleModels
): ModelSettings | null =>
  choice === "general"
    ? null
    : choice === "custom"
      ? { preset: "custom", models: custom }
      : { preset: choice }

function toSaved(
  own: ModelSettings | null,
  general: ModelSettings,
  updatedAt: string | null
): Saved {
  return {
    choice: own?.preset ?? "general",
    custom: roleModels(own ?? general),
    general,
    updatedAt,
  }
}

/**
 * Which models the agents run. General settings apply to every network; a
 * network's own settings override them.
 */
export function SettingsPage({ networkId }: { networkId: string | null }) {
  const [saved, setSaved] = useState<Saved | null>(null)
  const [networkName, setNetworkName] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = networkId
      ? Promise.all([
          api.networkModelSettings(networkId),
          api.networkSummary(networkId),
        ]).then(([settings, summary]) => {
          if (cancelled) return
          setNetworkName(summary.name)
          setSaved(
            toSaved(settings.override, settings.general, settings.updatedAt)
          )
        })
      : api.modelSettings().then((general) => {
          if (!cancelled)
            setSaved(
              toSaved(general.settings, general.settings, general.updatedAt)
            )
        })
    load.catch((caught) => !cancelled && setLoadError(String(caught)))
    return () => {
      cancelled = true
    }
  }, [networkId, attempt])

  const trail = networkId
    ? [
        { label: "Networks", href: routes.networks() },
        { label: networkName ?? "…", href: routes.overview(networkId) },
        { label: "Settings" },
      ]
    : [{ label: "Networks", href: routes.networks() }, { label: "Settings" }]
  const here = networkId ? routes.networkSettings(networkId) : routes.settings()

  return (
    <>
      <AppNav trail={trail} settingsHref={here} />
      <div className="settings-page">
        <nav className="settings-nav" aria-label="Settings">
          <p className="eyebrow">Models</p>
          <ul>
            <li>
              <a
                href={routes.settings()}
                aria-current={networkId ? undefined : "page"}
              >
                General
                <small>All networks</small>
              </a>
            </li>
            {networkId && (
              <li>
                <a href={here} aria-current="page">
                  {networkName ?? "This network"}
                  <small>This network</small>
                </a>
              </li>
            )}
          </ul>
          <p className="eyebrow">Providers</p>
          <ul>
            <li>
              <span className="settings-nav-soon" aria-disabled="true">
                <KeyRound size={14} aria-hidden="true" />
                API keys
                <small>Soon</small>
              </span>
            </li>
          </ul>
        </nav>

        <main className="settings-main">
          <header className="settings-header">
            <h1>
              {networkId
                ? `Models for ${networkName ?? "this network"}`
                : "Models"}
            </h1>
            <p>
              {networkId
                ? "Follow the General settings, or choose models for this network only."
                : "The default for every network. A network can override these in its own settings."}{" "}
              Changes apply to new Trains, plans and repairs; work already
              running keeps its models.
            </p>
          </header>

          {saved ? (
            <ModelSettingsForm
              key={JSON.stringify(saved)}
              networkId={networkId}
              saved={saved}
              onSaved={setSaved}
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
  const [customEdited, setCustomEdited] = useState(saved.choice === "custom")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shown: RoleModels =
    choice === "general"
      ? roleModels(saved.general)
      : choice === "custom"
        ? custom
        : MODEL_PRESETS[choice]
  const target = settingsFor(choice, custom)
  const dirty =
    JSON.stringify(target) !==
    JSON.stringify(settingsFor(saved.choice, saved.custom))

  const choose = (next: Choice) => {
    // Custom starts from whatever is showing, until someone edits it.
    if (next === "custom" && !customEdited) setCustom(shown)
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
        onSaved(toSaved(next.override, next.general, next.updatedAt))
      } else {
        const next = await api.saveModelSettings(target!)
        onSaved(toSaved(next.settings, next.settings, next.updatedAt))
      }
    } catch (caught) {
      setError(String(caught))
      setSaving(false)
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
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

      <section aria-labelledby="settings-roles">
        <div className="settings-section-heading">
          <h2 id="settings-roles">Role models</h2>
          <p>
            {choice === "custom"
              ? "Pick a Workers AI model for each role. The Engineer uses a Clef decision model."
              : "What each role runs with this preset. Choose Custom to change one."}
          </p>
        </div>
        <table className="settings-roles panel">
          <thead className="sr-only">
            <tr>
              <th scope="col">Role</th>
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
                  <td>
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
                        {options(role.id).map((option) => (
                          <option key={option.id} value={option.id}>
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
