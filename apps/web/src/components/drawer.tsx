import { useEffect, useRef, type ReactNode } from "react"
import { Maximize2, Minimize2, X } from "lucide-react"

/** A panel over the map: from the right on desktop, from the bottom on
 * mobile. Non-modal, so the map stays usable beside it. */
export function Drawer({
  label,
  heading,
  expanded,
  onExpandedChange,
  onClose,
  children,
}: {
  label: string
  heading: ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [label])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]"))
        onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      className={`drawer ${expanded ? "drawer-expanded" : ""}`}
      aria-label={label}
    >
      <div className="drawer-grip" aria-hidden="true" />
      <header className="drawer-header">
        <div className="drawer-heading">{heading}</div>
        <button
          className="drawer-expand"
          onClick={() => onExpandedChange(!expanded)}
          aria-label={expanded ? "Collapse panel" : "Expand panel"}
          aria-pressed={expanded}
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button onClick={onClose} aria-label="Close panel">
          <X size={17} />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>
  )
}
