'use client'

import type { ReactNode } from 'react'
import { AdminProviders } from '@/components/admin/feedback'

/**
 * Admin pages call `useToast()` / `useConfirm()` in the page component itself,
 * so the providers must sit above the page, not inside AdminShell.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminProviders>{children}</AdminProviders>
}
