import type { RepositoryChangeFile } from "@terminus/protocol"
import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@terminus/ui/components/button"
import {
  changesKey,
  loadChanges,
  loadChangeFile,
  type ChangesTarget,
} from "@/state/changes"
import { shortCommit } from "./detail-parts"

/** Mount readers only after opening the section/file; polling never fetches patches. */
export function Changes({
  target,
  description,
}: {
  target: ChangesTarget
  description: string
}) {
  return (
    <ChangesSection
      key={changesKey(target)}
      target={target}
      description={description}
    />
  )
}

function ChangesSection({
  target,
  description,
}: {
  target: ChangesTarget
  description: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="changes"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Changes</summary>
      {open && <ChangesList target={target} description={description} />}
    </details>
  )
}

type ReadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string }

function useChangesRead<T>(read: () => Promise<T>) {
  const [state, setState] = useState<ReadState<T>>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    void read().then(
      (value) => {
        if (active) setState({ status: "ready", value })
      },
      (error: unknown) => {
        if (active)
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not load changes.",
          })
      }
    )
    return () => {
      active = false
    }
  }, [read, attempt])
  return {
    state,
    retry: () => {
      setState({ status: "loading" })
      setAttempt((attempt) => attempt + 1)
    },
  }
}

function ReadFeedback({
  state,
  retry,
}: {
  state: ReadState<unknown>
  retry: () => void
}) {
  if (state.status === "loading")
    return (
      <p className="changes-loading" role="status">
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />{" "}
        Loading changes…
      </p>
    )
  if (state.status === "error")
    return (
      <div className="changes-error" role="alert">
        <p>{state.message}</p>
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
      </div>
    )
  return null
}

function ChangesList({
  target,
  description,
}: {
  target: ChangesTarget
  description: string
}) {
  // Capture this mounted reader's immutable target once so ordinary snapshot polling is inert.
  const [read] = useState(() => () => loadChanges(target))
  const { state, retry } = useChangesRead(read)
  return (
    <div className="changes-list">
      <p className="detail-note">{description}</p>
      <p className="changes-commits">
        <code title={target.base}>{shortCommit(target.base)}</code> →{" "}
        <code title={target.head}>{shortCommit(target.head)}</code>
      </p>
      <ReadFeedback state={state} retry={retry} />
      {state.status === "ready" && (
        <>
          <p className="detail-note">
            {state.value.files.length === 0
              ? state.value.filesTruncated
                ? "No changed files listed within the browsing limit."
                : "No file changes."
              : `${state.value.files.length}${state.value.filesTruncated ? "+" : ""} changed ${state.value.files.length === 1 ? "file" : "files"}`}
          </p>
          {state.value.filesTruncated && (
            <p className="changes-warning" role="status">
              The file list exceeds the browsing limit. Some changes are
              omitted.
            </p>
          )}
          {state.value.files.map((file) => (
            <ChangeFileSection
              key={file.path}
              target={target}
              path={file.path}
              kind={file.kind}
            />
          ))}
        </>
      )}
    </div>
  )
}

function ChangeFileSection({
  target,
  path,
  kind,
}: {
  target: ChangesTarget
  path: string
  kind: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="change-file"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{path}</span>
        <small>{kind}</small>
      </summary>
      {open && <ChangeFile target={target} path={path} />}
    </details>
  )
}

function ChangeFile({ target, path }: { target: ChangesTarget; path: string }) {
  const [read] = useState(() => () => loadChangeFile(target, path))
  const { state, retry } = useChangesRead(read)
  return state.status === "ready" ? (
    <FilePatch value={state.value} />
  ) : (
    <ReadFeedback state={state} retry={retry} />
  )
}

export function FilePatch({ value }: { value: RepositoryChangeFile }) {
  const { file, status, hunks } = value
  const modeChanged =
    file.beforeMode !== null &&
    file.afterMode !== null &&
    file.beforeMode !== file.afterMode
  return (
    <div className="change-patch">
      {modeChanged && (
        <p className="detail-note">
          File mode: {file.beforeMode} → {file.afterMode}
        </p>
      )}
      {status !== "text" ? (
        <p className="detail-note">
          {status === "binary"
            ? "Binary file changed. A text diff is unavailable."
            : status === "too_large"
              ? "This change exceeds the size or complexity limit for inline diffs."
              : "Symlink or submodule changed. A text diff is unavailable."}
        </p>
      ) : hunks.length === 0 ? (
        <p className="detail-note">
          {file.kind === "added"
            ? "Empty file added."
            : file.kind === "deleted"
              ? "Empty file deleted."
              : "File contents are unchanged; only metadata changed."}
        </p>
      ) : (
        <pre
          className="change-diff"
          tabIndex={0}
          aria-label={`Diff for ${file.path}`}
        >
          <code>
            {hunks.map((hunk, index) => (
              <span className="diff-hunk" key={index}>
                <span className="diff-header">{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</span>
                {hunk.lines.map((line, index) => (
                  <span
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "diff-add"
                        : line.startsWith("-")
                          ? "diff-remove"
                          : "diff-context"
                    }
                  >
                    {line}
                  </span>
                ))}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  )
}
