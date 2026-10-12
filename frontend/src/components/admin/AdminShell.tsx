'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CircleHelp, Shield } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { getStoredUser } from '@/lib/auth'
import { findActiveAdminModule, groupedAdminModules, isModuleActive } from './adminNav'
import { AdminProviders } from './feedback'
import { HelpPanel, type HelpContent } from './HelpPanel'

// Kept as a re-export: older imports pull it from the shell.
export { isModuleActive }

interface AdminShellProps {
  title: string
  description: string
  children: ReactNode
  /** Optional block rendered above the page content (legacy; prefer StatGrid in children). */
  summary?: ReactNode
  /** Page-level "使用说明" content; renders the help button + collapsible panel. */
  help?: HelpContent
  /** Primary page actions shown in the header (right side). */
  actions?: ReactNode
}

const HELP_STORAGE_PREFIX = 'yaerp.admin.help:'

function useHelpState(pathname: string) {
  // First visit of a page on desktop: expanded, so new admins see the
  // explanation. After that the admin's last choice is remembered per page.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(HELP_STORAGE_PREFIX + pathname)
      // On phones the panel starts collapsed (its summary line stays visible).
      setOpen(stored === null ? window.matchMedia('(min-width: 768px)').matches : stored === '1')
    } catch {
      setOpen(false)
    }
  }, [pathname])
  const update = useCallback(
    (next: boolean) => {
      setOpen(next)
      try {
        window.localStorage.setItem(HELP_STORAGE_PREFIX + pathname, next ? '1' : '0')
      } catch {
        // storage may be unavailable (private mode); state still works in memory
      }
    },
    [pathname],
  )
  return [open, update] as const
}

/** Phone / tablet: module nav as a horizontal scroller with 40px chips. */
function MobileModuleNav({ pathname }: { pathname: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const groups = groupedAdminModules()

  // Centre the active chip. This component only mounts once the auth guard has
  // let the shell render, so the ref is always attached when the effect runs.
  useEffect(() => {
    const scroller = scrollerRef.current
    const active = scroller?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!scroller || !active) return
    scroller.scrollLeft = active.offsetLeft - (scroller.clientWidth - active.offsetWidth) / 2
  }, [pathname])

  return (
    <nav aria-label="后台模块" className="border-t border-slate-100 lg:hidden">
      <div ref={scrollerRef} className="relative flex gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.flatMap((group, groupIndex) => [
          groupIndex > 0 ? <span key={`${group.id}-sep`} aria-hidden className="my-2 w-px shrink-0 bg-slate-200" /> : null,
          ...group.modules.map((module) => {
            const Icon = module.icon
            const active = isModuleActive(pathname, module.href)
            return (
              <Link
                key={module.id}
                href={module.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition [-webkit-tap-highlight-color:transparent] ${active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 active:bg-slate-200'}`}
              >
                <Icon className="h-4 w-4" />
                {module.id === 'admin' ? '总览' : module.label}
              </Link>
            )
          }),
        ])}
      </div>
    </nav>
  )
}

export function AdminShell({ title, description, children, summary, help, actions }: AdminShellProps) {
  const pathname = usePathname() || '/admin'
  const [profileName, setProfileName] = useState('')
  const [helpOpen, setHelpOpen] = useHelpState(pathname)
  const activeModule = findActiveAdminModule(pathname)
  const TitleIcon = activeModule?.icon || Shield
  const groups = groupedAdminModules()

  useEffect(() => {
    setProfileName(getStoredUser()?.username || '')
  }, [])

  const openHelp = () => {
    setHelpOpen(true)
    window.setTimeout(() => document.getElementById('admin-help')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
  }

  return (
    <AuthGuard requireRole="admin">
      <AdminProviders>
        <>
          <div className="min-h-screen bg-slate-100 text-slate-900">
            <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
              <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between gap-3 px-3 py-2 md:px-5">
                <div className="flex min-w-0 items-center gap-3">
                  <Link
                    href="/"
                    className="ui-tooltip inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 md:h-9 md:w-9"
                    title="返回业务工作台"
                    aria-label="返回业务工作台"
                    data-tooltip="返回业务工作台"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Link>
                  <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white sm:flex">
                    <TitleIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="truncate text-base font-semibold md:text-lg">{title}</h1>
                    <p className="truncate text-xs text-slate-500">{description}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {actions}
                  {help && (
                    <button
                      type="button"
                      onClick={() => (helpOpen ? setHelpOpen(false) : openHelp())}
                      aria-pressed={helpOpen}
                      className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition md:h-9 ${helpOpen ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                    >
                      <CircleHelp className="h-4 w-4" />
                      <span className="hidden sm:inline">使用说明</span>
                    </button>
                  )}
                  {profileName && (
                    <span className="hidden items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-500 xl:inline-flex">
                      管理员<strong className="max-w-28 truncate font-semibold text-slate-800">{profileName}</strong>
                    </span>
                  )}
                </div>
              </div>

              <MobileModuleNav pathname={pathname} />
            </header>

            <div className="mx-auto flex max-w-[1600px] gap-4 p-3 md:p-5">
              {/* Desktop: grouped sidebar. */}
              <aside className="hidden w-60 shrink-0 lg:block">
                <nav aria-label="后台模块" className="sticky top-[84px] space-y-4 rounded-lg border border-slate-200 bg-white p-3">
                  {groups.map((group) => (
                    <div key={group.id}>
                      {group.id !== 'overview' && <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>}
                      <div className="space-y-0.5">
                        {group.modules.map((module) => {
                          const Icon = module.icon
                          const active = isModuleActive(pathname, module.href)
                          return (
                            <Link
                              key={module.id}
                              href={module.href}
                              title={module.description}
                              aria-current={active ? 'page' : undefined}
                              className={`flex h-9 items-center gap-2.5 rounded-lg px-2 text-sm font-medium transition ${active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
                            >
                              <Icon className={`h-4 w-4 shrink-0 ${active ? '' : 'text-slate-400'}`} />
                              <span className="truncate">{module.id === 'admin' ? '后台总览' : module.label}</span>
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              </aside>

              <main className="min-w-0 flex-1 space-y-3">
                {help && <HelpPanel content={help} open={helpOpen} onToggle={() => setHelpOpen(!helpOpen)} />}
                {summary && <section className="rounded-lg border border-slate-200 bg-white p-4">{summary}</section>}
                {children}
              </main>
            </div>
          </div>
        </>
      </AdminProviders>
    </AuthGuard>
  )
}
