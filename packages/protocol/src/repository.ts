import { z } from "zod"

/**
 * A read-only view of one Terminus commit for people browsing a project:
 * its file inventory and the documents worth reading first. Commit-addressed,
 * so the Worker caches each one in D1 after its first read.
 */
export const repositoryEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
})
export type RepositoryEntry = z.infer<typeof repositoryEntrySchema>

export const repositoryDocumentSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
})
export type RepositoryDocument = z.infer<typeof repositoryDocumentSchema>

export const repositoryOverviewSchema = z.object({
  commit: z.string(),
  files: z.array(repositoryEntrySchema),
  filesTruncated: z.boolean(),
  documents: z.array(repositoryDocumentSchema),
})
export type RepositoryOverview = z.infer<typeof repositoryOverviewSchema>

export const repositoryFileSchema = z.object({
  commit: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  /** Null when the file is binary. */
  content: z.string().nullable(),
  truncated: z.boolean(),
})
export type RepositoryFile = z.infer<typeof repositoryFileSchema>

export const repositoryFileQuerySchema = z.object({
  commit: z.string().min(1).max(100),
  path: z.string().min(1).max(1024),
})

/** Read-only comparisons of exact accepted snapshots; never persisted for browsing. */
export const repositoryChangesQuerySchema = z.object({
  base: z.string().min(1).max(100),
  head: z.string().min(1).max(100),
})
export const repositoryChangeFileQuerySchema =
  repositoryChangesQuerySchema.extend({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          !path.includes("\0") &&
          path
            .split("/")
            .every((part) => part && part !== "." && part !== ".."),
        "Expected a repository-relative file path"
      ),
  })

export const repositoryChangeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "deleted", "modified"]),
  beforeMode: z.string().nullable(),
  afterMode: z.string().nullable(),
})
export type RepositoryChangeEntry = z.infer<typeof repositoryChangeEntrySchema>

export const repositoryChangesSchema = repositoryChangesQuerySchema.extend({
  files: z.array(repositoryChangeEntrySchema),
  filesTruncated: z.boolean(),
})
export type RepositoryChanges = z.infer<typeof repositoryChangesSchema>

export const repositoryChangeFileSchema = repositoryChangesQuerySchema.extend({
  file: repositoryChangeEntrySchema,
  status: z.enum(["text", "binary", "too_large", "unsupported"]),
  beforeSize: z.number().int().nonnegative().nullable(),
  afterSize: z.number().int().nonnegative().nullable(),
  hunks: z.array(
    z.object({
      oldStart: z.number().int().nonnegative(),
      oldLines: z.number().int().nonnegative(),
      newStart: z.number().int().nonnegative(),
      newLines: z.number().int().nonnegative(),
      lines: z.array(z.string()),
    })
  ),
})
export type RepositoryChangeFile = z.infer<typeof repositoryChangeFileSchema>
