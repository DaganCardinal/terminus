import { useEffect, useState } from "react"

/** Where the app is, as encoded in the location hash. */
export type Route =
  | { page: "networks" }
  | { page: "map"; networkId: string }
  | {
      page: "overview"
      networkId: string
      /** A document or file to show; null shows the leading document. */
      view: { kind: "docs" | "files"; path: string } | null
    }

export function parseRoute(hash: string): Route {
  const match =
    /^#\/networks\/([^/]+)(?:\/(map|settings|docs|files)(?:\/(.*))?)?$/.exec(
      hash
    )
  if (!match) return { page: "networks" }
  const networkId = decodeURIComponent(match[1]!)
  const section = match[2]
  if (section === "map") return { page: "map", networkId }
  // Old network Settings bookmarks land on the overview; Settings is a modal.
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
