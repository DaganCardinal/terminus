import { z } from "zod"

/**
 * A read-only view of one Terminus commit for people browsing a project:
 * its file inventory and the documents worth reading first. Ephemeral and
 * commit-addressed; never persisted in D1.
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
