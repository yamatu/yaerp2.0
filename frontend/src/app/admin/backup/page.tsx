'use client'

import { AlertTriangle, Archive, ArrowLeft, Database, Download, FileJson, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'

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
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [restoreConfirmed, setRestoreConfirmed] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const restoreInputRef = useRef<HTMLInputElement>(null)

  const getToken = () => (typeof window !== 'undefined' ? localStorage.getItem('access_token') : null)

  const handleDownload = async (card: BackupCard) => {
    setLoadingKey(card.key)
    setError('')
    setSuccess('')

    try {
      const token = getToken()

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

  const handleRestore = async () => {
    if (!restoreFile) {
      setError('请先选择一个数据库备份文件')
      return
    }

    if (!restoreConfirmed) {
      setError('请先确认你知道还原会覆盖当前数据库')
      return
    }

    if (!window.confirm('数据库还原会覆盖当前全部数据，确定继续吗？')) {
      return
    }

    setRestoring(true)
    setError('')
    setSuccess('')

    try {
      const token = getToken()
      const formData = new FormData()
      formData.append('file', restoreFile)

      const res = await fetch(`${API_BASE}/admin/backup/restore`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })

      const data = await res.json() as { code?: number; message?: string }
      if (!res.ok || data.code !== 0) {
        throw new Error(data.message || `还原失败，服务器返回状态码 ${res.status}`)
      }

      setSuccess('数据库还原成功，建议重新登录并检查关键数据。')
      setRestoreFile(null)
      setRestoreConfirmed(false)
      if (restoreInputRef.current) {
        restoreInputRef.current.value = ''
      }
    } catch (err) {
      console.error('Failed to restore database:', err)
      setError(err instanceof Error ? err.message : '数据库还原失败，请稍后重试')
    } finally {
      setRestoring(false)
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

          <section className="rounded-[28px] border border-rose-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-rose-100 bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-rose-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                Restore Database
              </div>
              <h2 className="mt-3 text-2xl font-semibold text-slate-950">数据库还原</h2>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                支持上传 `.sql`、`.sql.gz` 或完整备份 `.tar.gz` 文件。执行后会覆盖当前数据库，请务必先下载一份最新备份。
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-[24px] border border-slate-200 bg-white/95 p-5 shadow-sm">
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">选择备份文件</div>
                    <div className="mt-2 text-sm text-slate-500">
                      当前支持 PostgreSQL SQL 导出文件，以及本系统下载的完整备份压缩包。
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => restoreInputRef.current?.click()}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      <Upload className="h-4 w-4" />
                      选择还原文件
                    </button>
                    <span className="text-sm text-slate-500">
                      {restoreFile ? restoreFile.name : '未选择文件'}
                    </span>
                    <input
                      ref={restoreInputRef}
                      type="file"
                      accept=".sql,.gz,.tar.gz,.tgz"
                      className="hidden"
                      onChange={(event) => setRestoreFile(event.target.files?.[0] || null)}
                    />
                  </div>

                  <label className="flex items-start gap-3 rounded-2xl border border-rose-100 bg-rose-50/70 px-4 py-3 text-sm text-rose-800">
                    <input
                      type="checkbox"
                      checked={restoreConfirmed}
                      onChange={(event) => setRestoreConfirmed(event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-rose-300 text-rose-600 focus:ring-rose-500"
                    />
                    <span>我已确认数据库还原会清空并重建当前数据库内容，此操作不可撤销。</span>
                  </label>
                </div>
              </div>

              <div className="rounded-[24px] border border-rose-200 bg-[linear-gradient(180deg,#fff1f2_0%,#ffffff_100%)] p-5 shadow-sm">
                <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-100 text-rose-700">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-semibold text-slate-950">执行还原</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  建议先下载一份「完整备份」，确认文件无误后再执行还原。还原完成后，页面中的数据会立即切换到备份中的状态。
                </p>
                <button
                  type="button"
                  onClick={handleRestore}
                  disabled={restoring || !restoreFile}
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-rose-600 px-4 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(225,29,72,0.85)] transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Upload className="h-4 w-4" />
                  {restoring ? '还原中...' : '开始还原数据库'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </AuthGuard>
  )
}
