'use client'

import { Archive, ArrowLeft, Database, Download, FileJson } from 'lucide-react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

interface BackupCard {
  key: string
  icon: React.ReactNode
  iconBg: string
  iconColor: string
  title: string
  description: string
  endpoint: string
  filename: string
}

const backupCards: BackupCard[] = [
  {
    key: 'database',
    icon: <Database className="h-5 w-5" />,
    iconBg: 'bg-sky-100',
    iconColor: 'text-sky-700',
    title: '数据库备份',
    description: '导出完整的数据库 SQL 转储文件，包含所有表结构和数据记录，可用于数据库恢复和迁移。',
    endpoint: '/admin/backup/database',
    filename: 'database-backup.sql',
  },
  {
    key: 'config',
    icon: <FileJson className="h-5 w-5" />,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-700',
    title: '配置导出',
    description: '导出系统配置信息为 JSON 格式，包含角色权限、系统参数等配置项，便于环境迁移和版本管理。',
    endpoint: '/admin/backup/config',
    filename: 'config-export.json',
  },
  {
    key: 'combined',
    icon: <Archive className="h-5 w-5" />,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-700',
    title: '完整备份',
    description: '打包下载数据库与配置的完整备份压缩包（tar.gz），适用于整体环境备份和灾难恢复场景。',
    endpoint: '/admin/backup/combined',
    filename: 'full-backup.tar.gz',
  },
]

export default function BackupPage() {
  const router = useRouter()
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const handleDownload = async (card: BackupCard) => {
    setLoadingKey(card.key)
    setError('')
    setSuccess('')

    try {
      const token = typeof window !== 'undefined'
        ? localStorage.getItem('access_token')
        : null

      const res = await fetch(`${API_BASE}${card.endpoint}`, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (!res.ok) {
        throw new Error(`下载失败，服务器返回状态码 ${res.status}`)
      }

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = card.filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      setSuccess(`${card.title}下载成功`)
    } catch (err) {
      console.error(`Failed to download ${card.key}:`, err)
      setError(err instanceof Error ? err.message : `${card.title}下载失败，请稍后重试`)
    } finally {
      setLoadingKey(null)
    }
  }

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-4 p-3 md:p-6">
          <header className="overflow-hidden rounded-[32px] border border-white/70 bg-white/80 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.7)] backdrop-blur">
            <div className="flex flex-col gap-6 px-4 py-5 md:px-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <button
                  type="button"
                  onClick={() => router.push('/')}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
                >
                  <ArrowLeft className="h-4 w-4" />
                  返回工作台
                </button>
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                    <Database className="h-3.5 w-3.5" />
                    Admin Backup
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                    数据库与配置备份
                  </h1>
                  <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                    管理员可以在这里下载数据库备份、系统配置导出文件或完整备份包，确保数据安全和系统可恢复性。
                  </p>
                </div>
              </div>
            </div>
          </header>

          {error && (
            <div className="rounded-[28px] border border-rose-200 bg-rose-50/90 px-5 py-4 text-sm font-medium text-rose-700 backdrop-blur">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-[28px] border border-emerald-200 bg-emerald-50/90 px-5 py-4 text-sm font-medium text-emerald-700 backdrop-blur">
              {success}
            </div>
          )}

          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-6">
              <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                Download Center
              </div>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">选择备份类型</h2>
              <p className="mt-2 text-sm text-slate-500">
                根据需要选择对应的备份方式，点击下载按钮即可获取备份文件。
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {backupCards.map((card) => {
                const isLoading = loadingKey === card.key
                const isDisabled = loadingKey !== null

                return (
                  <div
                    key={card.key}
                    className="flex flex-col rounded-[28px] border border-slate-200 bg-white/95 p-5 shadow-sm transition hover:shadow-md"
                  >
                    <div
                      className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl ${card.iconBg} ${card.iconColor}`}
                    >
                      {card.icon}
                    </div>
                    <h3 className="text-lg font-semibold text-slate-950">{card.title}</h3>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-500">
                      {card.description}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleDownload(card)}
                      disabled={isDisabled}
                      className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Download className="h-4 w-4" />
                      {isLoading ? '下载中...' : '下载备份'}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </AuthGuard>
  )
}
