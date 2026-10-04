import { useSyncExternalStore } from "react"
import { api } from "./api"

/** A Train preview Sandbox, keyed by the Train commit it was built from. Kept
 * outside React so a build in progress survives the drawer closing. */
export type TrainPreviewState =
  | { status: "idle"; error?: string }
  | { status: "preparing" }
  | { status: "ready"; url: string }

const idle: TrainPreviewState = { status: "idle" }
const previews = new Map<string, TrainPreviewState>()
const listeners = new Set<() => void>()

const keyFor = (trainId: string, commit: string) => `${trainId}@${commit}`

function set(key: string, state: TrainPreviewState) {
  previews.set(key, state)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function prepareTrainPreview(trainId: string, commit: string) {
  const key = keyFor(trainId, commit)
  if (previews.get(key)?.status === "preparing") return
  set(key, { status: "preparing" })
  try {
    const result = await api.previewTrain(trainId)
    set(key, { status: "ready", url: result.url })
  } catch (caught) {
    set(key, {
      status: "idle",
      error:
        caught instanceof Error
          ? caught.message
          : "Could not start the Train preview.",
    })
  }
}

/** The preview for a Train's current commit. A new Car makes it idle again. */
export function useTrainPreview(
  trainId: string,
  commit: string
): TrainPreviewState {
  const key = keyFor(trainId, commit)
  return useSyncExternalStore(subscribe, () => previews.get(key) ?? idle)
}
