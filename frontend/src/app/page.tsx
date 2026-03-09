'use client'

import {
  ArrowRight,
  ChevronRight,
  Database,
  FolderIcon,
  FolderKanban,
  FolderPlus,
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
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { useWorkbooks } from '@/hooks/useSheet'
import { useFileManager } from '@/hooks/useFileManager'
import api from '@/lib/api'
import { clearTokens, fetchCurrentUser, getStoredUser, isAdmin } from '@/lib/auth'
import type { AuthUser } from '@/types'

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
  const searchRef = useRef<HTMLDivElement>(null)

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
      (wb) => fuzzyMatch(searchQuery, wb.name) || fuzzyMatch(searchQuery, wb.description || '')
    )
  }, [workbooks, searchQuery])

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
      await api.post('/workbooks', { name: newName.trim() })
      setNewName('')
      setCreating(false)
      await refresh()
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

  const adminMode = isAdmin(profile)

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
                  <div className="text-sm text-slate-500">当前用户</div>
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
                    所有表格入口集中在同一工作台
                  </div>
                </div>

                <div className="rounded-[24px] border border-slate-200 bg-white/95 p-4 shadow-sm sm:col-span-2">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm text-slate-500">会话操作</div>
                      <div className="mt-1 text-lg font-semibold text-slate-950">
                        {adminMode ? '管理员模式已启用' : '标准成员模式'}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
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
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
                      >
                        <Images className="h-4 w-4" />
                        图库
                      </button>
                      <button
                        type="button"
                        onClick={handleLogout}
                        disabled={loggingOut}
                        className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <LogOut className="h-4 w-4" />
                        {loggingOut ? '退出中...' : '退出登录'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </header>

          {creating && (
            <section className="rounded-[28px] border border-slate-200/80 bg-white/85 p-4 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur md:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
                <div className="flex-1 space-y-2">
                  <div className="text-sm font-semibold text-slate-800">创建新的业务工作簿</div>
                  <p className="text-sm text-slate-500">
                    可以从销售、采购、库存或人事主题开始，后续在工作表里逐步扩展字段与权限。
                  </p>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateWorkbook()}
                    placeholder="例如：销售订单中心、员工台账"
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100"
                    autoFocus
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCreateWorkbook}
                    className="inline-flex items-center justify-center rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800"
                  >
                    创建工作簿
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false)
                      setNewName('')
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                  >
                    取消
                  </button>
                </div>
              </div>
            </section>
          )}

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
                  用工作簿组织你的业务模块，再在工作表里扩展字段、权限和协作规则。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreatingFolder(true)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
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

            {/* Folder list */}
            {contents.folders.length > 0 && (
              <div className="mb-4 grid gap-3 md:grid-cols-3 lg:grid-cols-4">
                {contents.folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => void navigateToFolder(folder.id)}
                    className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 text-left transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md"
                  >
                    <FolderIcon className="h-8 w-8 flex-shrink-0 text-amber-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-900">{folder.name}</div>
                      <div className="text-xs text-slate-400">文件夹</div>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            )

            {/* Search bar */}
            {!loading && workbooks.length > 0 && (
              <div ref={searchRef} className="relative mb-5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    placeholder="搜索工作簿名称..."
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
                {/* Suggestions dropdown */}
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
                          <div className="truncate text-xs text-slate-400">{wb.description || '无描述'}</div>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 flex-shrink-0 text-slate-300" />
                      </button>
                    ))}
                  </div>
                )}
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

            {!loading && !error && filteredWorkbooks.length > 0 && (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filteredWorkbooks.map((workbook) => (
                  <div
                    key={workbook.id}
                    className="group relative rounded-[26px] border border-slate-200 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.98))] p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_22px_50px_-30px_rgba(15,23,42,0.45)]"
                  >
                    {adminMode && (
                      <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
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
                      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500">
                        <FolderKanban className="h-3.5 w-3.5 text-sky-600" />
                        工作簿 #{workbook.id}
                      </div>
                      <h3 className="text-xl font-semibold text-slate-950">{workbook.name}</h3>
                      <p className="mt-2 min-h-[48px] text-sm leading-6 text-slate-500">
                        {workbook.description?.trim() || '进入后可添加多个工作表，并继续扩展字段、权限和自动化流程。'}
                      </p>
                      <div className="mt-5 flex items-center justify-between text-sm text-slate-500">
                        <span>创建于 {new Date(workbook.created_at).toLocaleDateString('zh-CN')}</span>
                        <span className="inline-flex items-center gap-1 font-medium text-sky-700">
                          打开
                          <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                        </span>
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

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
