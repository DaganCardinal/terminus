import { EllipsisVertical, Moon, Settings } from "lucide-react"
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { cn } from "@terminus/ui/lib/utils"
import { useTheme } from "@/components/theme-provider"
import { useMediaQuery } from "@/components/use-media-query"

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * The app's overflow menu: appearance and settings, with room for more.
 * `map` floats over the network map; `nav` sits in the app bar.
 */
export function AppMenu({
  variant,
  settingsHref,
}: {
  variant: "map" | "nav"
  settingsHref: string
}) {
  const { theme, setTheme } = useTheme()
  const systemDark = useMediaQuery(DARK_QUERY)
  const dark = theme === "dark" || (theme === "system" && systemDark)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointer)
    return () => document.removeEventListener("pointerdown", onPointer)
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  const onMenuKey = (event: KeyboardEvent) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ??
        []),
    ]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const move = (to: number) => {
      event.preventDefault()
      items.at(to % items.length)?.focus()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    } else if (event.key === "ArrowDown") move(index + 1)
    else if (event.key === "ArrowUp") move(index - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(-1)
    else if (event.key === "Tab") setOpen(false)
  }

  return (
    <div ref={root} className={cn("app-menu", `app-menu-${variant}`)}>
      <button
        ref={trigger}
        className={variant === "map" ? "overlay-button glass" : "theme-button"}
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <EllipsisVertical size={variant === "map" ? 16 : 17} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="More options"
          className={cn("app-menu-popover", variant === "map" && "glass")}
          onKeyDown={onMenuKey}
        >
          <button
            role="menuitemcheckbox"
            aria-checked={dark}
            className="app-menu-item"
            onClick={() => setTheme(dark ? "light" : "dark")}
          >
            <Moon size={15} aria-hidden="true" />
            <span>Dark mode</span>
            <i className="app-menu-switch" aria-hidden="true" />
          </button>
          <div role="separator" className="app-menu-separator" />
          <a
            role="menuitem"
            className="app-menu-item"
            href={settingsHref}
            onClick={() => setOpen(false)}
          >
            <Settings size={15} aria-hidden="true" />
            <span>Settings</span>
          </a>
        </div>
      )}
    </div>
  )
}
