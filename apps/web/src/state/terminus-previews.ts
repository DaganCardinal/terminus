import { useSyncExternalStore } from "react"
import { api } from "./api"

export type TerminusPreviewState =
  | { status: "idle"; error?: string }
  | { status: "preparing" }
  | { status: "ready"; url: string }

const idle: TerminusPreviewState = { status: "idle" }
const previews = new Map<string, TerminusPreviewState>()
const listeners = new Set<() => void>()
const keyFor = (networkId: string, commit: string) => `${networkId}@${commit}`

function set(key: string, state: TerminusPreviewState) {
  previews.set(key, state)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTerminusPreview(networkId: string, commit: string) {
  return previews.get(keyFor(networkId, commit)) ?? idle
}

/** Closing the panel does not cancel a build. Later canonical commits get
 * their own state, so a late response cannot label old code as current. */
export async function prepareTerminusPreview(
  networkId: string,
  commit: string
) {
  const key = keyFor(networkId, commit)
  if (previews.get(key)?.status === "preparing") return
  set(key, { status: "preparing" })
  try {
    const result = await api.previewTerminus(networkId, commit)
    if (result.networkId !== networkId || result.commit !== commit)
      throw new Error(
        "The preview did not match the requested Terminus commit."
      )
    set(key, { status: "ready", url: result.url })
  } catch (caught) {
    set(key, {
      status: "idle",
      error:
        caught instanceof Error
          ? caught.message
          : "Could not start the Terminus preview.",
    })
  }
}

export function useTerminusPreview(networkId: string, commit: string) {
  return useSyncExternalStore(subscribe, () =>
    getTerminusPreview(networkId, commit)
  )
}
