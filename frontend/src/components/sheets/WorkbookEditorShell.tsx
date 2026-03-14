'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, ChevronLeft, ChevronRight, EyeOff, FileSpreadsheet, Lock, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2, Unlock } from 'lucide-react'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [addingSheet, setAddingSheet] = useState(false)
  const [newSheetName, setNewSheetName] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sheetActionError, setSheetActionError] = useState('')
  const [sheetActionLoading, setSheetActionLoading] = useState(false)
  const [sheetSearchQuery, setSheetSearchQuery] = useState('')
  const [sheetSortBy, setSheetSortBy] = useState<'updated_at' | 'created_at' | 'name'>('updated_at')
  const [sheetSortOrder, setSheetSortOrder] = useState<'asc' | 'desc'>('desc')
  const [sheetPage, setSheetPage] = useState(1)
  const [optimisticEditableSheetId, setOptimisticEditableSheetId] = useState<number | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const handleSheetReload = useCallback(async () => {
    await refresh()
    setReloadToken((prev) => prev + 1)
  }, [refresh])

  const sheets = workbook?.sheets || []
  const isAdminUser = Boolean(currentUser && isAdmin(currentUser))
  const canManageWorkbook = Boolean(currentUser && (isAdmin(currentUser) || currentUser.id === workbook?.owner_id))
  const sheetsPerPage = 10

  const activeSheet = useMemo(() => {
    if (requestedSheetId === null) return null
    return sheets.find((sheet) => sheet.id === requestedSheetId) ?? null
  }, [requestedSheetId, sheets])
  const activeSheetIndex = activeSheet ? sheets.findIndex((sheet) => sheet.id === activeSheet.id) : -1

  const { permissions, loading: permissionLoading } = usePermission(activeSheet?.id ?? 0)
  const canDeleteActiveSheet = permissions?.sheet.canDelete ?? false

  useSheetWebSocket(activeSheet?.id ?? 0, handleSheetReload)

  useEffect(() => {
    setCurrentUser(getStoredUser())
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement))
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Stable sheet-id list so the redirect effect does not re-fire on every
  // workbook refresh (which gives a new `sheets` array reference).
  const sheetIds = useMemo(() => sheets.map((s) => s.id), [sheets])

  useEffect(() => {
    if (loading || !workbook) return
    if (sheetIds.length === 0) return

    if (requestedSheetId === null || !sheetIds.includes(requestedSheetId)) {
      router.replace(`/sheets/${workbookId}/${sheetIds[0]}`)
    }
  }, [loading, requestedSheetId, router, sheetIds, workbook, workbookId])

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

  useEffect(() => {
    if (!activeSheet || optimisticEditableSheetId === null) return
    if (activeSheet.id !== optimisticEditableSheetId) return
    if (!permissionLoading) {
      setOptimisticEditableSheetId(null)
    }
  }, [activeSheet, optimisticEditableSheetId, permissionLoading])

  useEffect(() => {
    if (!requestedSheetId) {
      setOptimisticEditableSheetId(null)
    }
  }, [requestedSheetId])

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
      setOptimisticEditableSheetId(res.data.id)
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

  const handleUpdateWorkbookState = async (action: 'lock' | 'unlock' | 'hide' | 'unhide') => {
    if (!workbook) return
    setSheetActionError('')
    setSheetActionLoading(true)

    try {
      const res = await api.put(`/workbooks/${workbook.id}/state`, { action })
      if (res.code !== 0) {
        setSheetActionError(res.message || '更新工作簿状态失败，请稍后再试。')
        return
      }
      await refresh()
      if (action === 'hide' && !isAdminUser) {
        router.replace('/')
      }
    } catch (err) {
      console.error('Failed to update workbook state:', err)
      setSheetActionError('更新工作簿状态失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const handleUpdateSheetState = async (action: 'lock' | 'unlock' | 'archive' | 'unarchive') => {
    if (!activeSheet) return
    setSheetActionError('')
    setSheetActionLoading(true)

    try {
      const res = await api.put(`/sheets/${activeSheet.id}/state`, { action })
      if (res.code !== 0) {
        setSheetActionError(res.message || '更新工作表状态失败，请稍后再试。')
        return
      }
      await refresh()
    } catch (err) {
      console.error('Failed to update sheet state:', err)
      setSheetActionError('更新工作表状态失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const handleFullscreenToggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      await rootRef.current?.requestFullscreen()
    } catch (err) {
      console.error('Failed to toggle fullscreen:', err)
      setSheetActionError('切换全屏失败，请确认浏览器允许全屏。')
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
      <div ref={rootRef} className={`flex flex-col bg-slate-50 ${fullscreen ? 'fixed inset-0 z-50' : 'h-screen'}`}>
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((current) => !current)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={sidebarCollapsed ? '展开工作表目录' : '折叠工作表目录'}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <Link href="/" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-600">Workbook</div>
              <h1 className="text-sm font-semibold text-slate-900 truncate max-w-[320px]">{workbook.name}</h1>
              {activeSheet && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {workbook.is_locked && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Lock className="h-3 w-3" /> 工作簿已锁定
                    </span>
                  )}
                  {workbook.is_hidden && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                      <EyeOff className="h-3 w-3" /> 工作簿不可见
                    </span>
                  )}
                  {activeSheet.is_locked && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Lock className="h-3 w-3" /> 已锁定
                    </span>
                  )}
                  {activeSheet.is_archived && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                      <Archive className="h-3 w-3" /> 已归档
                    </span>
                  )}
                </div>
              )}
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
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() => void handleUpdateWorkbookState(workbook.is_locked ? 'unlock' : 'lock')}
                disabled={sheetActionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {workbook.is_locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {workbook.is_locked ? '解除工作簿锁定' : '锁定工作簿'}
              </button>
            )}
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() => void handleUpdateWorkbookState(workbook.is_hidden ? 'unhide' : 'hide')}
                disabled={sheetActionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <EyeOff className="h-3.5 w-3.5" />
                {workbook.is_hidden ? '恢复工作簿可见' : '设为工作簿不可见'}
              </button>
            )}
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() => void handleUpdateSheetState(activeSheet.is_locked ? 'unlock' : 'lock')}
                disabled={sheetActionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activeSheet.is_locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                {activeSheet.is_locked ? '解除锁定' : '锁定工作表'}
              </button>
            )}
            {isAdminUser && activeSheet && (
              <button
                type="button"
                onClick={() => void handleUpdateSheetState(activeSheet.is_archived ? 'unarchive' : 'archive')}
                disabled={sheetActionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activeSheet.is_archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                {activeSheet.is_archived ? '取消归档' : '归档工作表'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleFullscreenToggle()}
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

        {activeSheet && (activeSheet.is_locked || activeSheet.is_archived) && !isAdminUser && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            {activeSheet.is_archived ? '当前工作表已归档，仅管理员可以修改。' : '当前工作表已锁定，仅管理员可以修改或解除锁定。'}
          </div>
        )}

        {workbook.is_locked && !isAdminUser && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            当前工作簿已被管理员锁定，你可以查看和重命名，但不能继续修改表格内容。
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <aside className={`flex shrink-0 flex-col border-r border-slate-200 bg-white transition-all duration-200 ${sidebarCollapsed ? 'w-[88px]' : 'w-[320px]'}`}>
            <div className="border-b border-slate-200 px-4 py-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={sheetSearchQuery}
                  onChange={(event) => setSheetSearchQuery(event.target.value)}
                  placeholder="搜索工作表名称..."
                  className={`h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pr-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100 ${sidebarCollapsed ? 'pl-10 opacity-0 pointer-events-none' : 'pl-9'}`}
                />
              </div>
              {!sidebarCollapsed && (
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
              )}
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{sidebarCollapsed ? `${filteredSheets.length} 表` : `${filteredSheets.length} 个工作表 / 第 ${sheetPage} 页`}</span>
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
                        <div className={`min-w-0 flex-1 ${sidebarCollapsed ? 'hidden' : ''}`}>
                          <div className={`truncate text-sm font-semibold ${isActive ? 'text-slate-900' : 'text-slate-700'}`}>
                            {sheetLabel}
                          </div>
                          <div className="mt-1 text-[11px] leading-5 text-slate-500">
                            更新于 {new Date(sheet.updated_at).toLocaleString('zh-CN')}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {sheet.is_locked && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">锁定</span>}
                            {sheet.is_archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">归档</span>}
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
              <UniverSheetEditor key={activeSheet.id} workbookId={workbookId} sheet={activeSheet} reloadToken={String(reloadToken)} onExternalReload={refresh} optimisticCanEdit={optimisticEditableSheetId === activeSheet.id} canImportWorkbook={canManageWorkbook} />
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
