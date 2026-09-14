'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  ArrowDown,
  ArrowUp,
  Command,
  CornerDownLeft,
  FileSpreadsheet,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useFloatingDrag, type FloatingDragPosition } from '@/hooks/useFloatingDrag'
import { getStoredUser, isAdmin, isAuthenticated } from '@/lib/auth'
import api from '@/lib/api'
import type { Workbook } from '@/types'
import {
  ADMIN_MODULES,
  BUSINESS_MODULES,
  findModuleById,
  type AppModule,
} from './appModules'

const OPEN_EVENT = 'yaerp:open-command-palette'
const LAUNCHER_POSITION_KEY = 'yaerp:command-launcher-position'
const RECENT_KEY = 'yaerp:command-recent'
const MAX_RECENT = 6
const MAX_WORKBOOKS = 12

interface RecentEntry {
  kind: 'nav' | 'workbook'
  id: string
  label: string
  description?: string
  href: string
}

interface PaletteItem {
  key: string
  label: string
  description?: string
  href: string
  icon: LucideIcon
  meta?: string
  recent: RecentEntry
}

type PaletteRow =
  | { type: 'header'; title: string }
  | { type: 'item'; item: PaletteItem; index: number }

function readLauncherPosition(): FloatingDragPosition | null {
  try {
    const raw = window.localStorage.getItem(LAUNCHER_POSITION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<FloatingDragPosition>
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {
    // Ignore malformed storage.
  }
  return null
}

function readRecent(): RecentEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is RecentEntry =>
          !!entry &&
          (entry.kind === 'nav' || entry.kind === 'workbook') &&
          typeof entry.id === 'string' &&
          typeof entry.label === 'string' &&
          typeof entry.href === 'string',
      )
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

function matchesQuery(query: string, values: Array<string | undefined | null>) {
  if (!query) return true
  return values.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(query),
  )
}

function moduleToItem(module: AppModule): PaletteItem {
  return {
    key: `nav:${module.id}`,
    label: module.label,
    description: module.description,
    href: module.href,
    icon: module.icon,
    recent: {
      kind: 'nav',
      id: module.id,
      label: module.label,
      description: module.description,
      href: module.href,
    },
  }
}

function workbookToItem(workbook: Workbook): PaletteItem {
  const firstSheet = workbook.sheets?.[0]
  const sheetCount = workbook.sheets?.length ?? 0
  const href = firstSheet
    ? `/sheets/${workbook.id}/${firstSheet.id}`
    : `/sheets/${workbook.id}`
  const description = workbook.owner_name
    ? `所有者：${workbook.owner_name}`
    : workbook.description || '工作簿'

  return {
    key: `workbook:${workbook.id}`,
    label: workbook.name || `工作簿 #${workbook.id}`,
    description,
    href,
    icon: FileSpreadsheet,
    meta: sheetCount > 0 ? `${sheetCount} 个工作表` : undefined,
    recent: {
      kind: 'workbook',
      id: String(workbook.id),
      label: workbook.name || `工作簿 #${workbook.id}`,
      description,
      href,
    },
  }
}

function recentToItem(entry: RecentEntry): PaletteItem {
  return {
    key: `recent:${entry.kind}:${entry.id}`,
    label: entry.label,
    description: entry.description,
    href: entry.href,
    icon:
      entry.kind === 'nav'
        ? (findModuleById(entry.id)?.icon ?? Command)
        : FileSpreadsheet,
    recent: entry,
  }
}

export default function GlobalQuickNav() {
  const [mounted, setMounted] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    setMounted(true)
  }, [])

  // First paint must match the server output (no access to storage yet), so the
  // whole widget only renders once we are safely on the client.
  if (!mounted) return null

  const authenticated = isAuthenticated()
  if (!authenticated || pathname === '/login') return null

  return <QuickNavWidget admin={isAdmin(getStoredUser())} />
}

function QuickNavWidget({ admin }: { admin: boolean }) {
  const router = useRouter()
  const pathname = usePathname()

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [workbooks, setWorkbooks] = useState<Workbook[] | null>(null)
  const [loadingWorkbooks, setLoadingWorkbooks] = useState(false)
  const [recent, setRecent] = useState<RecentEntry[]>(readRecent)
  const isMac = useMemo(
    () =>
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad|iPod/.test(navigator.userAgent),
    [],
  )
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl K'

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)

  const drag = useFloatingDrag({
    elementRef: launcherRef,
    ignoreInteractive: false,
    initialPosition: useMemo(readLauncherPosition, []),
  })

  // Persist the launcher position (debounced) so it stays where the user put it.
  useEffect(() => {
    if (!drag.position) return
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          LAUNCHER_POSITION_KEY,
          JSON.stringify(drag.position),
        )
      } catch {
        // Storage may be unavailable; dragging still works for this session.
      }
    }, 200)
    return () => window.clearTimeout(timeout)
  }, [drag.position])

  const loadWorkbooks = useCallback(async () => {
    setLoadingWorkbooks(true)
    try {
      const res = await api.get<Workbook[]>('/workbooks')
      setWorkbooks(res.code === 0 && Array.isArray(res.data) ? res.data : [])
    } catch {
      setWorkbooks([])
    } finally {
      setLoadingWorkbooks(false)
    }
  }, [])

  const close = useCallback(() => setOpen(false), [])

  // Global shortcut: Ctrl/Cmd + K. The spreadsheet inline editor owns Ctrl+K
  // for hyperlinks, so we never steal it while a cell is being edited.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest('.univer-editor-container')) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const openHandler = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, openHandler)
    return () => window.removeEventListener(OPEN_EVENT, openHandler)
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timeout)
  }, [open])

  // Refresh the workbook list every time the palette opens so newly created
  // files are searchable without a page reload.
  useEffect(() => {
    if (!open) return
    void loadWorkbooks()
  }, [open, loadWorkbooks])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  const recordRecent = useCallback((entry: RecentEntry) => {
    setRecent((current) => {
      const next = [
        entry,
        ...current.filter(
          (item) => !(item.kind === entry.kind && item.id === entry.id),
        ),
      ].slice(0, MAX_RECENT)
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // Ignore storage failures.
      }
      return next
    })
  }, [])

  const select = useCallback(
    (item: PaletteItem) => {
      recordRecent(item.recent)
      setOpen(false)
      if (item.href !== pathname) router.push(item.href)
    },
    [pathname, recordRecent, router],
  )

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const result: Array<{ title: string; items: PaletteItem[] }> = []

    const recentItems = q
      ? []
      : recent
          .map(recentToItem)
          .filter((item) => matchesQuery(q, [item.label, item.description]))
    if (recentItems.length > 0) {
      result.push({ title: '最近访问', items: recentItems })
    }

    const businessItems = BUSINESS_MODULES.filter((module) =>
      matchesQuery(q, [module.label, module.description, ...module.keywords]),
    ).map(moduleToItem)
    if (businessItems.length > 0) {
      result.push({ title: '导航', items: businessItems })
    }

    if (admin) {
      const adminItems = ADMIN_MODULES.filter((module) =>
        matchesQuery(q, [module.label, module.description, ...module.keywords]),
      ).map(moduleToItem)
      if (adminItems.length > 0) {
        result.push({ title: '管理', items: adminItems })
      }
    }

    const workbookItems = (workbooks ?? [])
      .filter((workbook) =>
        matchesQuery(q, [workbook.name, workbook.owner_name, workbook.description]),
      )
      .slice(0, q ? MAX_WORKBOOKS : 6)
      .map(workbookToItem)
    if (workbookItems.length > 0) {
      result.push({ title: '工作簿', items: workbookItems })
    }

    return result
  }, [admin, query, recent, workbooks])

  const flatItems = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  )

  const rows = useMemo(() => {
    const result: PaletteRow[] = []
    let index = 0
    groups.forEach((group) => {
      if (group.items.length === 0) return
      result.push({ type: 'header', title: group.title })
      group.items.forEach((item) => {
        result.push({ type: 'item', item, index })
        index += 1
      })
    })
    return result
  }, [groups])

  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-command-index="${activeIndex}"]`,
    )
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, rows])

  useEffect(() => {
    if (flatItems.length === 0) {
      if (activeIndex !== -1) setActiveIndex(-1)
      return
    }
    if (activeIndex < 0 || activeIndex >= flatItems.length) setActiveIndex(0)
  }, [activeIndex, flatItems.length])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (flatItems.length === 0) return
      setActiveIndex((current) => (current + 1) % flatItems.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (flatItems.length === 0) return
      setActiveIndex(
        (current) => (current - 1 + flatItems.length) % flatItems.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = flatItems[activeIndex]
      if (item) select(item)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        {...drag.handleProps}
        style={drag.style}
        onClick={() => setOpen(true)}
        title={`快捷导航（${isMac ? '⌘' : 'Ctrl'} + K）· 可拖动`}
        aria-label="打开快捷导航"
        className={`fixed bottom-4 left-4 z-[70] inline-flex h-9 touch-none select-none items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 text-xs font-semibold text-slate-600 shadow-lg backdrop-blur transition hover:border-sky-200 hover:text-sky-700 ${
          drag.dragging
            ? 'cursor-grabbing opacity-100'
            : 'cursor-grab opacity-80 hover:opacity-100'
        }`}
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">快捷导航</span>
        <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 md:inline">
          {shortcutLabel}
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="快捷导航"
          onKeyDown={handleKeyDown}
        >
          <div className="absolute inset-0" onClick={close} aria-hidden="true" />
          <div className="absolute left-1/2 top-[10vh] w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                placeholder="搜索模块或工作簿，例如「邮件」「询价」..."
                className="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    setActiveIndex(0)
                    inputRef.current?.focus()
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100"
                  title="清除"
                  aria-label="清除搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                  Esc
                </kbd>
              )}
            </div>

            <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
              {rows.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-slate-400">
                  {loadingWorkbooks ? '正在加载...' : '没有找到匹配的内容'}
                </div>
              ) : (
                rows.map((row) =>
                  row.type === 'header' ? (
                    <div
                      key={`header-${row.title}`}
                      className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                    >
                      {row.title}
                    </div>
                  ) : (
                    <button
                      key={row.item.key}
                      type="button"
                      data-command-index={row.index}
                      onMouseEnter={() => setActiveIndex(row.index)}
                      onClick={() => select(row.item)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                        row.index === activeIndex
                          ? 'bg-sky-50 text-sky-900'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          row.index === activeIndex
                            ? 'bg-white text-sky-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        <row.item.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">
                          {row.item.label}
                        </span>
                        {row.item.description && (
                          <span className="mt-0.5 block truncate text-xs text-slate-400">
                            {row.item.description}
                          </span>
                        )}
                      </span>
                      {row.item.meta && (
                        <span className="shrink-0 text-[11px] text-slate-400">
                          {row.item.meta}
                        </span>
                      )}
                      {row.index === activeIndex && (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                      )}
                    </button>
                  ),
                )
              )}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-[11px] text-slate-400">
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <ArrowUp className="h-3 w-3" />
                  <ArrowDown className="h-3 w-3" />
                  选择
                </span>
                <span className="flex items-center gap-1">
                  <CornerDownLeft className="h-3 w-3" />
                  打开
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Command className="h-3 w-3" />
                <span>{isMac ? 'K 随时唤起' : 'Ctrl+K 随时唤起'}</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
