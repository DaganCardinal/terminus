import type {
  RepositoryChangeFile,
  RepositoryChanges,
} from "@terminus/protocol"
import { api } from "./api"

export interface ChangesTarget {
  trainId: string
  carId?: string
  base: string
  head: string
}

// Session-only, bounded caches, keyed by entity and exact commits. Failures can be retried.
const lists = new Map<string, Promise<RepositoryChanges>>()
const files = new Map<string, Promise<RepositoryChangeFile>>()
const MAX_CACHED = 80

export function changesKey(target: ChangesTarget): string {
  return JSON.stringify([
    target.trainId,
    target.carId ?? null,
    target.base,
    target.head,
  ])
}

function cached<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  let pending = cache.get(key)
  if (pending) {
    cache.delete(key)
    cache.set(key, pending)
    return pending
  }
  pending = read().catch((error: unknown) => {
    if (cache.get(key) === pending) cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return pending
}

export function loadChanges(target: ChangesTarget): Promise<RepositoryChanges> {
  return cached(lists, changesKey(target), () =>
    api.changes(target.trainId, target.base, target.head, target.carId)
  )
}

export function loadChangeFile(
  target: ChangesTarget,
  path: string
): Promise<RepositoryChangeFile> {
  return cached(files, JSON.stringify([changesKey(target), path]), () =>
    api.changeFile(target.trainId, target.base, target.head, path, target.carId)
  )
}
