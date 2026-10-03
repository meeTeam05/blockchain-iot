// Ported from app_new/src/components/shell/AtmosphereAppBar.tsx, restyled
// to match the Warden mockup header bar layout: single unified white bar
// with logo mark, concise navigation pills (Thiết bị, Ví Token, Keeper, Tham số),
// and actions on the right rail. No ugly slashes or duplicated raw navbars.
import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link, NavLink, useInRouterContext } from 'react-router'
import { DotLogo } from './DotLogo'
import { incentivesDeployment } from '../../lib/incentives'

type AppBarProps =
  | { variant: 'brand'; actions?: ReactNode; showNav?: boolean }
  | { variant: 'back'; title: string; actions?: ReactNode; onBack: () => void }

function BrandLogo() {
  const inRouter = useInRouterContext()
  const content = (
    <div className="flex items-center gap-2.5">
      <DotLogo size={24} color="#1fe07a" />
      <span className="text-base font-bold tracking-wide text-ink uppercase">smart air</span>
    </div>
  )
  if (!inRouter) return content
  return (
    <Link to="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-85">
      {content}
    </Link>
  )
}

function NavItem({ to, label, end = false }: { to: string; label: string; end?: boolean }) {
  const inRouter = useInRouterContext()
  if (!inRouter) {
    return (
      <span className="rounded-pill bg-line-2 px-3 py-1.5 font-medium text-ink">
        {label}
      </span>
    )
  }
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        isActive
          ? 'rounded-pill bg-line-2 px-3.5 py-1.5 font-semibold text-ink shadow-2xs'
          : 'rounded-pill px-3.5 py-1.5 font-medium text-ink-2 hover:bg-canvas hover:text-ink transition-colors'
      }
    >
      {label}
    </NavLink>
  )
}

export function AppBar(props: AppBarProps) {
  if (props.variant === 'brand') {
    const showNav = props.showNav ?? true
    return (
      <header className="flex h-14 items-center justify-between border-b border-line bg-paper px-6 shadow-2xs">
        <div className="flex items-center gap-7">
          <BrandLogo />
          {showNav ? (
            <nav className="flex items-center gap-1.5 text-[13.5px]" aria-label="Incentives navigation">
              <NavItem to="/" label="Thiết bị" end />
              {incentivesDeployment ? (
                <>
                  <NavItem to="/wallet" label="Ví Token" />
                  <NavItem to="/keeper" label="Keeper" />
                  <NavItem to="/params" label="Tham số" />
                </>
              ) : null}
            </nav>
          ) : null}
        </div>
        <div className="flex items-center gap-2">{props.actions}</div>
      </header>
    )
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-line bg-paper px-6 shadow-2xs">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={props.onBack}
          className="-m-2 mr-1 rounded-xl p-2 text-ink transition-colors hover:bg-canvas"
          aria-label="Quay lại"
        >
          <ArrowLeft className="size-[20px]" aria-hidden />
        </button>
        <span className="truncate text-[16px] font-bold text-ink">{props.title}</span>
      </div>
      <div className="flex items-center gap-2">{props.actions}</div>
    </header>
  )
}
