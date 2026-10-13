import { z } from "zod"

/**
 * The network's publish repository and the canonical commit it serves. A
 * deployment such as Workers Builds watches this repository, so only an
 * explicit publish changes what is live; promotion into Terminus does not.
 */
export const terminusPublicationSchema = z.object({
  repoId: z.string().min(1),
  commit: z.string().min(1),
  publishedAt: z.string(),
  /** Where the user says the deployment serves it. Information only. */
  siteUrl: z.url({ protocol: /^https$/ }).optional(),
})
export type TerminusPublication = z.infer<typeof terminusPublicationSchema>

/** Publishes the displayed canonical commit. Commit identities are opaque
 * here, as for previews; live repositories require a full Git hash. */
export const publishTerminusRequestSchema = z
  .object({ commit: z.string().min(1).max(200) })
  .strict()
export type PublishTerminusRequest = z.infer<
  typeof publishTerminusRequestSchema
>

/** Records, or with null clears, the live site URL shown with the publication. */
export const setPublishedSiteRequestSchema = z
  .object({
    siteUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .nullable(),
  })
  .strict()
export type SetPublishedSiteRequest = z.infer<
  typeof setPublishedSiteRequestSchema
>
