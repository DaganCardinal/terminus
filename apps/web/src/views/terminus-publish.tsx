import { useState } from "react"
import { ArrowUpRight, CloudUpload, LoaderCircle } from "lucide-react"
import type { NetworkSummary } from "@terminus/protocol"
import { Button, buttonVariants } from "@terminus/ui/components/button"
import { cn } from "@terminus/ui/lib/utils"
import { useNow } from "@/components/use-now"
import { api } from "@/state/api"
import { shortCommit } from "./detail-parts"
import { relativeTime } from "./network-presentation"

/**
 * Publishes the current canonical commit to the network's publish repository.
 * Workers Builds (or any deployment) watches that repository, so only this
 * explicit action changes what is live. The published commit arrives with the
 * next snapshot; this component only tracks its own request.
 */
export function TerminusPublish({
  network,
  newerTrains,
}: {
  network: NetworkSummary
  /** Trains unloaded into Terminus since the last publish. */
  newerTrains: number
}) {
  const now = useNow(60_000)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The URL changes no railway state, so no event reloads the snapshot.
  const [savedSite, setSavedSite] = useState<string | null>()
  const publication = network.publication && {
    ...network.publication,
    siteUrl:
      savedSite === undefined
        ? network.publication.siteUrl
        : (savedSite ?? undefined),
  }
  const current = publication?.commit === network.terminusCommit

  const publish = async () => {
    setPublishing(true)
    setError(null)
    try {
      await api.publishTerminus(network.id, network.terminusCommit)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not publish Terminus."
      )
    } finally {
      setPublishing(false)
    }
  }

  return (
    <section className="detail-section terminus-publish">
      <h3>Publishing</h3>
      {publication ? (
        <p>
          Published{" "}
          <code title={publication.commit}>
            {shortCommit(publication.commit)}
          </code>{" "}
          {relativeTime(publication.publishedAt, now)}.{" "}
          {current
            ? "Up to date with Terminus."
            : newerTrains > 0
              ? `${newerTrains} ${newerTrains === 1 ? "Train has" : "Trains have"} unloaded since.`
              : "Terminus has moved on since."}
        </p>
      ) : (
        <p>
          Publish this snapshot to the network&apos;s publish repository.
          Connect that repository to Workers Builds to deploy every publish.
        </p>
      )}
      <div className="terminus-publish-actions">
        {!current && (
          <Button
            size="sm"
            disabled={publishing}
            onClick={() => void publish()}
          >
            {publishing ? (
              <LoaderCircle className="animate-spin" size={16} />
            ) : (
              <CloudUpload size={16} />
            )}
            {publishing
              ? "Publishing…"
              : publication
                ? "Publish current snapshot"
                : "Publish snapshot"}
          </Button>
        )}
        {publication?.siteUrl && (
          <a
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            href={publication.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open live site
            <ArrowUpRight size={15} />
          </a>
        )}
      </div>
      {error && (
        <p className="detail-note" role="alert">
          {error}
        </p>
      )}
      {publication && (
        <PublishedSite
          networkId={network.id}
          repoId={publication.repoId}
          siteUrl={publication.siteUrl}
          onSaved={setSavedSite}
        />
      )}
    </section>
  )
}

/** Where to connect Workers Builds, and the live URL it reports back. */
function PublishedSite({
  networkId,
  repoId,
  siteUrl,
  onSaved,
}: {
  networkId: string
  repoId: string
  siteUrl?: string
  onSaved: (siteUrl: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(siteUrl ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = value.trim() || null
      await api.setPublishedSite(networkId, next)
      onSaved(next)
      setEditing(false)
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save the URL."
      )
    } finally {
      setSaving(false)
    }
  }

  const [namespace, name] = repoId.split("/")
  return (
    <>
      <p className="detail-note">
        Artifacts repository <code>{name}</code> in namespace{" "}
        <code>{namespace}</code>. In Workers &amp; Pages, create an application
        with <strong>Continue with Artifacts</strong> and select it.
      </p>
      {editing ? (
        <form
          className="terminus-publish-site"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="field">
            <span>Live site URL</span>
            <input
              type="url"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="https://my-app.example.workers.dev"
            />
          </label>
          <div className="terminus-publish-actions">
            <Button size="sm" type="submit" disabled={saving}>
              Save
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
          {error && (
            <p className="detail-note" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {siteUrl ? "Change live site URL" : "Add live site URL"}
        </Button>
      )}
    </>
  )
}
