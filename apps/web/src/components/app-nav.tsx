import { ChevronRight } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import { AppMenu } from "@/components/app-menu"
import { routes } from "@/state/route"
import logomark from "@/assets/terminus-logomark.svg"
import logomarkWhite from "@/assets/terminus-logomark-white.svg"

/** The app bar for pages outside the map, with a breadcrumb trail. */
export function AppNav({
  trail = [],
  settingsHref = routes.settings(),
  children,
}: {
  /** Ancestors then the current page; the last item is not a link. */
  trail?: { label: string; href?: string }[]
  /** Where the menu's Settings item goes; a network page opens its own. */
  settingsHref?: string
  children?: ReactNode
}) {
  return (
    <nav className="app-nav" aria-label="Main navigation">
      <a href={routes.networks()} className="app-brand">
        <span className="app-logomark" aria-hidden="true">
          <img
            className="logomark-light"
            src={logomark}
            alt=""
            width="36"
            height="36"
          />
          <img
            className="logomark-dark"
            src={logomarkWhite}
            alt=""
            width="36"
            height="36"
          />
        </span>
        terminus<span className="brand-dot">.</span>
      </a>
      {trail.length > 0 ? (
        <ol className="app-trail">
          {trail.map((crumb, index) => (
            <Fragment key={index}>
              <li aria-hidden="true">
                <ChevronRight size={14} />
              </li>
              <li>
                {crumb.href ? (
                  <a href={crumb.href}>{crumb.label}</a>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      ) : (
        <span className="app-nav-label">Agent railway network</span>
      )}
      <div className="app-nav-end">
        {children}
        <AppMenu variant="nav" settingsHref={settingsHref} />
      </div>
    </nav>
  )
}
