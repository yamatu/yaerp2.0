'use client'

import { ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  clearTokens,
  fetchCurrentUser,
  getStoredUser,
  hasRole,
  isAuthenticated,
} from '@/lib/auth'
import type { AuthUser } from '@/types'

interface AuthGuardProps {
  children: React.ReactNode
  requireRole?: string
}

export function AuthGuard({ children, requireRole }: AuthGuardProps) {
  const router = useRouter()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let mounted = true

    async function verify() {
      if (!isAuthenticated()) {
        clearTokens()
        router.replace('/login')
        return
      }

      let user: AuthUser | null = getStoredUser()

      if (!user) {
        try {
          user = await fetchCurrentUser()
        } catch {
          clearTokens()
          router.replace('/login')
          return
        }
      }

      if (!user) {
        clearTokens()
        router.replace('/login')
        return
      }

      if (requireRole && !hasRole(user, requireRole)) {
        router.replace('/')
        return
      }

      if (mounted) {
        setChecked(true)
      }
    }

    verify()

    return () => {
      mounted = false
    }
  }, [requireRole, router])

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)] px-6">
        <div className="rounded-[28px] border border-white/80 bg-white/90 px-8 py-10 text-center shadow-[0_24px_80px_-48px_rgba(15,23,42,0.65)] backdrop-blur">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-white">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div className="mb-2 text-sm font-semibold uppercase tracking-[0.24em] text-sky-600">
            Security
          </div>
          <div className="text-lg font-semibold text-slate-900">正在验证身份...</div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}
