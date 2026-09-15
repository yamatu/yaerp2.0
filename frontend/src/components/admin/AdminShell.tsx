'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { ADMIN_MODULES } from '@/components/nav/appModules'
import { getStoredUser } from '@/lib/auth'

// The admin navigation is derived from the shared module registry so a new admin
// page only has to be registered once (menu, command palette and shell agree).

/**
 * A module stays highlighted on its sub-pages, except `/admin` itself which must
 * not light up for every child route.
 */
export function isModuleActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  return href !== '/admin' && pathname.startsWith(`${href}/`)
}

interface AdminShellProps {
  title: string
  description: string
  children: ReactNode
  summary?: ReactNode
}

export function AdminShell({ title, description, children, summary }: AdminShellProps) {
  const pathname = usePathname()
  const profile = getStoredUser()

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-slate-100 p-3 md:p-5">
        <div className="mx-auto max-w-[1440px] space-y-3">
          <header className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <Link href="/" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900" title="返回业务工作台">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-slate-950">{title}</h1>
                  <p className="mt-0.5 truncate text-sm text-slate-500">{description}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-400">管理员</span>
                <span className="max-w-40 truncate font-semibold text-slate-800">{profile?.username || 'admin'}</span>
              </div>
            </div>

            <nav className="flex min-w-0 gap-1 overflow-x-auto border-t border-slate-200 bg-slate-50 px-3 py-2 [scrollbar-width:none] md:px-4">
              {ADMIN_MODULES.map((module) => {
                const Icon = module.icon
                const active = isModuleActive(pathname, module.href)
                return (
                  <Link
                    key={module.href}
                    href={module.href}
                    title={module.description}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition ${active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-white hover:text-slate-950'}`}
                  >
                    <Icon className="h-4 w-4" />
                    {module.label}
                  </Link>
                )
              })}
            </nav>
          </header>

          {summary && <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">{summary}</section>}
          <main className="space-y-3">{children}</main>
        </div>
      </div>
    </AuthGuard>
  )
}
