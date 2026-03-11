'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, FileSpreadsheet, Maximize2, Minimize2, Plus, Search, Trash2 } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { useWorkbook } from '@/hooks/useSheet'
import { usePermission } from '@/hooks/usePermission'
import { useSheetWebSocket } from '@/hooks/useSheetWebSocket'
import { getStoredUser, isAdmin } from '@/lib/auth'
import api from '@/lib/api'
import type { AuthUser, Sheet } from '@/types'

const UniverSheetEditor = dynamic(() => import('@/components/spreadsheet/UniverSheetEditor'), {
  ssr: false,
})

interface Props {
  workbookId: string
  requestedSheetId: number | null
}

export default function WorkbookEditorShell({ workbookId, requestedSheetId }: Props) {
  const router = useRouter()
  const { workbook, loading, error, refresh } = useWorkbook(workbookId)
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [addingSheet, setAddingSheet] = useState(false)
  const [newSheetName, setNewSheetName] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [sheetActionError, setSheetActionError] = useState('')
  const [sheetActionLoading, setSheetActionLoading] = useState(false)
  const [sheetSearchQuery, setSheetSearchQuery] = useState('')
  const [sheetSortBy, setSheetSortBy] = useState<'updated_at' | 'created_at' | 'name'>('updated_at')
  const [sheetSortOrder, setSheetSortOrder] = useState<'asc' | 'desc'>('desc')
  const [sheetPage, setSheetPage] = useState(1)

  const sheets = workbook?.sheets || []
  const canManageWorkbook = Boolean(currentUser && (isAdmin(currentUser) || currentUser.id === workbook?.owner_id))
  const sheetsPerPage = 10

  const activeSheet = useMemo(() => {
    if (requestedSheetId === null) return null
    return sheets.find((sheet) => sheet.id === requestedSheetId) ?? null
  }, [requestedSheetId, sheets])
  const activeSheetIndex = activeSheet ? sheets.findIndex((sheet) => sheet.id === activeSheet.id) : -1

  const { permissions, loading: permissionLoading } = usePermission(activeSheet?.id ?? 0)
  const canDeleteActiveSheet = permissions?.sheet.canDelete ?? false

  useSheetWebSocket(activeSheet?.id ?? 0, refresh)

  useEffect(() => {
    setCurrentUser(getStoredUser())
  }, [])

  useEffect(() => {
    if (loading || !workbook) return
    if (sheets.length === 0) return

    if (requestedSheetId === null || !sheets.some((sheet) => sheet.id === requestedSheetId)) {
      router.replace(`/sheets/${workbookId}/${sheets[0].id}`)
    }
  }, [loading, requestedSheetId, router, sheets, workbook, workbookId])

  const filteredSheets = useMemo(() => {
    const keyword = sheetSearchQuery.trim().toLowerCase()
    const nextSheets = [...sheets].filter((sheet) => {
      if (!keyword) return true
      return sheet.name.toLowerCase().includes(keyword)
    })

    nextSheets.sort((left, right) => {
      if (sheetSortBy === 'name') {
        const compare = left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
        return sheetSortOrder === 'asc' ? compare : -compare
      }

      const leftValue = new Date(left[sheetSortBy]).getTime()
      const rightValue = new Date(right[sheetSortBy]).getTime()
      return sheetSortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue
    })

    return nextSheets
  }, [sheetSearchQuery, sheetSortBy, sheetSortOrder, sheets])

  const totalSheetPages = Math.max(1, Math.ceil(filteredSheets.length / sheetsPerPage))
  const visibleSheets = useMemo(() => {
    const start = (sheetPage - 1) * sheetsPerPage
    return filteredSheets.slice(start, start + sheetsPerPage)
  }, [filteredSheets, sheetPage])

  useEffect(() => {
    setSheetPage(1)
  }, [sheetSearchQuery, sheetSortBy, sheetSortOrder])

  useEffect(() => {
    if (sheetPage > totalSheetPages) {
      setSheetPage(totalSheetPages)
    }
  }, [sheetPage, totalSheetPages])

  useEffect(() => {
    if (!activeSheet) return
    const index = filteredSheets.findIndex((sheet) => sheet.id === activeSheet.id)
    if (index < 0) return
    const nextPage = Math.floor(index / sheetsPerPage) + 1
    if (nextPage !== sheetPage) {
      setSheetPage(nextPage)
    }
  }, [activeSheet, filteredSheets, sheetPage])

  const handleAddSheet = async () => {
    if (!canManageWorkbook) {
      setSheetActionError('当前账号不能在这个工作簿里新建工作表。')
      return
    }
    if (!newSheetName.trim()) return

    setSheetActionError('')
    setSheetActionLoading(true)

    try {
      const res = await api.post<Sheet>(`/workbooks/${workbookId}/sheets`, {
        name: newSheetName.trim(),
        columns: [],
      })

      if (res.code !== 0 || !res.data) {
        setSheetActionError(res.message || '新建工作表失败，请稍后再试。')
        return
      }

      setNewSheetName('')
      setAddingSheet(false)
      await refresh()
      router.replace(`/sheets/${workbookId}/${res.data.id}`)
    } catch (err) {
      console.error('Failed to add sheet:', err)
      setSheetActionError('新建工作表失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const handleDeleteActiveSheet = async () => {
    if (!activeSheet || !canDeleteActiveSheet) return
    if (!window.confirm(`确定要删除工作表「${activeSheet.name || '未命名工作表'}」吗？`)) return

    setSheetActionError('')
    setSheetActionLoading(true)

    const fallbackSheetId =
      sheets[activeSheetIndex + 1]?.id ??
      sheets[activeSheetIndex - 1]?.id ??
      null

    try {
      const res = await api.delete(`/sheets/${activeSheet.id}`)
      if (res.code !== 0) {
        setSheetActionError(res.message || '删除工作表失败，请稍后再试。')
        return
      }

      await refresh()
      if (fallbackSheetId) {
        router.replace(`/sheets/${workbookId}/${fallbackSheetId}`)
      } else {
        router.replace(`/sheets/${workbookId}`)
      }
    } catch (err) {
      console.error('Failed to delete sheet:', err)
      setSheetActionError('删除工作表失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  if (loading) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-sky-600">Loading</div>
            <div className="text-lg font-semibold text-slate-900">正在加载工作簿...</div>
          </div>
        </div>
      </AuthGuard>
    )
  }

  if (error || !workbook) {
    return (
      <AuthGuard>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="mb-2 text-sm font-semibold uppercase tracking-widest text-rose-500">Oops</div>
            <div className="text-lg font-semibold text-slate-900">{error || '工作簿未找到'}</div>
          </div>
        </div>
      </AuthGuard>
    )
  }

  return (
    <AuthGuard>
      <div className={`flex flex-col bg-slate-50 ${fullscreen ? 'fixed inset-0 z-50' : 'h-screen'}`}>
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-600">Workbook</div>
              <h1 className="text-sm font-semibold text-slate-900 truncate max-w-[320px]">{workbook.name}</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {addingSheet ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSheetName}
                  onChange={(e) => setNewSheetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAddSheet()
                    if (e.key === 'Escape') { setAddingSheet(false); setNewSheetName('') }
                  }}
                  placeholder="工作表名称"
                  className="h-9 w-44 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => void handleAddSheet()}
                  disabled={sheetActionLoading}
                  className="h-9 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sheetActionLoading ? '创建中...' : '创建'}
                </button>
                <button type="button" onClick={() => { setAddingSheet(false); setNewSheetName('') }} className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  取消
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setAddingSheet(true)} disabled={!canManageWorkbook} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" />
                新建工作表
              </button>
            )}
            {activeSheet && (
              <button
                type="button"
                onClick={() => void handleDeleteActiveSheet()}
                disabled={sheetActionLoading || permissionLoading || !canDeleteActiveSheet}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除当前表
              </button>
            )}
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={fullscreen ? '退出全屏' : '全屏'}
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {sheetActionError && (
          <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {sheetActionError}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[310px] shrink-0 flex-col border-r border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={sheetSearchQuery}
                  onChange={(event) => setSheetSearchQuery(event.target.value)}
                  placeholder="搜索工作表名称..."
                  className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                />
              </div>
              <div className="mt-3 flex gap-2">
                <select
                  value={sheetSortBy}
                  onChange={(event) => setSheetSortBy(event.target.value as 'updated_at' | 'created_at' | 'name')}
                  className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="updated_at">按更新时间</option>
                  <option value="created_at">按创建时间</option>
                  <option value="name">按名称</option>
                </select>
                <select
                  value={sheetSortOrder}
                  onChange={(event) => setSheetSortOrder(event.target.value as 'asc' | 'desc')}
                  className="h-10 w-24 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="desc">降序</option>
                  <option value="asc">升序</option>
                </select>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{filteredSheets.length} 个工作表 / 第 {sheetPage} 页</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setSheetPage((current) => Math.max(1, current - 1))}
                    disabled={sheetPage <= 1}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSheetPage((current) => Math.min(totalSheetPages, current + 1))}
                    disabled={sheetPage >= totalSheetPages}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {visibleSheets.map((sheet) => {
                  const sheetLabel = sheet.name?.trim() || `工作表 ${sheets.findIndex((item) => item.id === sheet.id) + 1}`
                  const isActive = sheet.id === activeSheet?.id

                  return (
                    <Link
                      key={sheet.id}
                      href={`/sheets/${workbookId}/${sheet.id}`}
                      prefetch={false}
                      className={`block rounded-2xl border px-3 py-3 transition ${
                        isActive
                          ? 'border-sky-200 bg-sky-50 shadow-sm'
                          : 'border-slate-200 bg-slate-50/70 hover:border-slate-300 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${isActive ? 'bg-white text-sky-700' : 'bg-white text-slate-500'}`}>
                          <FileSpreadsheet className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className={`truncate text-sm font-semibold ${isActive ? 'text-slate-900' : 'text-slate-700'}`}>
                            {sheetLabel}
                          </div>
                          <div className="mt-1 text-[11px] leading-5 text-slate-500">
                            更新于 {new Date(sheet.updated_at).toLocaleString('zh-CN')}
                          </div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
                {filteredSheets.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                    未找到匹配的工作表
                  </div>
                )}
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-hidden">
            {activeSheet ? (
              <UniverSheetEditor key={activeSheet.id} workbookId={workbookId} sheet={activeSheet} reloadToken={activeSheet.updated_at} onExternalReload={refresh} />
            ) : sheets.length === 0 ? (
              <div className="flex h-full items-center justify-center bg-slate-50 text-center">
                <div className="max-w-sm">
                  <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                  <h2 className="text-xl font-semibold text-slate-900">此工作簿还没有工作表</h2>
                  <p className="mt-2 text-sm text-slate-500">点击上方「新建工作表」开始使用。</p>
                  <button type="button" onClick={() => setAddingSheet(true)} disabled={!canManageWorkbook} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                    <Plus className="h-4 w-4" />
                    新建工作表
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center bg-slate-50 text-center">
                <div className="max-w-sm">
                  <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                  <h2 className="text-xl font-semibold text-slate-900">正在打开工作表...</h2>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </AuthGuard>
  )
}
