import type {
  RepositoryDocument,
  RepositoryFile,
  RepositoryOverview,
} from "@terminus/protocol"
import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  BookOpen,
  ChevronRight,
  File,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  ImageOff,
  Scale,
} from "lucide-react"
import { api } from "@/state/api"
import { routes } from "@/state/route"
import {
  buildTree,
  documentTitle,
  formatBytes,
  groupDocuments,
  isMarkdown,
  resolveLink,
  slugify,
  type TreeNode,
} from "./repository-contents"

/* ── Navigation ─────────────────────────────────────── */

export function DocumentNav({
  networkId,
  overview,
  selected,
}: {
  networkId: string
  overview: RepositoryOverview
  selected: string | null
}) {
  const groups = groupDocuments(overview.documents)
  if (groups.length === 0)
    return <p className="doc-nav-empty">No documents in this commit.</p>
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} className="doc-nav-group">
          <h3>{group.label}</h3>
          <ul>
            {group.documents.map((document) => (
              <li key={document.path}>
                <a
                  href={routes.docs(networkId, document.path)}
                  aria-current={document.path === selected ? "page" : undefined}
                  title={document.path}
                >
                  <DocumentIcon path={document.path} />
                  <span>{documentTitle(document)}</span>
                  {group.label === "Around the codebase" && (
                    <small>
                      {document.path.split("/").slice(0, -1).join("/")}
                    </small>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function DocumentIcon({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  if (/^(license|licence|copying)/i.test(name)) return <Scale size={14} />
  if (/^readme/i.test(name)) return <BookOpen size={14} />
  return <FileText size={14} />
}

const isDocument = (overview: RepositoryOverview, path: string) =>
  overview.documents.some((document) => document.path === path)

export function FileTree({
  networkId,
  overview,
  selected,
}: {
  networkId: string
  overview: RepositoryOverview
  selected: string | null
}) {
  const tree = buildTree(overview.files)
  return (
    <ul className="file-tree" role="tree" aria-label="Files">
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          networkId={networkId}
          overview={overview}
          selected={selected}
        />
      ))}
      {overview.filesTruncated && (
        <li className="file-tree-note">
          Showing the first {overview.files.length} files.
        </li>
      )}
    </ul>
  )
}

function TreeItem({
  node,
  depth,
  networkId,
  overview,
  selected,
}: {
  node: TreeNode
  depth: number
  networkId: string
  overview: RepositoryOverview
  selected: string | null
}) {
  const containsSelection =
    selected !== null && selected.startsWith(`${node.path}/`)
  const [open, setOpen] = useState(containsSelection)
  // Reveal a newly selected file without collapsing anything the user opened.
  const [revealed, setRevealed] = useState(containsSelection)
  if (containsSelection !== revealed) {
    setRevealed(containsSelection)
    if (containsSelection) setOpen(true)
  }
  // Files indent past the chevron so their icons line up with folder icons.
  const indent = {
    paddingLeft: 8 + depth * 14 + (node.kind === "file" ? 18 : 0),
  }

  if (node.kind === "file") {
    const document = isDocument(overview, node.path)
    return (
      <li role="treeitem" aria-selected={node.path === selected}>
        <a
          href={
            document
              ? routes.docs(networkId, node.path)
              : routes.files(networkId, node.path)
          }
          style={indent}
          className={document ? "is-document" : undefined}
          aria-current={node.path === selected ? "page" : undefined}
        >
          {document ? (
            <FileText size={14} />
          ) : /\.(tsx?|jsx?|css|html|json|ya?ml|toml|py|go|rs|sh)$/.test(
              node.name
            ) ? (
            <FileCode size={14} />
          ) : (
            <File size={14} />
          )}
          <span>{node.name}</span>
        </a>
      </li>
    )
  }
  return (
    <li role="treeitem" aria-expanded={open}>
      <button style={indent} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="file-tree-chevron" />
        {open ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{node.name}</span>
      </button>
      {open && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              networkId={networkId}
              overview={overview}
              selected={selected}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/* ── Reading ─────────────────────────────────────────── */

/** The path above whatever is open, so people always know where they are. */
export function ReaderPath({ path, meta }: { path: string; meta?: ReactNode }) {
  const parts = path.split("/")
  return (
    <div className="reader-path">
      <p>
        {parts.map((part, index) => (
          <span
            key={index}
            className={index === parts.length - 1 ? "is-current" : undefined}
          >
            {part}
          </span>
        ))}
      </p>
      {meta && <span className="reader-meta">{meta}</span>}
    </div>
  )
}

export function DocumentView({
  networkId,
  overview,
  document,
}: {
  networkId: string
  overview: RepositoryOverview
  document: RepositoryDocument
}) {
  // Stable component identities, or every re-render would remount the document.
  const components = useMemo(
    () => markdownComponents(networkId, overview, document.path),
    [networkId, overview, document.path]
  )
  return (
    <article className="doc-article">
      {isMarkdown(document.path) ? (
        <div className="doc-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {document.content}
          </ReactMarkdown>
        </div>
      ) : (
        <pre className="doc-plain">{document.content}</pre>
      )}
      {document.truncated && (
        <p className="reader-note">
          This document is long; only its opening is shown here.
        </p>
      )}
    </article>
  )
}

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : ""
    )
    .join("")

function markdownComponents(
  networkId: string,
  overview: RepositoryOverview,
  from: string
): Components {
  const heading =
    (Tag: "h1" | "h2" | "h3" | "h4") =>
    ({ children }: { children?: ReactNode }) => (
      <Tag id={slugify(textOf(children))}>{children}</Tag>
    )
  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    a: ({ href = "", children }) => {
      const target = resolveLink(href, from, overview)
      switch (target.kind) {
        case "external":
          return (
            <a href={target.href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        case "anchor":
          return (
            <a
              href={routes.docs(networkId, from)}
              onClick={(event) => {
                event.preventDefault()
                window.document
                  .getElementById(target.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }}
            >
              {children}
            </a>
          )
        case "document":
          return <a href={routes.docs(networkId, target.path)}>{children}</a>
        case "file":
          return <a href={routes.files(networkId, target.path)}>{children}</a>
        case "missing":
          return (
            <span
              className="doc-dead-link"
              title={`${target.path} isn't in this commit`}
            >
              {children}
            </span>
          )
      }
    },
    img: ({ src, alt }) =>
      typeof src === "string" && /^https:\/\//.test(src) ? (
        <img src={src} alt={alt ?? ""} loading="lazy" />
      ) : (
        <span className="doc-image-missing">
          <ImageOff size={14} aria-hidden="true" />
          {alt || "Image"}
        </span>
      ),
  }
}

const fileCache = new Map<string, Promise<RepositoryFile>>()

/** A committed file the reader fetches on demand; commits never change. */
function useRepositoryFile(networkId: string, commit: string, path: string) {
  const key = `${networkId}\0${commit}\0${path}`
  const [state, setState] = useState<{
    key: string
    file?: RepositoryFile
    error?: string
  }>({ key })

  useEffect(() => {
    let cancelled = false
    let request = fileCache.get(key)
    if (!request) {
      request = api.repositoryFile(networkId, commit, path)
      fileCache.set(key, request)
      request.catch(() => fileCache.delete(key))
    }
    request.then(
      (file) => !cancelled && setState({ key, file }),
      (caught) => !cancelled && setState({ key, error: String(caught) })
    )
    return () => {
      cancelled = true
    }
  }, [key, networkId, commit, path])

  return state.key === key ? state : { key }
}

const MAX_LINES = 5000

export function FileView({
  networkId,
  commit,
  path,
}: {
  networkId: string
  commit: string
  path: string
}) {
  const { file, error } = useRepositoryFile(networkId, commit, path)
  if (error)
    return (
      <div className="reader-state" role="alert">
        <strong>Couldn't open {path}</strong>
        <span>{error}</span>
      </div>
    )
  if (!file)
    return (
      <div className="reader-state" role="status">
        <span className="reader-spinner" aria-hidden="true" />
        Opening {path}…
      </div>
    )
  if (file.content === null)
    return (
      <div className="reader-state">
        <strong>Binary file</strong>
        <span>{formatBytes(file.size)} · not shown in the reader.</span>
      </div>
    )
  const lines = file.content.replace(/\n$/, "").split("\n")
  return (
    <>
      <div className="code-view">
        <table>
          <tbody>
            {lines.slice(0, MAX_LINES).map((line, index) => (
              <tr key={index}>
                <td className="code-line-number">{index + 1}</td>
                <td className="code-line">{line || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(file.truncated || lines.length > MAX_LINES) && (
        <p className="reader-note">
          This file is large; only its opening is shown here.
        </p>
      )}
    </>
  )
}

export function FileMeta({
  overview,
  path,
}: {
  overview: RepositoryOverview
  path: string
}) {
  const entry = overview.files.find((file) => file.path === path)
  return entry ? <>{formatBytes(entry.size)}</> : null
}
