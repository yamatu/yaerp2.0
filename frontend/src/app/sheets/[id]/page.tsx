'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, FileSpreadsheet, Maximize2, Minimize2, Plus, Search, Trash2 } from 'lucide-react'
import { useParams } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { useWorkbook } from '@/hooks/useSheet'
import { usePermission } from '@/hooks/usePermission'
import UniverSheetEditor from '@/components/spreadsheet/UniverSheetEditor'
import api from '@/lib/api'
import type { Sheet } from '@/types'

function getHashSheetId(): number | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash.replace('#', '')
  const num = parseInt(hash, 10)
  return isNaN(num) ? null : num
}

function replaceSheetHash(sheetId: number | null) {
  if (typeof window === 'undefined') return

  const nextUrl = sheetId
    ? `${window.location.pathname}${window.location.search}#${sheetId}`
    : `${window.location.pathname}${window.location.search}`

  window.history.replaceState(null, '', nextUrl)
}

export default function WorkbookEditorPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { workbook, loading, error, refresh } = useWorkbook(id)
  const [activeSheetId, setActiveSheetId] = useState<number | null>(null)
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
  const sheetsPerPage = 8
  const getSheetLabel = (sheetName: string | undefined, index: number) =>
    sheetName?.trim() || `工作表 ${index + 1}`
  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.id === activeSheetId) ?? sheets[0] ?? null,
    [activeSheetId, sheets]
  )
  const activeSheetIndex = activeSheet ? sheets.findIndex((sheet) => sheet.id === activeSheet.id) : -1
  const {
    permissions,
    loading: permissionLoading,
  } = usePermission(activeSheet?.id ?? 0)
  const canDeleteActiveSheet = permissions?.sheet.canDelete ?? false
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
    if (sheets.length === 0) {
      setActiveSheetId(null)
      return
    }

    const hashId = getHashSheetId()
    setActiveSheetId((current) => {
      if (hashId !== null && sheets.some((sheet) => sheet.id === hashId)) {
        return hashId
      }

      if (current !== null && sheets.some((sheet) => sheet.id === current)) {
        return current
      }

      return sheets[0].id
    })
  }, [sheets])

  useEffect(() => {
    setSheetPage(1)
  }, [sheetSearchQuery, sheetSortBy, sheetSortOrder])

  useEffect(() => {
    if (sheetPage > totalSheetPages) {
      setSheetPage(totalSheetPages)
    }
  }, [sheetPage, totalSheetPages])

  useEffect(() => {
    if (!activeSheetId) return
    const index = filteredSheets.findIndex((sheet) => sheet.id === activeSheetId)
    if (index < 0) return
    const nextPage = Math.floor(index / sheetsPerPage) + 1
    if (nextPage !== sheetPage) {
      setSheetPage(nextPage)
    }
  }, [activeSheetId, filteredSheets, sheetPage])

  useEffect(() => {
    const handleHashChange = () => {
      const hashId = getHashSheetId()
      if (hashId !== null && sheets.some((sheet) => sheet.id === hashId)) {
        setActiveSheetId(hashId)
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [sheets])

  useEffect(() => {
    replaceSheetHash(activeSheet?.id ?? null)
  }, [activeSheet?.id])

  const handleAddSheet = async () => {
    if (!newSheetName.trim()) return

    setSheetActionError('')
    setSheetActionLoading(true)

    try {
      const res = await api.post<Sheet>(`/workbooks/${id}/sheets`, {
        name: newSheetName.trim(),
        columns: [],
      })

      if (res.code !== 0 || !res.data) {
        setSheetActionError(res.message || '新建工作表失败，请稍后再试。')
        return
      }

      setNewSheetName('')
      setAddingSheet(false)
      setActiveSheetId(res.data.id)
      replaceSheetHash(res.data.id)
      await refresh()
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
      setActiveSheetId(fallbackSheetId)
      replaceSheetHash(fallbackSheetId)
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
        {/* Compact top bar */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </a>
            <div className="h-5 w-px bg-slate-200" />
            <h1 className="text-sm font-semibold text-slate-900 truncate max-w-[300px]">
              {workbook.name}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {addingSheet ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSheetName}
                  onChange={(e) => setNewSheetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddSheet()
                    if (e.key === 'Escape') { setAddingSheet(false); setNewSheetName('') }
                  }}
                  placeholder="工作表名称"
                  className="h-8 w-40 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-100"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleAddSheet}
                  disabled={sheetActionLoading}
                  className="h-8 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sheetActionLoading ? '创建中...' : '创建'}
                </button>
                <button type="button" onClick={() => { setAddingSheet(false); setNewSheetName('') }} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  取消
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setAddingSheet(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                <Plus className="h-3.5 w-3.5" />
                新建工作表
              </button>
            )}
            {activeSheet && (
              <button
                type="button"
                onClick={handleDeleteActiveSheet}
                disabled={sheetActionLoading || permissionLoading || !canDeleteActiveSheet}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                title={canDeleteActiveSheet ? '删除当前工作表' : '当前账号没有删除当前工作表的权限'}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除当前表
              </button>
            )}
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={fullscreen ? '退出全屏' : '全屏'}
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Sheet tabs */}
        <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-3 py-1 overflow-x-auto">
          {visibleSheets.map((sheet) => (
            <button
              key={sheet.id}
              type="button"
              onClick={() => setActiveSheetId(sheet.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${
                sheet.id === activeSheet?.id
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                  : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'
              }`}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {getSheetLabel(sheet.name, sheets.findIndex((item) => item.id === sheet.id))}
            </button>
          ))}
          {filteredSheets.length === 0 && (
            <span className="px-2 py-1 text-xs text-slate-400">还没有工作表</span>
          )}
        </div>

        <div className="flex flex-col gap-3 border-b border-slate-200 bg-white px-3 py-3 md:flex-row md:items-center md:justify-between">
          <div className="relative w-full md:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={sheetSearchQuery}
              onChange={(event) => setSheetSearchQuery(event.target.value)}
              placeholder="搜索工作表名称..."
              className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={sheetSortBy}
              onChange={(event) => setSheetSortBy(event.target.value as 'updated_at' | 'created_at' | 'name')}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              <option value="updated_at">按更新时间</option>
              <option value="created_at">按创建时间</option>
              <option value="name">按名称</option>
            </select>
            <select
              value={sheetSortOrder}
              onChange={(event) => setSheetSortOrder(event.target.value as 'asc' | 'desc')}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              <option value="desc">降序</option>
              <option value="asc">升序</option>
            </select>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              {filteredSheets.length} 个工作表 / 第 {sheetPage} 页
            </div>
            <button
              type="button"
              onClick={() => setSheetPage((current) => Math.max(1, current - 1))}
              disabled={sheetPage <= 1}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setSheetPage((current) => Math.min(totalSheetPages, current + 1))}
              disabled={sheetPage >= totalSheetPages}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {sheetActionError && (
          <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
            {sheetActionError}
          </div>
        )}

        {/* Editor area — fills all remaining space */}
        <div className="flex-1 overflow-hidden relative">
          {activeSheet ? (
            <UniverSheetEditor key={`${activeSheet.id}-${activeSheet.updated_at}`} workbookId={id} sheet={activeSheet} onExternalReload={refresh} />
          ) : (
            <div className="flex h-full items-center justify-center text-center">
              <div className="max-w-sm">
                <FileSpreadsheet className="mx-auto mb-4 h-12 w-12 text-slate-300" />
                <h2 className="text-xl font-semibold text-slate-900">此工作簿还没有工作表</h2>
                <p className="mt-2 text-sm text-slate-500">点击上方「新建工作表」开始使用。</p>
                <button type="button" onClick={() => setAddingSheet(true)} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800">
                  <Plus className="h-4 w-4" />
                  新建工作表
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  )
}
