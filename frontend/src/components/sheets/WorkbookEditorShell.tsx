'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, Check, Copy, Eye, EyeOff, FileSpreadsheet, Globe2, Lock, Maximize2, MessageCircle, Minimize2, PanelLeftClose, PanelLeftOpen, PencilLine, Plus, Search, Trash2, Unlock, X } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { WhatsAppSendDialog, type WhatsAppSendResource } from '@/components/whatsapp/WhatsAppSendDialog'
import { EXCEL_IMPORT_FORMATS_LABEL, isSupportedExcelImportFile, uploadWorkbookXlsx } from '@/components/spreadsheet/ImportXlsxButton'
import { useWorkbook } from '@/hooks/useSheet'
import { usePermission } from '@/hooks/usePermission'
import { useSheetWebSocket } from '@/hooks/useSheetWebSocket'
import { isBooleanPreference, useUserPreference } from '@/hooks/useUserPreference'
import { getStoredUser, isAdmin } from '@/lib/auth'
import api from '@/lib/api'
import { prepareDataMutation } from '@/lib/dataEvents'
import type { AuthUser, Sheet } from '@/types'

const UniverSheetEditor = dynamic(() => import('@/components/spreadsheet/UniverSheetEditor'), {
  ssr: false,
})

interface Props {
  workbookId: string
  requestedSheetId: number | null
}

interface SheetContextMenuState {
  sheet: Sheet
  batch: boolean
  x: number
  y: number
}

type SheetStateAction = 'lock' | 'unlock' | 'archive' | 'unarchive' | 'hide' | 'unhide'
type SheetSortBy = 'updated_at' | 'created_at' | 'name'
type SheetSortOrder = 'asc' | 'desc'

function isSheetSortBy(value: unknown): value is SheetSortBy {
  return value === 'updated_at' || value === 'created_at' || value === 'name'
}

function isSheetSortOrder(value: unknown): value is SheetSortOrder {
  return value === 'asc' || value === 'desc'
}

function lastViewedSheetStorageKey(userId: number, workbookId: string) {
  return `yaerp:workbook-view:${userId}:${workbookId}:last-sheet`
}

function readLastViewedSheetId(userId: number, workbookId: string) {
  try {
    const value = Number(window.localStorage.getItem(lastViewedSheetStorageKey(userId, workbookId)))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function rememberLastViewedSheet(userId: number, workbookId: string, sheetId: number) {
  try {
    window.localStorage.setItem(lastViewedSheetStorageKey(userId, workbookId), String(sheetId))
  } catch {
    // Browsing still works when storage is unavailable.
  }
}

export default function WorkbookEditorShell({ workbookId, requestedSheetId }: Props) {
  const router = useRouter()
  const { workbook, loading, error, refresh, refreshSilently } = useWorkbook(workbookId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [addingSheet, setAddingSheet] = useState(false)
  const [newSheetName, setNewSheetName] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useUserPreference(
    currentUser?.id,
    'workbook.sidebar-collapsed',
    false,
    isBooleanPreference
  )
  const [sheetActionError, setSheetActionError] = useState('')
  const [sheetActionLoading, setSheetActionLoading] = useState(false)
  const [sheetSearchQuery, setSheetSearchQuery] = useState('')
  const [sheetSortBy, setSheetSortBy] = useUserPreference<SheetSortBy>(
    currentUser?.id,
    'workbook.sheet-sort-by',
    'updated_at',
    isSheetSortBy
  )
  const [sheetSortOrder, setSheetSortOrder] = useUserPreference<SheetSortOrder>(
    currentUser?.id,
    'workbook.sheet-sort-order',
    'desc',
    isSheetSortOrder
  )
  const [selectedSheetIds, setSelectedSheetIds] = useState<number[]>([])
  const [optimisticEditableSheetId, setOptimisticEditableSheetId] = useState<number | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [renamingSheetId, setRenamingSheetId] = useState<number | null>(null)
  const [renamingSheetName, setRenamingSheetName] = useState('')
  const [sidebarDragImportActive, setSidebarDragImportActive] = useState(false)
  const [sidebarDragImportUploading, setSidebarDragImportUploading] = useState(false)
  const [sidebarDragImportProgress, setSidebarDragImportProgress] = useState(0)
  const [sheetContextMenu, setSheetContextMenu] = useState<SheetContextMenuState | null>(null)
  const [whatsAppResource, setWhatsAppResource] = useState<WhatsAppSendResource | null>(null)
  const sidebarDragDepthRef = useRef(0)
  const addSheetPopoverRef = useRef<HTMLDivElement>(null)

  const handleSheetReload = useCallback(async () => {
    await refresh()
    setReloadToken((prev) => prev + 1)
  }, [refresh])

  const sheets = workbook?.sheets || []
  const isAdminUser = Boolean(currentUser && isAdmin(currentUser))
  const canManageWorkbook = Boolean(currentUser && (isAdmin(currentUser) || currentUser.id === workbook?.owner_id))

  const handleSidebarDroppedXlsxImport = useCallback(async (file: File) => {
    if (!canManageWorkbook) {
      setSheetActionError('当前账号没有导入 Excel 的权限。')
      return
    }

    setSheetActionError('')
    setSidebarDragImportUploading(true)
    setSidebarDragImportProgress(0)

    try {
      const result = await uploadWorkbookXlsx(workbookId, file, {
        onProgress: setSidebarDragImportProgress,
      })
      await handleSheetReload()
      router.replace(`/sheets/${workbookId}/${result.sheet_id}`)
    } catch (error) {
      setSheetActionError(error instanceof Error ? error.message : 'Import failed. Please try again later.')
    } finally {
      setSidebarDragImportUploading(false)
      setSidebarDragImportActive(false)
      sidebarDragDepthRef.current = 0
      window.setTimeout(() => setSidebarDragImportProgress(0), 400)
    }
  }, [canManageWorkbook, handleSheetReload, router, workbookId])

  const handleSidebarDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canManageWorkbook || sidebarDragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    sidebarDragDepthRef.current += 1
    setSidebarDragImportActive(true)
  }, [canManageWorkbook, sidebarDragImportUploading])

  const handleSidebarDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canManageWorkbook || sidebarDragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [canManageWorkbook, sidebarDragImportUploading])

  const handleSidebarDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canManageWorkbook || sidebarDragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    sidebarDragDepthRef.current = Math.max(0, sidebarDragDepthRef.current - 1)
    if (sidebarDragDepthRef.current === 0) {
      setSidebarDragImportActive(false)
    }
  }, [canManageWorkbook, sidebarDragImportUploading])

  const handleSidebarDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canManageWorkbook || sidebarDragImportUploading) return
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length === 0) return
    event.preventDefault()
    sidebarDragDepthRef.current = 0
    setSidebarDragImportActive(false)
    const excelFile = files.find(isSupportedExcelImportFile)
    if (!excelFile) {
      setSheetActionError(`请拖入 ${EXCEL_IMPORT_FORMATS_LABEL} 格式的文件。`)
      return
    }
    void handleSidebarDroppedXlsxImport(excelFile)
  }, [canManageWorkbook, handleSidebarDroppedXlsxImport, sidebarDragImportUploading])

  const activeSheet = useMemo(() => {
    if (requestedSheetId === null) return null
    return sheets.find((sheet) => sheet.id === requestedSheetId) ?? null
  }, [requestedSheetId, sheets])
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
    setSelectedSheetIds((current) => current.filter((id) => sheetIds.includes(id)))
  }, [sheetIds])

  useEffect(() => {
    if (loading || !workbook) return
    if (!currentUser?.id) return
    if (sheetIds.length === 0) return

    if (requestedSheetId === null || !sheetIds.includes(requestedSheetId)) {
      const rememberedSheetId = readLastViewedSheetId(currentUser.id, workbookId)
      const targetSheetId = rememberedSheetId && sheetIds.includes(rememberedSheetId)
        ? rememberedSheetId
        : sheetIds[0]
      router.replace(`/sheets/${workbookId}/${targetSheetId}`)
    }
  }, [currentUser?.id, loading, requestedSheetId, router, sheetIds, workbook, workbookId])

  useEffect(() => {
    if (!currentUser?.id || !activeSheet?.id) return
    rememberLastViewedSheet(currentUser.id, workbookId, activeSheet.id)
  }, [activeSheet?.id, currentUser?.id, workbookId])

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

  const visibleSheets = filteredSheets
  const selectedSheets = useMemo(
    () => sheets.filter((sheet) => selectedSheetIds.includes(sheet.id)),
    [selectedSheetIds, sheets]
  )

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

  useEffect(() => {
    if (!addingSheet) return
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (addSheetPopoverRef.current?.contains(event.target as Node)) return
      setAddingSheet(false)
      setNewSheetName('')
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [addingSheet])

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

  const handleDeleteSheet = async (targetSheet: Sheet | null = activeSheet) => {
    if (!targetSheet || !canManageWorkbook) return
    if (!window.confirm(`确定要删除工作表「${targetSheet.name || '未命名工作表'}」吗？`)) return

    setSheetActionError('')
    setSheetActionLoading(true)

    const targetIndex = sheets.findIndex((item) => item.id === targetSheet.id)
    const fallbackSheetId =
      sheets[targetIndex + 1]?.id ??
      sheets[targetIndex - 1]?.id ??
      null

    try {
      const res = await api.delete(`/sheets/${targetSheet.id}`)
      if (res.code !== 0) {
        setSheetActionError(res.message || '删除工作表失败，请稍后再试。')
        return
      }

      await refresh()
      if (targetSheet.id !== activeSheet?.id) {
        return
      }
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

  const handleDuplicateSheet = async (targetSheet: Sheet) => {
    if (!canManageWorkbook || sheetActionLoading) return

    setSheetActionError('')
    setSheetActionLoading(true)
    setSheetContextMenu(null)
    try {
      if (targetSheet.id === activeSheet?.id) {
        await prepareDataMutation()
      }
      const res = await api.post<Sheet>(`/sheets/${targetSheet.id}/duplicate`)
      if (res.code !== 0 || !res.data) {
        setSheetActionError(res.message || '复制工作表失败，请稍后再试。')
        return
      }
      setSelectedSheetIds([])
      setOptimisticEditableSheetId(res.data.id)
      await refresh()
      router.replace(`/sheets/${workbookId}/${res.data.id}`)
    } catch (err) {
      console.error('Failed to duplicate sheet:', err)
      setSheetActionError(err instanceof Error ? err.message : '复制工作表失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const startRenameSheet = (sheet: Sheet) => {
    if (!canManageWorkbook) return
    setSheetActionError('')
    setRenamingSheetId(sheet.id)
    setRenamingSheetName(sheet.name || '')
  }

  const cancelRenameSheet = () => {
    setRenamingSheetId(null)
    setRenamingSheetName('')
  }

  const handleRenameSheet = async (sheet: Sheet) => {
    if (!canManageWorkbook) {
      setSheetActionError('当前账号不能重命名这个工作表。')
      return
    }

    const nextName = renamingSheetName.trim()
    if (!nextName) {
      setSheetActionError('工作表名称不能为空。')
      return
    }
    if (nextName === sheet.name) {
      cancelRenameSheet()
      return
    }

    setSheetActionError('')
    setSheetActionLoading(true)
    try {
      const res = await api.put(`/sheets/${sheet.id}`, { name: nextName })
      if (res.code !== 0) {
        setSheetActionError(res.message || '重命名工作表失败，请稍后再试。')
        return
      }
      cancelRenameSheet()
      await handleSheetReload()
    } catch (err) {
      console.error('Failed to rename sheet:', err)
      setSheetActionError('重命名工作表失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const handleUpdateWorkbookState = async (action: 'lock' | 'unlock' | 'hide' | 'unhide' | 'publish' | 'unpublish') => {
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

  const handleUpdateSheetState = async (targetSheet: Sheet, action: SheetStateAction) => {
    setSheetActionError('')
    setSheetActionLoading(true)

    try {
      const res = await api.put(`/sheets/${targetSheet.id}/state`, { action })
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

  const handleBatchUpdateSheetState = async (action: SheetStateAction) => {
    if (!isAdminUser || selectedSheets.length === 0 || sheetActionLoading) return
    setSheetActionError('')
    setSheetActionLoading(true)
    setSheetContextMenu(null)
    try {
      const results = await Promise.all(selectedSheets.map((sheet) => api.put(`/sheets/${sheet.id}/state`, { action })))
      const failure = results.find((result) => result.code !== 0)
      if (failure) {
        setSheetActionError(failure.message || '部分工作表状态更新失败，请稍后再试。')
      }
      await refresh()
    } catch (err) {
      console.error('Failed to batch update sheet state:', err)
      setSheetActionError('批量更新工作表状态失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const handleBatchDeleteSheets = async () => {
    if (!canManageWorkbook || selectedSheets.length === 0 || sheetActionLoading) return
    const selectedNames = selectedSheets.slice(0, 3).map((sheet) => `「${sheet.name || '未命名工作表'}」`).join('、')
    const suffix = selectedSheets.length > 3 ? ` 等 ${selectedSheets.length} 个工作表` : ''
    if (!window.confirm(`确定删除 ${selectedNames}${suffix} 吗？此操作不可撤销。`)) return

    setSheetActionError('')
    setSheetActionLoading(true)
    setSheetContextMenu(null)
    const selectedIdSet = new Set(selectedSheetIds)
    const fallbackSheet = sheets.find((sheet) => !selectedIdSet.has(sheet.id)) || null
    try {
      const results = await Promise.all(selectedSheets.map((sheet) => api.delete(`/sheets/${sheet.id}`)))
      const failure = results.find((result) => result.code !== 0)
      if (failure) {
        setSheetActionError(failure.message || '部分工作表删除失败，请刷新后重试。')
      }
      await refresh()
      setSelectedSheetIds([])
      if (activeSheet && selectedIdSet.has(activeSheet.id)) {
        router.replace(fallbackSheet ? `/sheets/${workbookId}/${fallbackSheet.id}` : `/sheets/${workbookId}`)
      }
    } catch (err) {
      console.error('Failed to batch delete sheets:', err)
      setSheetActionError('批量删除工作表失败，请稍后再试。')
    } finally {
      setSheetActionLoading(false)
    }
  }

  const toggleSheetSelection = (sheetId: number) => {
    setSelectedSheetIds((current) => current.includes(sheetId)
      ? current.filter((id) => id !== sheetId)
      : [...current, sheetId])
  }

  const handleSheetCardClickCapture = (event: React.MouseEvent, targetSheet: Sheet) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      toggleSheetSelection(targetSheet.id)
      return
    }
    if (selectedSheetIds.length > 0) setSelectedSheetIds([])
  }

  const openSheetContextMenu = (event: React.MouseEvent, targetSheet: Sheet) => {
    event.preventDefault()
    event.stopPropagation()
    const modifierPressed = event.ctrlKey || event.metaKey
    let nextSelectedIds = selectedSheetIds
    if (modifierPressed) {
      if (!nextSelectedIds.includes(targetSheet.id)) {
        nextSelectedIds = [...nextSelectedIds, targetSheet.id]
        setSelectedSheetIds(nextSelectedIds)
      }
    } else {
      nextSelectedIds = []
      if (selectedSheetIds.length > 0) setSelectedSheetIds([])
    }
    const menuWidth = 240
    const menuHeight = modifierPressed && nextSelectedIds.length > 1 ? 420 : canManageWorkbook ? 324 : 80
    setSheetContextMenu({
      sheet: targetSheet,
      batch: modifierPressed && nextSelectedIds.length > 1,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    })
  }

  useEffect(() => {
    if (!sheetContextMenu) return
    const close = () => setSheetContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sheetContextMenu])

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
        <div className="flex min-h-[68px] items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((current) => !current)}
              className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={sidebarCollapsed ? '展开工作表目录' : '折叠工作表目录'}
              aria-label={sidebarCollapsed ? '展开工作表目录' : '折叠工作表目录'}
              data-tooltip={sidebarCollapsed ? '展开工作表目录' : '折叠工作表目录'}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            <div ref={addSheetPopoverRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setAddingSheet((current) => {
                    if (current) setNewSheetName('')
                    return !current
                  })
                }}
                disabled={!canManageWorkbook || sheetActionLoading}
                className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                title="新建工作表"
                aria-label="新建工作表"
                data-tooltip={addingSheet ? '关闭新建工作表' : '新建工作表'}
                aria-expanded={addingSheet}
              >
                <Plus className={`h-4 w-4 transition-transform ${addingSheet ? 'rotate-45' : ''}`} />
              </button>
              {addingSheet && (
                <div role="dialog" aria-label="新建工作表" className="absolute -left-12 top-11 z-[120] w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-3 shadow-2xl sm:left-0">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-slate-800">新建工作表</div>
                    <button type="button" onClick={() => { setAddingSheet(false); setNewSheetName('') }} className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="取消新建工作表" aria-label="取消新建工作表" data-tooltip="取消">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    type="text"
                    value={newSheetName}
                    onChange={(event) => setNewSheetName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleAddSheet()
                      if (event.key === 'Escape') { setAddingSheet(false); setNewSheetName('') }
                    }}
                    placeholder="输入工作表名称"
                    className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    autoFocus
                  />
                  <button type="button" onClick={() => void handleAddSheet()} disabled={sheetActionLoading || !newSheetName.trim()} className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" title="创建工作表">
                    <Plus className="h-4 w-4" />
                    {sheetActionLoading ? '创建中...' : '创建工作表'}
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleDeleteSheet()}
              disabled={!activeSheet || sheetActionLoading || permissionLoading || !canDeleteActiveSheet}
              className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
              title="删除当前工作表"
              aria-label="删除当前工作表"
              data-tooltip="删除当前工作表"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <Link href="/" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm leading-none text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <div className="flex min-w-0 flex-col justify-center">
              <div className="text-[11px] font-semibold uppercase leading-4 tracking-[0.28em] text-sky-600">Workbook</div>
              <h1 className="max-w-[320px] truncate text-sm font-semibold leading-5 text-slate-900">{workbook.name}</h1>
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
                  {workbook.is_public && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                      <Globe2 className="h-3 w-3" /> 公共工作簿
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
                  {activeSheet.is_hidden && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700">
                      <EyeOff className="h-3 w-3" /> 已隐藏
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {activeSheet && (
              <button type="button" onClick={() => setWhatsAppResource({ sheetId: activeSheet.id, title: `${workbook.name} / ${activeSheet.name}`, defaultContent: `工作表：${workbook.name} / ${activeSheet.name}` })} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 text-emerald-600 transition hover:bg-emerald-50" title="发送当前工作表到 WhatsApp" aria-label="发送当前工作表到 WhatsApp" data-tooltip="发送到 WhatsApp"><MessageCircle className="h-4 w-4" /></button>
            )}
            {canManageWorkbook && activeSheet && (
              <button
                type="button"
                onClick={() => void handleUpdateWorkbookState(workbook.is_public ? 'unpublish' : 'publish')}
                disabled={sheetActionLoading}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${workbook.is_public ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                title={workbook.is_public ? '取消公共访问' : '设为公共工作簿'}
              >
                <Globe2 className="h-3.5 w-3.5" />
                {workbook.is_public ? '公共表' : '设为公共表'}
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
            <button
              type="button"
              onClick={() => void handleFullscreenToggle()}
              className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
              title={fullscreen ? '退出全屏' : '全屏'}
              aria-label={fullscreen ? '退出全屏' : '进入全屏'}
              data-tooltip={fullscreen ? '退出全屏' : '进入全屏'}
              data-tooltip-side="left"
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
          <aside className={`flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ${sidebarCollapsed ? 'w-[88px]' : 'w-[320px]'}`}>
            {sidebarCollapsed ? (
              <div className="flex h-[72px] items-center justify-center border-b border-slate-200 px-2">
                <div className="flex h-11 w-11 flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-center">
                  <span className="text-xs font-semibold leading-none text-slate-700">{filteredSheets.length}</span>
                  <span className="mt-0.5 text-[10px] leading-none text-slate-400">表</span>
                </div>
              </div>
            ) : (
              <div className="border-b border-slate-200 px-4 py-4">
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center text-slate-400">
                    <Search className="h-4 w-4" />
                  </span>
                  <input
                    type="text"
                    value={sheetSearchQuery}
                    onChange={(event) => setSheetSearchQuery(event.target.value)}
                    placeholder="搜索工作表名称..."
                    className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pr-3 pl-10 text-sm leading-10 text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <select
                    value={sheetSortBy}
                    onChange={(event) => setSheetSortBy(event.target.value as SheetSortBy)}
                    className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm leading-10 text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  >
                    <option value="updated_at">按更新时间</option>
                    <option value="created_at">按创建时间</option>
                    <option value="name">按名称</option>
                  </select>
                  <select
                    value={sheetSortOrder}
                    onChange={(event) => setSheetSortOrder(event.target.value as SheetSortOrder)}
                    className="h-10 w-24 rounded-xl border border-slate-200 bg-white px-3 text-sm leading-10 text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  >
                    <option value="desc">降序</option>
                    <option value="asc">升序</option>
                  </select>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 text-xs leading-5 text-slate-500">
                  <span>{filteredSheets.length} 个工作表</span>
                  <span className="text-right text-[11px] text-slate-400">Ctrl + 单击多选</span>
                </div>
                {selectedSheetIds.length > 0 && (
                  <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                    <span>已选择 {selectedSheetIds.length} 个工作表</span>
                    <button type="button" onClick={() => setSelectedSheetIds([])} className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg text-amber-700 hover:bg-white" title="清除工作表选择" aria-label="清除工作表选择" data-tooltip="清除选择" data-tooltip-side="left"><X className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            )}

            <div
              className={`relative min-h-0 flex-1 overflow-y-auto ${sidebarCollapsed ? 'px-2 py-3' : 'p-3'}`}
              onDragEnter={handleSidebarDragEnter}
              onDragOver={handleSidebarDragOver}
              onDragLeave={handleSidebarDragLeave}
              onDrop={handleSidebarDrop}
            >
              {(sidebarDragImportActive || sidebarDragImportUploading) && (
                <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-3xl border-2 border-dashed border-sky-300 bg-sky-50/95 p-6 text-center shadow-sm">
                  <div className="max-w-[220px]">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-sky-600 shadow-sm">
                      <FileSpreadsheet className="h-7 w-7" />
                    </div>
                    <div className="mt-4 text-sm font-semibold text-slate-900">
                      {sidebarDragImportUploading ? '正在导入 Excel...' : '将 Excel 文件拖到这里导入'}
                    </div>
                    <div className="mt-2 text-xs leading-5 text-slate-500">
                      导入后会自动创建工作表并跳转到新表。
                    </div>
                    {sidebarDragImportUploading && (
                      <div className="mt-4">
                        <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600">
                          <span>Importing</span>
                          <span>{sidebarDragImportProgress}%</span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-100">
                          <div className="h-full rounded-full bg-sky-500 transition-all duration-200" style={{ width: `${sidebarDragImportProgress}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className={sidebarCollapsed ? 'flex flex-col items-center gap-2' : 'space-y-2'}>
                {visibleSheets.map((sheet) => {
                  const sheetLabel = sheet.name?.trim() || `工作表 ${sheets.findIndex((item) => item.id === sheet.id) + 1}`
                  const isActive = sheet.id === activeSheet?.id
                  const isSelected = selectedSheetIds.includes(sheet.id)
                  const isRenaming = renamingSheetId === sheet.id
                  const canRenameThisSheet = canManageWorkbook && !sidebarCollapsed

                  return (
                    <div
                      key={sheet.id}
                      onClickCapture={(event) => handleSheetCardClickCapture(event, sheet)}
                      onContextMenu={(event) => openSheetContextMenu(event, sheet)}
                      className={`${sidebarCollapsed ? 'flex h-14 w-14 items-center justify-center rounded-2xl border p-0' : 'block rounded-2xl border px-3 py-3'} transition ${
                        isSelected
                          ? 'border-amber-300 bg-amber-100 shadow-sm ring-1 ring-amber-200'
                          : isActive
                          ? 'border-sky-200 bg-sky-50 shadow-sm'
                          : 'border-slate-200 bg-slate-50/70 hover:border-slate-300 hover:bg-white'
                      }`}
                    >
                      <div className={sidebarCollapsed ? 'flex items-center justify-center' : 'flex items-center gap-3'}>
                        <Link
                          href={`/sheets/${workbookId}/${sheet.id}`}
                          prefetch={false}
                          className={`flex shrink-0 items-center justify-center rounded-xl ${sidebarCollapsed ? 'h-10 w-10' : 'h-9 w-9'} ${isSelected ? 'bg-amber-400 text-amber-950' : isActive ? 'bg-white text-sky-700' : 'bg-white text-slate-500'}`}
                          aria-label={`打开工作表 ${sheetLabel}`}
                          title={sidebarCollapsed ? `${sheetLabel}；Ctrl + 单击多选` : undefined}
                        >
                          {isSelected ? <Check className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                        </Link>
                        <div className={`min-w-0 flex-1 ${sidebarCollapsed ? 'hidden' : ''}`}>
                          {isRenaming ? (
                            <form
                              className="flex items-center gap-1.5"
                              onSubmit={(event) => {
                                event.preventDefault()
                                void handleRenameSheet(sheet)
                              }}
                            >
                              <input
                                type="text"
                                value={renamingSheetName}
                                onChange={(event) => setRenamingSheetName(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelRenameSheet()
                                  }
                                }}
                                className="h-8 min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2 text-sm font-semibold text-slate-900 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                                autoFocus
                              />
                              <button
                                type="submit"
                                disabled={sheetActionLoading}
                                className="ui-tooltip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                                title="保存名称"
                                aria-label="保存工作表名称"
                                data-tooltip="保存名称"
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={cancelRenameSheet}
                                className="ui-tooltip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
                                title="取消重命名"
                                aria-label="取消重命名"
                                data-tooltip="取消重命名"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </form>
                          ) : (
                            <>
                              <div className="flex min-w-0 items-center gap-2">
                                <Link
                                  href={`/sheets/${workbookId}/${sheet.id}`}
                                  prefetch={false}
                                  className={`min-w-0 flex-1 truncate text-sm font-semibold leading-5 ${isActive ? 'text-slate-900' : 'text-slate-700'}`}
                                  onDoubleClick={(event) => {
                                    if (!canRenameThisSheet) return
                                    event.preventDefault()
                                    startRenameSheet(sheet)
                                  }}
                                >
                                  {sheetLabel}
                                </Link>
                                {canRenameThisSheet && (
                                  <button
                                    type="button"
                                    onClick={() => startRenameSheet(sheet)}
                                    className="ui-tooltip inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white hover:text-slate-900"
                                    title="重命名工作表"
                                    aria-label={`重命名工作表 ${sheetLabel}`}
                                    data-tooltip="重命名工作表"
                                  >
                                    <PencilLine className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                              <Link
                                href={`/sheets/${workbookId}/${sheet.id}`}
                                prefetch={false}
                                className="mt-1 block text-[11px] leading-4 text-slate-500"
                              >
                                更新于 {new Date(sheet.updated_at).toLocaleString('zh-CN')}
                              </Link>
                              <div className="mt-2 flex flex-wrap gap-1">
                                {sheet.is_locked && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">锁定</span>}
                                {sheet.is_archived && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">归档</span>}
                                {sheet.is_hidden && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">隐藏</span>}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {filteredSheets.length === 0 && (
                  <div className={`rounded-2xl border border-dashed border-slate-300 bg-slate-50 text-center text-sm text-slate-500 ${sidebarCollapsed ? 'flex h-14 w-14 items-center justify-center p-0' : 'px-4 py-8'}`}>
                    {sidebarCollapsed ? <Search className="h-4 w-4 text-slate-300" /> : '未找到匹配的工作表'}
                  </div>
                )}
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-hidden">
            {activeSheet ? (
              <UniverSheetEditor
                key={activeSheet.id}
                workbookId={workbookId}
                workbookName={workbook.name}
                workbookSheets={sheets.map((item) => ({ id: item.id, name: item.name }))}
                sheet={activeSheet}
                reloadToken={String(reloadToken)}
                onExternalReload={refreshSilently}
                optimisticCanEdit={
                  optimisticEditableSheetId === activeSheet.id ||
                  (canManageWorkbook && (isAdminUser || (!workbook.is_locked && !activeSheet.is_locked && !activeSheet.is_archived)))
                }
                canImportWorkbook={canManageWorkbook}
              />
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

        {sheetContextMenu && (
          <div
            className="fixed z-[95] max-h-[75vh] w-60 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-2xl"
            style={{ left: sheetContextMenu.x, top: sheetContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {sheetContextMenu.batch && selectedSheets.length > 1 ? (
              <>
                <div className="border-b border-slate-100 px-3 py-2">
                  <div className="text-xs font-semibold text-amber-800">已选择 {selectedSheets.length} 个工作表</div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">{selectedSheets.map((sheet) => sheet.name).join('、')}</div>
                </div>
                {isAdminUser && (
                  <>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('lock')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-amber-50 disabled:opacity-50"><Lock className="h-4 w-4 text-amber-600" />批量锁定</button>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('unlock')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Unlock className="h-4 w-4 text-slate-400" />批量解除锁定</button>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('archive')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Archive className="h-4 w-4 text-slate-400" />批量归档</button>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('unarchive')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><ArchiveRestore className="h-4 w-4 text-slate-400" />批量取消归档</button>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('hide')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><EyeOff className="h-4 w-4 text-slate-400" />批量隐藏</button>
                    <button type="button" onClick={() => void handleBatchUpdateSheetState('unhide')} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Eye className="h-4 w-4 text-slate-400" />批量恢复可见</button>
                  </>
                )}
                {canManageWorkbook && (
                  <button type="button" onClick={() => void handleBatchDeleteSheets()} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Trash2 className="h-4 w-4" />批量删除</button>
                )}
                <button type="button" onClick={() => { setSelectedSheetIds([]); setSheetContextMenu(null) }} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-slate-500 hover:bg-slate-50"><X className="h-4 w-4" />清除选择</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => { router.push(`/sheets/${workbookId}/${sheetContextMenu.sheet.id}`); setSelectedSheetIds([]); setSheetContextMenu(null) }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50">
                  <FileSpreadsheet className="h-4 w-4 text-slate-400" />打开工作表
                </button>
                {canManageWorkbook && (
                  <button type="button" onClick={() => void handleDuplicateSheet(sheetContextMenu.sheet)} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-sky-50 disabled:opacity-50">
                    <Copy className="h-4 w-4 text-sky-600" />复制工作表
                  </button>
                )}
                <button type="button" onClick={() => { const target = sheetContextMenu.sheet; setSheetContextMenu(null); setWhatsAppResource({ sheetId: target.id, title: `${workbook.name} / ${target.name}`, defaultContent: `工作表：${workbook.name} / ${target.name}` }) }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-emerald-700 hover:bg-emerald-50">
                  <MessageCircle className="h-4 w-4 text-emerald-600" />发送到 WhatsApp
                </button>
                {canManageWorkbook && (
                  <button type="button" onClick={() => { setSidebarCollapsed(false); startRenameSheet(sheetContextMenu.sheet); setSelectedSheetIds([]); setSheetContextMenu(null) }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50">
                    <PencilLine className="h-4 w-4 text-slate-400" />重命名
                  </button>
                )}
                {isAdminUser && (
                  <>
                    <button type="button" onClick={() => { const target = sheetContextMenu.sheet; setSheetContextMenu(null); void handleUpdateSheetState(target, target.is_locked ? 'unlock' : 'lock') }} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-slate-700 hover:bg-slate-50">
                      {sheetContextMenu.sheet.is_locked ? <Unlock className="h-4 w-4 text-slate-400" /> : <Lock className="h-4 w-4 text-slate-400" />}{sheetContextMenu.sheet.is_locked ? '解除锁定' : '锁定工作表'}
                    </button>
                    <button type="button" onClick={() => { const target = sheetContextMenu.sheet; setSheetContextMenu(null); void handleUpdateSheetState(target, target.is_archived ? 'unarchive' : 'archive') }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50">
                      {sheetContextMenu.sheet.is_archived ? <ArchiveRestore className="h-4 w-4 text-slate-400" /> : <Archive className="h-4 w-4 text-slate-400" />}{sheetContextMenu.sheet.is_archived ? '取消归档' : '归档工作表'}
                    </button>
                    <button type="button" onClick={() => { const target = sheetContextMenu.sheet; setSheetContextMenu(null); void handleUpdateSheetState(target, target.is_hidden ? 'unhide' : 'hide') }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50">
                      {sheetContextMenu.sheet.is_hidden ? <Eye className="h-4 w-4 text-slate-400" /> : <EyeOff className="h-4 w-4 text-slate-400" />}{sheetContextMenu.sheet.is_hidden ? '恢复可见' : '隐藏工作表'}
                    </button>
                  </>
                )}
                {canManageWorkbook && (
                  <button type="button" onClick={() => { const target = sheetContextMenu.sheet; setSelectedSheetIds([]); setSheetContextMenu(null); void handleDeleteSheet(target) }} disabled={sheetActionLoading} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                    <Trash2 className="h-4 w-4" />删除工作表
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <WhatsAppSendDialog open={Boolean(whatsAppResource)} resource={whatsAppResource} onClose={() => setWhatsAppResource(null)} />
      </div>
    </AuthGuard>
  )
}
