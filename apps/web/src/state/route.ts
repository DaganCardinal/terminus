import { useEffect, useState } from "react"

/** Settings pages: agent harnesses and models, or Sandbox limits. */
export type SettingsSection = "agents" | "sandboxes"

/** Where the app is, as encoded in the location hash. */
export type Route =
  | { page: "networks" }
  | { page: "map"; networkId: string }
  /** General settings when networkId is null, else one network's overrides. */
  | { page: "settings"; networkId: string | null; section: SettingsSection }
  | {
      page: "overview"
      networkId: string
      /** A document or file to show; null shows the leading document. */
      view: { kind: "docs" | "files"; path: string } | null
    }

const settingsSection = (rest?: string): SettingsSection =>
  rest === "sandboxes" ? "sandboxes" : "agents"

export function parseRoute(hash: string): Route {
  const general = /^#\/settings(?:\/(sandboxes))?$/.exec(hash)
  if (general)
    return {
      page: "settings",
      networkId: null,
      section: settingsSection(general[1]),
    }
  const match =
    /^#\/networks\/([^/]+)(?:\/(map|settings|docs|files)(?:\/(.*))?)?$/.exec(
      hash
    )
  if (!match) return { page: "networks" }
  const networkId = decodeURIComponent(match[1]!)
  const section = match[2]
  if (section === "map") return { page: "map", networkId }
  if (section === "settings")
    return { page: "settings", networkId, section: settingsSection(match[3]) }
  const path = match[3] ? decodeURIComponent(match[3]) : ""
  return {
    page: "overview",
    networkId,
    view:
      (section === "docs" || section === "files") && path
        ? { kind: section, path }
        : null,
  }
}

/** Paths keep their slashes so links read naturally. */
export const routes = {
  networks: () => "#/",
  overview: (networkId: string) =>
    `#/networks/${encodeURIComponent(networkId)}`,
  map: (networkId: string) => `#/networks/${encodeURIComponent(networkId)}/map`,
  settings: (section: SettingsSection = "agents") =>
    section === "agents" ? "#/settings" : `#/settings/${section}`,
  networkSettings: (networkId: string, section: SettingsSection = "agents") =>
    `#/networks/${encodeURIComponent(networkId)}/settings${section === "agents" ? "" : `/${section}`}`,
  docs: (networkId: string, path: string) =>
    `#/networks/${encodeURIComponent(networkId)}/docs/${encodePath(path)}`,
  files: (networkId: string, path: string) =>
    `#/networks/${encodeURIComponent(networkId)}/files/${encodePath(path)}`,
}

const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/")

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  return route
}
