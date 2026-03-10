'use client'

import {
  ArrowRight,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FolderIcon,
  FolderKanban,
  FolderPlus,
  Layers3,
  Images,
  LogOut,
  MessageSquare,
  PencilLine,
  Plus,
  Search,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  Users,
  UserRoundPlus,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { useWorkbooks } from '@/hooks/useSheet'
import { useFileManager } from '@/hooks/useFileManager'
import api from '@/lib/api'
import { clearTokens, fetchCurrentUser, getStoredUser, isAdmin } from '@/lib/auth'
import type { AuthUser, PageData, User, Workbook } from '@/types'

const adminLinks = [
  {
    title: '员工账号',
    description: '维护员工资料、角色与账号状态。',
    href: '/admin/users',
    icon: Users,
  },
  {
    title: '角色管理',
    description: '配置管理员、编辑者、查看者等角色。',
    href: '/admin/roles',
    icon: Shield,
  },
  {
    title: '权限矩阵',
    description: '按工作表和字段控制可见、只读与编辑能力。',
    href: '/admin/permissions',
    icon: Settings2,
  },
  {
    title: '数据备份',
    description: '下载数据库备份、配置导出或完整归档。',
    href: '/admin/backup',
    icon: Database,
  },
  {
    title: 'AI 助手',
    description: '配置 AI 对话接口和模型参数。',
    href: '/admin/ai',
    icon: MessageSquare,
  },
]

export default function HomePage() {
  const router = useRouter()
  const { workbooks, loading, error, refresh } = useWorkbooks()
  const {
    currentFolderId,
    contents,
    breadcrumb,
    loading: folderLoading,
    navigateTo: navigateToFolder,
    refresh: refreshFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    moveWorkbook,
  } = useFileManager()
  const [creating, setCreating] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newName, setNewName] = useState('')
  const [profile, setProfile] = useState<AuthUser | null>(getStoredUser())
  const [loggingOut, setLoggingOut] = useState(false)
  const [editingWorkbook, setEditingWorkbook] = useState<{ id: number; name: string } | null>(null)
  const [editWorkbookName, setEditWorkbookName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [workbookSortBy, setWorkbookSortBy] = useState<'updated_at' | 'created_at' | 'name'>('updated_at')
  const [workbookSortOrder, setWorkbookSortOrder] = useState<'asc' | 'desc'>('desc')
  const [groupByOwner, setGroupByOwner] = useState(true)
  const [workbookPage, setWorkbookPage] = useState(1)
  const [assigningWorkbook, setAssigningWorkbook] = useState<Workbook | null>(null)
  const [assignableUsers, setAssignableUsers] = useState<User[]>([])
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<number[]>([])
  const [assignmentLoading, setAssignmentLoading] = useState(false)
  const [assignmentMessage, setAssignmentMessage] = useState('')
  const [folderSearchQuery, setFolderSearchQuery] = useState('')
  const [folderPage, setFolderPage] = useState(1)
  const [movingWorkbookId, setMovingWorkbookId] = useState<number | null>(null)
  const [draggedWorkbookId, setDraggedWorkbookId] = useState<number | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const adminMode = isAdmin(profile)
  const workbookPageSize = adminMode ? 12 : 9

  // Fuzzy match: each char of query must appear in order within target
  const fuzzyMatch = (query: string, target: string): boolean => {
    const q = query.toLowerCase()
    const t = target.toLowerCase()
    let qi = 0
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) qi++
    }
    return qi === q.length
  }

  const filteredWorkbooks = useMemo(() => {
    if (!searchQuery.trim()) return workbooks
    return workbooks.filter(
      (wb) =>
        fuzzyMatch(searchQuery, wb.name) ||
        fuzzyMatch(searchQuery, wb.description || '') ||
        fuzzyMatch(searchQuery, wb.owner_name || '')
    )
  }, [workbooks, searchQuery])

  const sortedWorkbooks = useMemo(() => {
    return [...filteredWorkbooks].sort((left, right) => {
      if (workbookSortBy === 'name') {
        const compare = left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
        return workbookSortOrder === 'asc' ? compare : -compare
      }

      const leftValue = new Date(left[workbookSortBy]).getTime()
      const rightValue = new Date(right[workbookSortBy]).getTime()
      return workbookSortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue
    })
  }, [filteredWorkbooks, workbookSortBy, workbookSortOrder])

  const totalWorkbookPages = Math.max(1, Math.ceil(sortedWorkbooks.length / workbookPageSize))
  const paginatedWorkbooks = useMemo(() => {
    const start = (workbookPage - 1) * workbookPageSize
    return sortedWorkbooks.slice(start, start + workbookPageSize)
  }, [sortedWorkbooks, workbookPage, workbookPageSize])

  const workbookGroups = useMemo(() => {
    if (!adminMode || !groupByOwner) {
      return [{ label: '', items: paginatedWorkbooks }]
    }

    const groups = new Map<string, Workbook[]>()
    paginatedWorkbooks.forEach((workbook) => {
      const label = workbook.owner_name || `用户 #${workbook.owner_id}`
      const existing = groups.get(label) || []
      existing.push(workbook)
      groups.set(label, existing)
    })

    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
  }, [adminMode, groupByOwner, paginatedWorkbooks])

  const foldersPerPage = 8
  const filteredFolders = useMemo(() => {
    const keyword = folderSearchQuery.trim().toLowerCase()
    if (!keyword) return contents.folders
    return contents.folders.filter((f) => f.name.toLowerCase().includes(keyword))
  }, [contents.folders, folderSearchQuery])
  const totalFolderPages = Math.max(1, Math.ceil(filteredFolders.length / foldersPerPage))
  const paginatedFolders = useMemo(() => {
    const start = (folderPage - 1) * foldersPerPage
    return filteredFolders.slice(start, start + foldersPerPage)
  }, [filteredFolders, folderPage])
  const currentFolderWorkbooks = useMemo(() => {
    return [...contents.workbooks].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }, [contents.workbooks])

  useEffect(() => { setFolderPage(1) }, [folderSearchQuery])
  useEffect(() => {
    if (folderPage > totalFolderPages) setFolderPage(totalFolderPages)
  }, [folderPage, totalFolderPages])

  // Suggestions: top 5 matching names shown in dropdown
  const suggestions = useMemo(() => {
    if (!searchQuery.trim() || !searchFocused) return []
    return workbooks
      .filter((wb) => fuzzyMatch(searchQuery, wb.name))
      .slice(0, 5)
  }, [workbooks, searchQuery, searchFocused])

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchFocused(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    let mounted = true

    async function loadProfile() {
      try {
        const user = await fetchCurrentUser()
        if (mounted && user) {
          setProfile(user)
        }
      } catch {
        // AuthGuard handles invalid sessions.
      }
    }

    loadProfile()

    return () => {
      mounted = false
    }
  }, [])

  const handleCreateWorkbook = async () => {
    if (!newName.trim()) return

    try {
      await api.post('/workbooks', { name: newName.trim(), folder_id: currentFolderId })
      setNewName('')
      setCreating(false)
      await Promise.all([refresh(), refreshFolder()])
    } catch (err) {
      console.error('Failed to create workbook:', err)
    }
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await api.post('/auth/logout')
    } catch {
      // Ignore logout API failures and clear local state anyway.
    } finally {
      clearTokens()
      router.push('/login')
      setLoggingOut(false)
    }
  }

  useEffect(() => {
    setWorkbookPage(1)
  }, [searchQuery, workbookSortBy, workbookSortOrder, groupByOwner])

  useEffect(() => {
    if (workbookPage > totalWorkbookPages) {
      setWorkbookPage(totalWorkbookPages)
    }
  }, [workbookPage, totalWorkbookPages])

  useEffect(() => {
    if (!assigningWorkbook || !adminMode) return

    let active = true
    ;(async () => {
      try {
        const res = await api.get<PageData<User>>('/users?page=1&size=200')
        if (!active || res.code !== 0 || !res.data) return
        const users = res.data.list.filter((user) => {
          const isAdminUser = user.roles?.some((role) => role.code === 'admin')
          return user.status === 1 && !isAdminUser
        })
        setAssignableUsers(users)
      } catch (err) {
        console.error('Failed to load assignable users:', err)
      }
    })()

    return () => {
      active = false
    }
  }, [adminMode, assigningWorkbook])

  const handleDeleteWorkbook = async (e: React.MouseEvent, workbookId: number) => {
    e.stopPropagation()
    if (!confirm('确定要删除此工作簿吗？其下所有工作表和数据将一并删除。')) return
    try {
      await api.delete(`/workbooks/${workbookId}`)
      await refresh()
    } catch (err) {
      console.error('Failed to delete workbook:', err)
    }
  }

  const handleRenameWorkbook = async () => {
    if (!editingWorkbook || !editWorkbookName.trim()) return
    try {
      await api.put(`/workbooks/${editingWorkbook.id}`, { name: editWorkbookName.trim() })
      setEditingWorkbook(null)
      await refresh()
    } catch (err) {
      console.error('Failed to rename workbook:', err)
    }
  }

  const handleMoveWorkbookToFolder = async (workbookId: number, targetFolderId: number | null) => {
    setMovingWorkbookId(workbookId)
    try {
      await moveWorkbook(workbookId, targetFolderId)
      await refresh()
    } catch (err) {
      console.error('Failed to move workbook:', err)
    } finally {
      setMovingWorkbookId(null)
    }
  }

  const handleDeleteFolder = async (folderId: number, folderName: string) => {
    if (!confirm(`确定要删除文件夹「${folderName}」吗？文件夹中的工作簿会回到根目录。`)) return
    try {
      await deleteFolder(folderId)
      await refresh()
    } catch (err) {
      console.error('Failed to delete folder:', err)
    }
  }

  const handleAssignWorkbook = async () => {
    if (!assigningWorkbook || selectedAssigneeIds.length === 0) return

    setAssignmentLoading(true)
    setAssignmentMessage('')

    try {
      const res = await api.post(`/workbooks/${assigningWorkbook.id}/assign`, {
        user_ids: selectedAssigneeIds,
      })

      if (res.code !== 0) {
        setAssignmentMessage(res.message || '发放任务失败，请稍后重试。')
        return
      }

      setAssignmentMessage(`已向 ${selectedAssigneeIds.length} 位员工发放任务工作簿。`)
      setSelectedAssigneeIds([])
      await refresh()
    } catch (err) {
      console.error('Failed to assign workbook:', err)
      setAssignmentMessage('发放任务失败，请稍后重试。')
    } finally {
      setAssignmentLoading(false)
    }
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)]">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-4 p-3 md:p-6">
          <header className="overflow-hidden rounded-[32px] border border-white/70 bg-white/80 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.7)] backdrop-blur">
            <div className="flex flex-col gap-6 px-4 py-5 md:px-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  YaERP Workspace
                </div>
                <div className="space-y-3">
                  <h1 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-5xl">
                    像表格一样驱动你的业务流程
                  </h1>
                  <p className="max-w-3xl text-sm leading-7 text-slate-600 md:text-base">
                    以 Excel 交互习惯为核心，把工作簿、权限和员工协作统一到一个工作台里。
                    首页现在和编辑页保持同一套视觉语言，便于你继续逐步扩展整个 ERP UI。
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[460px]">
                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-slate-500">当前用户</div>
                    <button
                      type="button"
                      onClick={handleLogout}
                      disabled={loggingOut}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <LogOut className="h-3 w-3" />
                      {loggingOut ? '退出中...' : '退出'}
                    </button>
                  </div>
                  <div className="mt-1 text-xl font-semibold text-slate-950">
                    {profile?.username || '未加载'}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {profile?.roles?.map((role) => (
                      <span
                        key={role.id}
                        className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600"
                      >
                        {role.name}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm">
                  <div className="text-sm text-slate-500">工作簿总数</div>
                  <div className="mt-1 text-3xl font-semibold text-slate-950">{workbooks.length}</div>
                  <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                    <FolderKanban className="h-4 w-4 text-sky-600" />
                    {adminMode ? '管理员模式已启用' : '所有表格入口集中在同一工作台'}
                  </div>
                </div>
              </div>
            </div>
          </header>

          {adminMode && (
            <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                    Admin Center
                  </div>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-950">管理员快捷入口</h2>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-5">
                {adminLinks.map((item) => {
                  const Icon = item.icon

                  return (
                    <button
                      key={item.href}
                      type="button"
                      onClick={() => router.push(item.href)}
                      className="group rounded-[24px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,250,252,0.98))] p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_20px_45px_-28px_rgba(15,23,42,0.45)]"
                    >
                      <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="text-lg font-semibold text-slate-950">{item.title}</div>
                      <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
                      <div className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-sky-700">
                        进入管理
                        <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Workbooks
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">业务工作簿</h2>
                <p className="mt-2 text-sm text-slate-500">
                  {adminMode
                    ? '管理员可按员工查看全部工作簿，并按时间排序、搜索和发放任务模板。'
                    : '用工作簿组织你的业务模块，再在工作表里扩展字段、权限和协作规则。'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreatingFolder(true)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
                </button>
                <button
                  type="button"
                  onClick={() => setCreating((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800"
                >
                  <Plus className="h-4 w-4" />
                  新建工作簿
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/gallery')}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <Images className="h-4 w-4" />
                  图库
                </button>
              </div>
            </div>

            {/* Breadcrumb */}
            {breadcrumb.length > 0 && (
              <div className="mb-4 flex items-center gap-1 text-sm text-slate-500">
                <button
                  type="button"
                  onClick={() => void navigateToFolder(null)}
                  className="font-medium text-sky-700 transition hover:text-sky-900"
                >
                  根目录
                </button>
                {breadcrumb.map((folder) => (
                  <span key={folder.id} className="flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                    <button
                      type="button"
                      onClick={() => void navigateToFolder(folder.id)}
                      className={`font-medium transition ${
                        folder.id === currentFolderId
                          ? 'text-slate-900'
                          : 'text-sky-700 hover:text-sky-900'
                      }`}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Create folder inline */}
            {creatingFolder && (
              <div className="mb-4 flex items-center gap-3">
                <FolderIcon className="h-5 w-5 text-amber-500" />
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim()) {
                      void createFolder(newFolderName.trim()).then(() => {
                        setNewFolderName('')
                        setCreatingFolder(false)
                      })
                    }
                    if (e.key === 'Escape') {
                      setCreatingFolder(false)
                      setNewFolderName('')
                    }
                  }}
                  placeholder="输入文件夹名称，按 Enter 创建"
                  className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => { setCreatingFolder(false); setNewFolderName('') }}
                  className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {creating && (
              <div className="mb-4 flex items-center gap-3">
                <FolderKanban className="h-5 w-5 text-sky-600" />
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newName.trim()) {
                      void handleCreateWorkbook()
                    }
                    if (e.key === 'Escape') {
                      setCreating(false)
                      setNewName('')
                    }
                  }}
                  placeholder={currentFolderId !== null ? '输入工作簿名称，按 Enter 创建到当前文件夹' : '输入工作簿名称，按 Enter 创建'}
                  className="h-10 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName('') }}
                  className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Folder list */}
            {contents.folders.length > 0 && (
              <div className="mb-4 space-y-3">
                {/* Folder search + pagination toolbar */}
                {contents.folders.length > foldersPerPage && (
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 max-w-xs">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={folderSearchQuery}
                        onChange={(e) => setFolderSearchQuery(e.target.value)}
                        placeholder="搜索文件夹..."
                        className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      />
                    </div>
                    <div className="text-xs text-slate-500">
                      {filteredFolders.length} 个文件夹 / 第 {folderPage} 页
                    </div>
                    <button
                      type="button"
                      onClick={() => setFolderPage((c) => Math.max(1, c - 1))}
                      disabled={folderPage <= 1}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFolderPage((c) => Math.min(totalFolderPages, c + 1))}
                      disabled={folderPage >= totalFolderPages}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
                  {paginatedFolders.map((folder) => (
                    <div
                      key={folder.id}
                      onDragOver={(event) => {
                        if (draggedWorkbookId !== null) {
                          event.preventDefault()
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        if (draggedWorkbookId !== null) {
                          void handleMoveWorkbookToFolder(draggedWorkbookId, folder.id)
                          setDraggedWorkbookId(null)
                        }
                      }}
                      className={`group rounded-2xl border bg-white/90 p-4 text-left transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md ${
                        draggedWorkbookId !== null ? 'border-dashed border-slate-300' : 'border-slate-200'
                      }`}
                    >
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => void navigateToFolder(folder.id)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <FolderIcon className="h-8 w-8 flex-shrink-0 text-amber-400" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-slate-900">{folder.name}</div>
                            <div className="text-xs text-slate-400">可拖入工作簿</div>
                          </div>
                          <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFolder(folder.id, folder.name)}
                          className="rounded-full p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
                          title="删除文件夹"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentFolderId !== null && (
              <div className="mb-6 space-y-3 rounded-[24px] border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">当前文件夹中的工作簿</div>
                    <div className="text-xs text-slate-500">新建工作簿会直接进入这里，也可以把现有工作簿移进来。</div>
                  </div>
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500">
                    {currentFolderWorkbooks.length} 个工作簿
                  </div>
                </div>

                {currentFolderWorkbooks.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                    当前文件夹里还没有工作簿。你可以直接在这里新建，或从下方总列表把工作簿移入当前文件夹。
                  </div>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {currentFolderWorkbooks.map((workbook) => (
                      <div
                        key={`folder-${workbook.id}`}
                        draggable
                        onDragStart={() => setDraggedWorkbookId(workbook.id)}
                        onDragEnd={() => setDraggedWorkbookId(null)}
                        className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <button type="button" onClick={() => router.push(`/sheets/${workbook.id}`)} className="w-full text-left">
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <FolderKanban className="h-3.5 w-3.5 text-sky-600" />
                            工作簿 #{workbook.id}
                          </div>
                          <div className="mt-2 text-lg font-semibold text-slate-950">{workbook.name}</div>
                          <div className="mt-1 text-sm text-slate-500">{workbook.description?.trim() || '当前文件夹内的工作簿'}</div>
                        </button>
                        <div className="mt-4 flex items-center justify-between gap-3">
                          <div className="text-xs text-slate-400">更新于 {new Date(workbook.updated_at).toLocaleString('zh-CN')}</div>
                          <button
                            type="button"
                            onClick={() => handleMoveWorkbookToFolder(workbook.id, null)}
                            disabled={movingWorkbookId === workbook.id}
                            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {movingWorkbookId === workbook.id ? '处理中...' : '移出文件夹'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Search bar */}
            {!loading && workbooks.length > 0 && (
              <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div ref={searchRef} className="relative flex-1 xl:max-w-xl">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onFocus={() => setSearchFocused(true)}
                      placeholder={adminMode ? '搜索工作簿 / 描述 / 员工...' : '搜索工作簿名称...'}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-11 pr-10 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => { setSearchQuery(''); setSearchFocused(false) }}
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {suggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-2xl border border-slate-200 bg-white py-1 shadow-lg">
                      {suggestions.map((wb) => (
                        <button
                          key={wb.id}
                          type="button"
                          onClick={() => { router.push(`/sheets/${wb.id}`); setSearchFocused(false) }}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50"
                        >
                          <FolderKanban className="h-4 w-4 flex-shrink-0 text-sky-600" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-slate-900">{wb.name}</div>
                            <div className="truncate text-xs text-slate-400">{wb.owner_name || wb.description || '无描述'}</div>
                          </div>
                          <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-slate-300" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={workbookSortBy}
                    onChange={(event) => setWorkbookSortBy(event.target.value as 'updated_at' | 'created_at' | 'name')}
                    className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  >
                    <option value="updated_at">按更新时间</option>
                    <option value="created_at">按创建时间</option>
                    <option value="name">按名称</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setWorkbookSortOrder((current) => (current === 'desc' ? 'asc' : 'desc'))}
                    className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    <ArrowUpDown className="h-4 w-4" />
                    {workbookSortOrder === 'desc' ? '降序' : '升序'}
                  </button>
                  {adminMode && (
                    <button
                      type="button"
                      onClick={() => setGroupByOwner((current) => !current)}
                      className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition ${
                        groupByOwner
                          ? 'border-sky-200 bg-sky-50 text-sky-700'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Layers3 className="h-4 w-4" />
                      {groupByOwner ? '按员工分组中' : '按员工分组'}
                    </button>
                  )}
                </div>
                {/* Suggestions dropdown */}
              </div>
            )}

            {loading && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center text-slate-500">
                正在加载工作簿...
              </div>
            )}

            {error && (
              <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-6 py-6 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {!loading && !error && workbooks.length === 0 && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.98))] px-6 py-14 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-900 text-white">
                  <FolderKanban className="h-7 w-7" />
                </div>
                <h3 className="text-2xl font-semibold text-slate-950">还没有工作簿</h3>
                <p className="mt-3 text-sm leading-7 text-slate-500">
                  从一个基础业务台账开始，后续可以逐步延展成销售、库存、采购和人事模块。
                </p>
              </div>
            )}

            {!loading && !error && workbooks.length > 0 && filteredWorkbooks.length === 0 && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                <Search className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                <h3 className="text-lg font-semibold text-slate-700">没有找到匹配的工作簿</h3>
                <p className="mt-2 text-sm text-slate-400">试试其他关键词，或清除搜索条件查看全部。</p>
              </div>
            )}

            {!loading && !error && paginatedWorkbooks.length > 0 && (
              <div className="space-y-6">
                {workbookGroups.map((group) => (
                  <div key={group.label || 'default'} className="space-y-3">
                    {group.label && (
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                        <Users className="h-4 w-4 text-sky-600" />
                        {group.label}
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                          {group.items.length} 个工作簿
                        </span>
                      </div>
                    )}
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {group.items.map((workbook) => (
                        <div
                          key={workbook.id}
                          draggable
                          onDragStart={() => setDraggedWorkbookId(workbook.id)}
                          onDragEnd={() => setDraggedWorkbookId(null)}
                          className="group relative rounded-[22px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.98))] p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_22px_50px_-30px_rgba(15,23,42,0.45)]"
                        >
                          {adminMode && (
                            <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setAssigningWorkbook(workbook)
                                  setSelectedAssigneeIds([])
                                  setAssignmentMessage('')
                                }}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-sky-200 bg-sky-50 text-sky-600 transition hover:bg-sky-100"
                                title="发放任务"
                              >
                                <UserRoundPlus className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingWorkbook({ id: workbook.id, name: workbook.name })
                                  setEditWorkbookName(workbook.name)
                                }}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                                title="重命名"
                              >
                                <PencilLine className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteWorkbook(e, workbook.id)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
                                title="删除工作簿"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => router.push(`/sheets/${workbook.id}`)}
                            className="w-full text-left"
                          >
                            <div className="mb-4 flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500">
                                <FolderKanban className="h-3.5 w-3.5 text-sky-600" />
                                工作簿 #{workbook.id}
                              </span>
                              {adminMode && workbook.owner_name && (
                                <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                                  <Users className="h-3.5 w-3.5" />
                                  {workbook.owner_name}
                                </span>
                              )}
                            </div>
                            <h3 className="text-lg font-semibold text-slate-950">{workbook.name}</h3>
                            <p className="mt-2 min-h-[40px] text-sm leading-6 text-slate-500">
                              {workbook.description?.trim() || '进入后可添加多个工作表，并继续扩展字段、权限和自动化流程。'}
                            </p>
                            <div className="mt-5 space-y-1 text-sm text-slate-500">
                              <div>创建于 {new Date(workbook.created_at).toLocaleDateString('zh-CN')}</div>
                              <div>更新于 {new Date(workbook.updated_at).toLocaleString('zh-CN')}</div>
                            </div>
                          </button>
                          <div className="mt-5 flex items-center justify-between gap-3">
                            {currentFolderId !== null && (
                              workbook.folder_id === currentFolderId ? (
                                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                                  已在当前文件夹
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleMoveWorkbookToFolder(workbook.id, currentFolderId)}
                                  disabled={movingWorkbookId === workbook.id}
                                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {movingWorkbookId === workbook.id ? '移动中...' : '移入当前文件夹'}
                                </button>
                              )
                            )}
                            <button
                              type="button"
                              onClick={() => router.push(`/sheets/${workbook.id}`)}
                              className="ml-auto inline-flex items-center text-sm font-medium text-sky-700"
                            >
                              打开
                              <ArrowRight className="ml-1 h-4 w-4 transition group-hover:translate-x-0.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3">
                  <div className="text-sm text-slate-500">
                    共 {sortedWorkbooks.length} 个工作簿，当前第 {workbookPage} / {totalWorkbookPages} 页
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setWorkbookPage((current) => Math.max(1, current - 1))}
                      disabled={workbookPage <= 1}
                      className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      上一页
                    </button>
                    <button
                      type="button"
                      onClick={() => setWorkbookPage((current) => Math.min(totalWorkbookPages, current + 1))}
                      disabled={workbookPage >= totalWorkbookPages}
                      className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {assigningWorkbook && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
              <div className="w-full max-w-2xl rounded-[28px] border border-white/70 bg-white p-6 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.75)] md:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Task Assignment</div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">发放任务工作簿</h2>
                    <p className="mt-2 text-sm text-slate-500">
                      将工作簿「{assigningWorkbook.name}」复制给选中的员工，作为待执行任务模板。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAssigningWorkbook(null)
                      setSelectedAssigneeIds([])
                    }}
                    className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {assignmentMessage && (
                  <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-700">
                    {assignmentMessage}
                  </div>
                )}

                <div className="max-h-[380px] space-y-3 overflow-y-auto pr-1">
                  {assignableUsers.map((user) => {
                    const checked = selectedAssigneeIds.includes(user.id)

                    return (
                      <label
                        key={user.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                          checked ? 'border-sky-200 bg-sky-50' : 'border-slate-200 bg-slate-50/60 hover:bg-white'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedAssigneeIds((current) =>
                              event.target.checked
                                ? [...current, user.id]
                                : current.filter((id) => id !== user.id)
                            )
                          }}
                          className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-900">{user.username}</div>
                          <div className="truncate text-sm text-slate-500">{user.email}</div>
                        </div>
                      </label>
                    )
                  })}
                  {assignableUsers.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                      暂无可发放任务的员工账号。
                    </div>
                  )}
                </div>

                <div className="mt-6 flex items-center justify-between gap-3">
                  <div className="text-sm text-slate-500">
                    已选择 {selectedAssigneeIds.length} 位员工
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setAssigningWorkbook(null)
                        setSelectedAssigneeIds([])
                      }}
                      className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleAssignWorkbook}
                      disabled={assignmentLoading || selectedAssigneeIds.length === 0}
                      className="rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {assignmentLoading ? '发放中...' : '发放任务'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Rename Workbook Dialog */}
          {editingWorkbook && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
              <div className="w-full max-w-md rounded-[28px] border border-white/70 bg-white p-6 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.75)] md:p-8">
                <div className="mb-6">
                  <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                    Rename
                  </div>
                  <h2 className="mt-2 text-2xl font-semibold text-slate-950">重命名工作簿</h2>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">工作簿名称</label>
                  <input
                    type="text"
                    value={editWorkbookName}
                    onChange={(e) => setEditWorkbookName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRenameWorkbook()}
                    className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    autoFocus
                  />
                </div>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setEditingWorkbook(null)}
                    className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleRenameWorkbook}
                    className="rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800"
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AuthGuard>
  )
}
