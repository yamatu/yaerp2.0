'use client'

import {
  Bell,
  EyeOff,
  ArrowRight,
  ArrowUpDown,
  BarChart3,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FolderIcon,
  FolderKanban,
  FolderPlus,
  FolderUp,
  Globe2,
  Layers3,
  Images,
  LogOut,
  MessageSquare,
  MessageCircle,
  PencilLine,
  Plus,
  Search,
  Share2,
  Shield,
  Square,
  Lock,
  Trash2,
  Unlock,
  Upload,
  Users,
  UserRoundPlus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { WhatsAppSendDialog, type WhatsAppSendResource } from '@/components/whatsapp/WhatsAppSendDialog'
import { useWorkbooks } from '@/hooks/useSheet'
import { useFileManager } from '@/hooks/useFileManager'
import { uploadNewWorkbookXlsx } from '@/components/spreadsheet/ImportXlsxButton'
import api from '@/lib/api'
import { clearTokens, fetchCurrentUser, getStoredUser, isAdmin } from '@/lib/auth'
import type { AuthUser, Channel, Folder, FolderShareUser, PageData, User, Workbook } from '@/types'

interface WorkbookImportSource {
  filename?: string
  attachment_id?: number | null
}

function ownResourceFilterStorageKey(userId: number) {
  return `yaerp:home:${userId}:show-only-own-resources`
}

function legacyOwnWorkbookFilterStorageKey(userId: number) {
  return `yaerp:home:${userId}:show-only-own-workbooks`
}

function getWorkbookImportSource(workbook: Workbook): WorkbookImportSource | null {
  const source = workbook.metadata?.importSource
  if (!source || typeof source !== 'object') return null
  return source as WorkbookImportSource
}

function hasWorkbookSourceXlsx(workbook: Workbook) {
  const attachmentId = getWorkbookImportSource(workbook)?.attachment_id
  return typeof attachmentId === 'number' && attachmentId > 0
}

function sanitizeDownloadFilename(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return cleaned || 'workbook'
}

function parseFilenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] || fallback
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

function channelStorageKey(userId: number, suffix: string) {
  return `yaerp:channels:${userId}:${suffix}`
}

export default function HomePage() {
  const router = useRouter()
  const { workbooks, refresh } = useWorkbooks()
  const {
    currentFolderId,
    contents,
    breadcrumb,
    loading: folderLoading,
    error: folderError,
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
  const [whatsAppResource, setWhatsAppResource] = useState<WhatsAppSendResource | null>(null)
  const [channelNotifications, setChannelNotifications] = useState<Channel[]>([])
  const [channelNotificationOpen, setChannelNotificationOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [editingWorkbook, setEditingWorkbook] = useState<{ id: number; name: string } | null>(null)
  const [editWorkbookName, setEditWorkbookName] = useState('')
  const workbookImportInputRef = useRef<HTMLInputElement | null>(null)
  const workbookFolderImportInputRef = useRef<HTMLInputElement | null>(null)
  const [importingWorkbook, setImportingWorkbook] = useState(false)
  const [importingWorkbookFolder, setImportingWorkbookFolder] = useState(false)
  const [workbookImportProgress, setWorkbookImportProgress] = useState(0)
  const [workbookFolderImportStatus, setWorkbookFolderImportStatus] = useState('')
  const [workbookImportError, setWorkbookImportError] = useState('')
  const [duplicatingWorkbookId, setDuplicatingWorkbookId] = useState<number | null>(null)
  const [downloadingSourceWorkbookId, setDownloadingSourceWorkbookId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [workbookSortBy, setWorkbookSortBy] = useState<'updated_at' | 'created_at' | 'name'>('updated_at')
  const [workbookSortOrder, setWorkbookSortOrder] = useState<'asc' | 'desc'>('desc')
  const [groupByOwner, setGroupByOwner] = useState(true)
  const [showOnlyOwnResources, setShowOnlyOwnResources] = useState(() => {
    const user = getStoredUser()
    if (!user || typeof window === 'undefined') return false
    const stored = localStorage.getItem(ownResourceFilterStorageKey(user.id))
      ?? localStorage.getItem(legacyOwnWorkbookFilterStorageKey(user.id))
    return stored === 'true'
  })
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
  const [sharedFolders, setSharedFolders] = useState<Folder[]>([])
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null)
  const [shareableUsers, setShareableUsers] = useState<User[]>([])
  const [selectedShares, setSelectedShares] = useState<Record<number, 'view' | 'edit'>>({})
  const [shareLoading, setShareLoading] = useState(false)
  const [shareSaving, setShareSaving] = useState(false)
  const [shareLoadFailed, setShareLoadFailed] = useState(false)
  const [shareMessage, setShareMessage] = useState('')
  const [selectedReclaimWorkbookIds, setSelectedReclaimWorkbookIds] = useState<number[]>([])
  const [batchWorkbookActionLoading, setBatchWorkbookActionLoading] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const latestChannelMessageIdsRef = useRef<Map<number, number>>(new Map())
  const channelNotificationsInitializedRef = useRef(false)
  const notificationAudioContextRef = useRef<AudioContext | null>(null)
  const adminMode = isAdmin(profile)
  const workbookPageSize = 30
  const currentFolderMeta = currentFolderId !== null ? breadcrumb[breadcrumb.length - 1] || null : null
  const canWriteCurrentFolder = currentFolderId === null || currentFolderMeta?.can_write !== false
  const canManageCurrentFolder = currentFolderId === null || currentFolderMeta?.can_manage !== false
  const unreadChannels = useMemo(
    () => channelNotifications.filter((channel) => channel.unread_count > 0)
      .sort((left, right) => (right.last_message_at || right.updated_at).localeCompare(left.last_message_at || left.updated_at)),
    [channelNotifications]
  )
  const totalChannelUnread = useMemo(
    () => unreadChannels.reduce((sum, channel) => sum + channel.unread_count, 0),
    [unreadChannels]
  )

  const playHomeNotificationSound = useCallback(async () => {
    if (!profile?.id || localStorage.getItem(channelStorageKey(profile.id, 'sound-enabled')) === 'false') return
    const AudioContextClass = window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return
    if (!notificationAudioContextRef.current) notificationAudioContextRef.current = new AudioContextClass()
    const context = notificationAudioContextRef.current
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        return
      }
    }
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime
    oscillator.frequency.setValueAtTime(660, now)
    oscillator.frequency.setValueAtTime(880, now + 0.12)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.3)
  }, [profile?.id])

  const loadChannelNotifications = useCallback(async () => {
    if (!profile?.id) return
    try {
      const res = await api.get<Channel[]>('/channels')
      if (res.code !== 0 || !res.data) return
      const nextIds = new Map<number, number>()
      let hasNewColleagueMessage = false
      res.data.forEach((channel) => {
        const latestId = channel.last_message_id || 0
        nextIds.set(channel.id, latestId)
        const previousId = latestChannelMessageIdsRef.current.get(channel.id)
        if (channelNotificationsInitializedRef.current
          && previousId !== undefined
          && latestId > previousId
          && channel.last_message_sender_id !== profile.id
          && channel.unread_count > 0) {
          hasNewColleagueMessage = true
        }
      })
      latestChannelMessageIdsRef.current = nextIds
      channelNotificationsInitializedRef.current = true
      setChannelNotifications(res.data)
      if (hasNewColleagueMessage) void playHomeNotificationSound()
    } catch {
      // Workbook operations should remain available if channel polling fails.
    }
  }, [playHomeNotificationSound, profile?.id])

  const openChannelFromNotification = (channelId: number) => {
    if (profile?.id) localStorage.setItem(channelStorageKey(profile.id, 'active-channel'), String(channelId))
    router.push('/channels')
  }

  const canWriteFolder = (folder: Folder) => Boolean(folder.can_write)
  const canManageFolder = (folder: Folder) => Boolean(folder.can_manage)
  const canManageWorkbook = (workbook: Workbook) => Boolean(adminMode || workbook.owner_id === profile?.id)
  const isAssignedTaskWorkbook = (workbook: Workbook) => {
    const metadata = workbook.metadata || {}
    return typeof metadata.source_workbook_id !== 'undefined' || typeof metadata.assigned_by !== 'undefined'
  }
  const canDeleteWorkbook = (workbook: Workbook) => {
    if (adminMode) return true
    const assigned = isAssignedTaskWorkbook(workbook)
    return workbook.owner_id === profile?.id && !assigned && !workbook.is_locked && !workbook.is_hidden
  }

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

  const directoryWorkbooks = useMemo(
    () => adminMode && showOnlyOwnResources
      ? contents.workbooks.filter((workbook) => workbook.owner_id === profile?.id)
      : contents.workbooks,
    [adminMode, contents.workbooks, profile?.id, showOnlyOwnResources]
  )

  const directoryFolders = useMemo(
    () => adminMode && showOnlyOwnResources
      ? contents.folders.filter((folder) => folder.owner_id === profile?.id)
      : contents.folders,
    [adminMode, contents.folders, profile?.id, showOnlyOwnResources]
  )

  const filteredWorkbooks = useMemo(() => {
    if (!searchQuery.trim()) return directoryWorkbooks
    return directoryWorkbooks.filter(
      (wb) =>
        fuzzyMatch(searchQuery, wb.name) ||
        fuzzyMatch(searchQuery, wb.description || '') ||
        fuzzyMatch(searchQuery, wb.owner_name || '')
    )
  }, [directoryWorkbooks, searchQuery])

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
  const visibleAssignedTaskWorkbooks = useMemo(
    () => (adminMode ? paginatedWorkbooks.filter((workbook) => isAssignedTaskWorkbook(workbook)) : []),
    [adminMode, paginatedWorkbooks]
  )

  const foldersPerPage = 8
  const filteredFolders = useMemo(() => {
    const keyword = folderSearchQuery.trim().toLowerCase()
    if (!keyword) return directoryFolders
    return directoryFolders.filter((folder) => folder.name.toLowerCase().includes(keyword))
  }, [directoryFolders, folderSearchQuery])
  const totalFolderPages = Math.max(1, Math.ceil(filteredFolders.length / foldersPerPage))
  const paginatedFolders = useMemo(() => {
    const start = (folderPage - 1) * foldersPerPage
    return filteredFolders.slice(start, start + foldersPerPage)
  }, [filteredFolders, folderPage])
  const visibleSharedFolders = useMemo(() => {
    if (adminMode && showOnlyOwnResources) return []
    const existingIds = new Set(contents.folders.map((folder) => folder.id))
    return sharedFolders.filter((folder) => !existingIds.has(folder.id))
  }, [adminMode, contents.folders, sharedFolders, showOnlyOwnResources])
  useEffect(() => { setFolderPage(1) }, [folderSearchQuery, showOnlyOwnResources])
  useEffect(() => { setWorkbookPage(1) }, [showOnlyOwnResources])
  useEffect(() => {
    if (!profile?.id || !adminMode) return
    localStorage.setItem(ownResourceFilterStorageKey(profile.id), String(showOnlyOwnResources))
  }, [adminMode, profile?.id, showOnlyOwnResources])
  useEffect(() => {
    if (folderPage > totalFolderPages) setFolderPage(totalFolderPages)
  }, [folderPage, totalFolderPages])

  useEffect(() => {
    let active = true

    ;(async () => {
      try {
        const res = await api.get<Folder[]>('/folders/shared')
        if (!active) return
        setSharedFolders(res.code === 0 && res.data ? res.data : [])
      } catch (err) {
        console.error('Failed to load shared folders:', err)
        if (active) setSharedFolders([])
      }
    })()

    return () => {
      active = false
    }
  }, [currentFolderId])

  // Suggestions: top 5 matching names shown in dropdown
  const suggestions = useMemo(() => {
    if (!searchQuery.trim() || !searchFocused) return []
    return directoryWorkbooks
      .filter((wb) => fuzzyMatch(searchQuery, wb.name))
      .slice(0, 5)
  }, [directoryWorkbooks, searchQuery, searchFocused])

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

  useEffect(() => {
    if (!profile?.id) return
    void loadChannelNotifications()
    const timer = window.setInterval(() => void loadChannelNotifications(), 8000)
    return () => window.clearInterval(timer)
  }, [loadChannelNotifications, profile?.id])

  useEffect(() => {
    const baseTitle = 'YaERP 2.0'
    document.title = totalChannelUnread > 0 ? `(${totalChannelUnread}) ${baseTitle}` : baseTitle
    return () => {
      document.title = baseTitle
    }
  }, [totalChannelUnread])

  useEffect(() => () => {
    const context = notificationAudioContextRef.current
    notificationAudioContextRef.current = null
    if (context && context.state !== 'closed') void context.close()
  }, [])

  const handleCreateWorkbook = async () => {
    if (!canWriteCurrentFolder) return
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

  const handleImportWorkbookXlsx = async (file: File) => {
    if (!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder) return

    setImportingWorkbook(true)
    setWorkbookImportProgress(0)
    setWorkbookImportError('')

    try {
      const result = await uploadNewWorkbookXlsx(file, {
        folderId: currentFolderId,
        onProgress: setWorkbookImportProgress,
      })
      await Promise.all([refresh(), refreshFolder()])
      setWorkbookPage(1)
      if (result.first_sheet_id) {
        router.push(`/sheets/${result.workbook.id}/${result.first_sheet_id}`)
      } else {
        router.push(`/sheets/${result.workbook.id}`)
      }
    } catch (err) {
      setWorkbookImportError(err instanceof Error ? err.message : 'Excel 导入失败，请稍后再试。')
    } finally {
      setImportingWorkbook(false)
      setTimeout(() => setWorkbookImportProgress(0), 400)
      if (workbookImportInputRef.current) {
        workbookImportInputRef.current.value = ''
      }
    }
  }

  const handleImportWorkbookFolder = async (selectedFiles: FileList) => {
    if (!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder) return
    const files = Array.from(selectedFiles).filter((file) => file.name.toLowerCase().endsWith('.xlsx'))
    if (files.length === 0) {
      setWorkbookImportError('所选文件夹中没有 XLSX 工作簿。')
      if (workbookFolderImportInputRef.current) workbookFolderImportInputRef.current.value = ''
      return
    }

    setImportingWorkbookFolder(true)
    setWorkbookImportProgress(0)
    setWorkbookImportError('')
    setWorkbookFolderImportStatus(`正在分析 ${files.length} 个 Excel 工作簿`)

    try {
      const entries = files.map((file) => {
        const relativePath = (file.webkitRelativePath || file.name).replaceAll('\\', '/')
        const parts = relativePath.split('/').map((part) => part.trim()).filter(Boolean)
        return { file, parts, directoryParts: parts.length > 1 ? parts.slice(0, -1) : [file.name.replace(/\.xlsx$/i, '')] }
      })
      const directoryPaths = Array.from(new Set(entries.flatMap((entry) => entry.directoryParts.map((_, index) => entry.directoryParts.slice(0, index + 1).join('/')))))
        .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right, 'zh-CN'))
      const folderIDs = new Map<string, number>()

      for (let index = 0; index < directoryPaths.length; index += 1) {
        const directoryPath = directoryPaths[index]
        const parts = directoryPath.split('/')
        const parentPath = parts.slice(0, -1).join('/')
        const parentID = parentPath ? folderIDs.get(parentPath) : currentFolderId
        setWorkbookFolderImportStatus(`正在创建目录 ${directoryPath}`)
        const response = await api.post<Folder>('/folders', { name: parts.at(-1), parent_id: parentID ?? null })
        if (response.code !== 0 || !response.data?.id) throw new Error(response.message || `创建目录 ${directoryPath} 失败`)
        folderIDs.set(directoryPath, response.data.id)
        setWorkbookImportProgress(Math.round(((index + 1) / Math.max(1, directoryPaths.length + files.length)) * 100))
      }

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        const directoryPath = entry.directoryParts.join('/')
        const folderID = folderIDs.get(directoryPath)
        if (!folderID) throw new Error(`找不到导入目录 ${directoryPath}`)
        setWorkbookFolderImportStatus(`正在导入 ${index + 1}/${entries.length}：${entry.parts.join('/')}`)
        await uploadNewWorkbookXlsx(entry.file, {
          folderId: folderID,
          onProgress: (fileProgress) => {
            const completedUnits = directoryPaths.length + index + fileProgress / 100
            setWorkbookImportProgress(Math.round((completedUnits / (directoryPaths.length + files.length)) * 100))
          },
        })
      }

      setWorkbookImportProgress(100)
      setWorkbookFolderImportStatus(`已按原目录结构导入 ${files.length} 个 Excel 工作簿`)
      await Promise.all([refresh(), refreshFolder()])
      setWorkbookPage(1)
    } catch (err) {
      setWorkbookImportError(err instanceof Error ? err.message : 'Excel 文件夹批量导入失败。')
    } finally {
      setImportingWorkbookFolder(false)
      window.setTimeout(() => {
        setWorkbookImportProgress(0)
        setWorkbookFolderImportStatus('')
      }, 1200)
      if (workbookFolderImportInputRef.current) workbookFolderImportInputRef.current.value = ''
    }
  }

  const handleDownloadWorkbookSource = async (event: React.MouseEvent, workbook: Workbook) => {
    event.stopPropagation()
    if (downloadingSourceWorkbookId !== null) return

    setDownloadingSourceWorkbookId(workbook.id)
    setWorkbookImportError('')
    try {
      const source = getWorkbookImportSource(workbook)
      const hasSource = hasWorkbookSourceXlsx(workbook)
      const fallbackBase = sanitizeDownloadFilename(source?.filename || workbook.name || 'workbook')
      const fallbackFilename = fallbackBase.toLowerCase().endsWith('.xlsx') ? fallbackBase : `${fallbackBase}.xlsx`
      const response = await api.download(hasSource
        ? `/workbooks/${workbook.id}/source/xlsx`
        : `/workbooks/${workbook.id}/export?filename=${encodeURIComponent(fallbackFilename)}`)
      if (!response.ok) {
        let message = '下载 Excel 失败，请稍后再试。'
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) {
            message = data.message
          }
        } catch {
          // Ignore JSON parse errors for binary responses.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename)
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      setWorkbookImportError(err instanceof Error ? err.message : '下载 Excel 失败，请稍后再试。')
    } finally {
      setDownloadingSourceWorkbookId(null)
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
    const visibleIds = new Set(workbooks.map((workbook) => workbook.id))
    setSelectedReclaimWorkbookIds((current) => current.filter((id) => visibleIds.has(id)))
  }, [workbooks])

  useEffect(() => {
    if (!sharingFolder) return

    let active = true
    setShareLoading(true)
    setShareLoadFailed(false)
    setShareMessage('')

    ;(async () => {
      try {
        const [usersRes, sharesRes] = await Promise.all([
          api.get<User[]>(`/folders/${sharingFolder.id}/shareable-users`),
          api.get<FolderShareUser[]>(`/folders/${sharingFolder.id}/shares`),
        ])

        if (!active) return

        setShareableUsers(usersRes.code === 0 && usersRes.data ? usersRes.data : [])
        setSelectedShares(
          sharesRes.code === 0 && sharesRes.data
            ? sharesRes.data.reduce<Record<number, 'view' | 'edit'>>((acc, user) => {
                acc[user.id] = user.access_level
                return acc
              }, {})
            : {}
        )
        setShareLoadFailed(false)
      } catch (err) {
        console.error('Failed to load folder shares:', err)
        if (active) {
          setShareLoadFailed(true)
          setShareMessage('加载共享用户失败，请稍后重试。')
        }
      } finally {
        if (active) setShareLoading(false)
      }
    })()

    return () => {
      active = false
    }
  }, [sharingFolder])

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
    const workbook = workbooks.find((item) => item.id === workbookId) || contents.workbooks.find((item) => item.id === workbookId)
    if (workbook && !canDeleteWorkbook(workbook)) return
    if (!confirm('确定要删除此工作簿吗？其下所有工作表和数据将一并删除。')) return
    try {
      await api.delete(`/workbooks/${workbookId}`)
      await Promise.all([refresh(), refreshFolder()])
    } catch (err) {
      console.error('Failed to delete workbook:', err)
    }
  }

  const handleDuplicateWorkbook = async (event: React.MouseEvent, workbook: Workbook) => {
    event.stopPropagation()
    if (!canManageWorkbook(workbook) || duplicatingWorkbookId !== null) return

    setDuplicatingWorkbookId(workbook.id)
    setWorkbookImportError('')
    try {
      const res = await api.post<Workbook>(`/workbooks/${workbook.id}/duplicate`)
      if (res.code !== 0 || !res.data) {
        setWorkbookImportError(res.message || '复制工作簿失败，请稍后再试。')
        return
      }
      setWorkbookPage(1)
      await Promise.all([refresh(), refreshFolder()])
    } catch (err) {
      console.error('Failed to duplicate workbook:', err)
      setWorkbookImportError(err instanceof Error ? err.message : '复制工作簿失败，请稍后再试。')
    } finally {
      setDuplicatingWorkbookId(null)
    }
  }

  const handleUpdateWorkbookState = async (e: React.MouseEvent, workbookId: number, action: 'lock' | 'unlock' | 'hide' | 'unhide' | 'publish' | 'unpublish') => {
    e.stopPropagation()
    try {
      const res = await api.put(`/workbooks/${workbookId}/state`, { action })
      if (res.code !== 0) {
        console.error('Failed to update workbook state:', res.message)
        return
      }
      await Promise.all([refresh(), refreshFolder()])
    } catch (err) {
      console.error('Failed to update workbook state:', err)
    }
  }

  const toggleReclaimWorkbookSelection = (workbookId: number) => {
    setSelectedReclaimWorkbookIds((current) =>
      current.includes(workbookId)
        ? current.filter((id) => id !== workbookId)
        : [...current, workbookId]
    )
  }

  const handleSelectAllVisibleTaskWorkbooks = () => {
    const ids = visibleAssignedTaskWorkbooks.map((workbook) => workbook.id)
    if (ids.length === 0) return

    setSelectedReclaimWorkbookIds((current) => {
      const allSelected = ids.every((id) => current.includes(id))
      if (allSelected) {
        return current.filter((id) => !ids.includes(id))
      }
      return Array.from(new Set([...current, ...ids]))
    })
  }

  const handleBatchUpdateWorkbookState = async (action: 'lock' | 'unlock' | 'hide' | 'unhide') => {
    if (selectedReclaimWorkbookIds.length === 0) return

    setBatchWorkbookActionLoading(true)
    try {
      const res = await api.put('/workbooks/state/batch', {
        workbook_ids: selectedReclaimWorkbookIds,
        action,
      })
      if (res.code !== 0) {
        console.error('Failed to batch update workbook state:', res.message)
        return
      }
      await Promise.all([refresh(), refreshFolder()])
      if (action === 'hide') {
        setSelectedReclaimWorkbookIds([])
      }
    } catch (err) {
      console.error('Failed to batch update workbook state:', err)
    } finally {
      setBatchWorkbookActionLoading(false)
    }
  }

  const handleRenameWorkbook = async () => {
    if (!editingWorkbook || !editWorkbookName.trim()) return
    try {
      await api.put(`/workbooks/${editingWorkbook.id}`, { name: editWorkbookName.trim() })
      setEditingWorkbook(null)
      await Promise.all([refresh(), refreshFolder()])
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

  const handleSaveFolderShares = async () => {
    if (!sharingFolder || shareLoading || shareLoadFailed) return

    setShareSaving(true)
    setShareMessage('')

    try {
      const res = await api.put(`/folders/${sharingFolder.id}/shares`, {
        shares: Object.entries(selectedShares).map(([userId, accessLevel]) => ({
          user_id: Number(userId),
          access_level: accessLevel,
        })),
      })

      if (res.code !== 0) {
        setShareMessage(res.message || '保存共享设置失败，请稍后重试。')
        return
      }

      setShareMessage('共享设置已更新。')
      await Promise.all([
        refreshFolder(),
        api.get<Folder[]>('/folders/shared').then((res) => {
          setSharedFolders(res.code === 0 && res.data ? res.data : [])
        }),
      ])
    } catch (err) {
      console.error('Failed to save folder shares:', err)
      setShareMessage('保存共享设置失败，请稍后重试。')
    } finally {
      setShareSaving(false)
    }
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-slate-100">
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-3 p-3 md:p-5">
          <header className="rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm md:px-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                  <FolderKanban className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold text-slate-950">YaERP 工作台</h1>
                  <p className="mt-0.5 truncate text-sm text-slate-500">管理业务工作簿、文件夹和协作任务</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="mr-1 hidden items-center gap-2 border-r border-slate-200 pr-3 text-sm md:flex">
                  <span className="text-slate-400">工作簿</span>
                  <span className="font-semibold text-slate-900">{directoryWorkbooks.length}</span>
                </div>
                <div className="relative">
                  <button type="button" onClick={() => setChannelNotificationOpen((current) => !current)} className="ui-tooltip relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-sky-700" title="频道未读消息" aria-label="频道未读消息" data-tooltip="频道未读消息">
                    <Bell className="h-4 w-4" />
                    {totalChannelUnread > 0 && <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-4 text-white">{totalChannelUnread > 99 ? '99+' : totalChannelUnread}</span>}
                  </button>
                  {channelNotificationOpen && (
                    <div className="fixed inset-x-3 top-20 z-50 max-h-[70vh] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-80">
                      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">频道消息</div>
                          <div className="mt-0.5 text-xs text-slate-400">{totalChannelUnread > 0 ? `${totalChannelUnread} 条未读` : '没有未读消息'}</div>
                        </div>
                        <button type="button" onClick={() => setChannelNotificationOpen(false)} className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭频道消息" aria-label="关闭频道消息" data-tooltip="关闭"><X className="h-3.5 w-3.5" /></button>
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        {unreadChannels.length === 0 ? (
                          <div className="px-4 py-8 text-center text-sm text-slate-400">频道消息已全部阅读</div>
                        ) : unreadChannels.map((channel) => (
                          <button key={channel.id} type="button" onClick={() => { setChannelNotificationOpen(false); openChannelFromNotification(channel.id) }} className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left last:border-b-0 hover:bg-slate-50">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sky-50 text-sky-700">
                              {channel.avatar_url ? <img src={channel.avatar_url} alt="" className="h-full w-full object-cover" /> : <MessageSquare className="h-4 w-4" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-slate-800">{channel.name}</div>
                              <div className="mt-0.5 truncate text-xs text-slate-400">{channel.description || `${channel.member_count || 1} 位成员`}</div>
                            </div>
                            <span className="shrink-0 rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-semibold text-white">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>
                          </button>
                        ))}
                      </div>
                      <button type="button" onClick={() => { setChannelNotificationOpen(false); router.push('/channels') }} className="flex h-10 w-full items-center justify-center border-t border-slate-200 text-sm font-medium text-sky-700 hover:bg-sky-50">进入频道</button>
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => router.push('/channels')} className="relative inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900">
                  <MessageSquare className="h-4 w-4" />
                  频道
                  {totalChannelUnread > 0 && <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{totalChannelUnread > 99 ? '99+' : totalChannelUnread}</span>}
                </button>
                <button type="button" onClick={() => router.push('/gallery')} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900">
                  <Images className="h-4 w-4" />
                  图库
                </button>
                <button type="button" onClick={() => router.push('/whatsapp')} className="inline-flex h-9 items-center gap-2 rounded-lg border border-emerald-200 px-3 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50">
                  <MessageCircle className="h-4 w-4" />
                  WhatsApp
                </button>
                <button type="button" onClick={() => router.push('/ai/summaries')} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900">
                  <BarChart3 className="h-4 w-4" />
                  AI 总结
                </button>
                {adminMode && (
                  <button type="button" onClick={() => router.push('/admin')} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white transition hover:bg-slate-700">
                    <Shield className="h-4 w-4" />
                    管理后台
                  </button>
                )}
                <button type="button" onClick={() => router.push('/settings')} className="ml-1 flex min-w-0 items-center gap-2 border-l border-slate-200 pl-3 text-left" title="个人设置">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">
                    {profile?.avatar ? <img src={profile.avatar} alt="" className="h-full w-full object-cover" /> : (profile?.username?.slice(0, 2).toUpperCase() || 'U')}
                  </div>
                  <div className="min-w-0">
                    <div className="max-w-28 truncate text-sm font-semibold text-slate-800">{profile?.username || '未加载'}</div>
                    <div className="max-w-28 truncate text-[11px] text-slate-400">{profile?.roles?.[0]?.name || '普通用户'}</div>
                  </div>
                </button>
                <button type="button" onClick={handleLogout} disabled={loggingOut} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50" title={loggingOut ? '退出中' : '退出登录'} aria-label={loggingOut ? '退出中' : '退出登录'} data-tooltip={loggingOut ? '退出中' : '退出登录'} data-tooltip-side="left">
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
          </header>

          {totalChannelUnread > 0 && (
            <section className="flex flex-col gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-600 text-white"><Bell className="h-4 w-4" /><span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-sky-50 bg-rose-500" /></div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-sky-950">频道有 {totalChannelUnread} 条未读消息</div>
                  <div className="mt-0.5 truncate text-xs text-sky-700">{unreadChannels.slice(0, 3).map((channel) => channel.name).join('、')}{unreadChannels.length > 3 ? ` 等 ${unreadChannels.length} 个频道` : ''}</div>
                </div>
              </div>
              <button type="button" onClick={() => openChannelFromNotification(unreadChannels[0].id)} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800">查看消息<ArrowRight className="h-4 w-4" /></button>
            </section>
          )}

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">
                  Workbooks
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <h2 className="text-2xl font-semibold text-slate-950">业务工作簿</h2>
                  <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">{sortedWorkbooks.length} 个</span>
                </div>
                <p className="mt-2 text-sm text-slate-500">
                  {adminMode
                    ? '管理员可按员工查看全部工作簿，并按时间排序、搜索和发放任务模板。'
                    : '用工作簿组织你的业务模块，再在工作表里扩展字段、权限和协作规则。'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {adminMode && (
                  <button
                    type="button"
                    onClick={() => {
                      const nextValue = !showOnlyOwnResources
                      setShowOnlyOwnResources(nextValue)
                      if (nextValue && currentFolderMeta && currentFolderMeta.owner_id !== profile?.id) {
                        void navigateToFolder(null)
                      }
                    }}
                    className={`order-3 inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition ${showOnlyOwnResources ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                    title={showOnlyOwnResources ? '恢复查看全部工作簿和文件夹' : '仅显示自己创建的工作簿和文件夹'}
                    aria-pressed={showOnlyOwnResources}
                  >
                    {showOnlyOwnResources ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                    仅看自己
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCreatingFolder(true)}
                  disabled={!canWriteCurrentFolder}
                  className="order-3 inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
                </button>
                <button
                  type="button"
                  onClick={() => setCreating((prev) => !prev)}
                  disabled={!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder}
                  className="order-1 inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  新建工作簿
                </button>
                <button
                  type="button"
                  onClick={() => workbookImportInputRef.current?.click()}
                  disabled={!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder}
                  className="order-2 inline-flex h-10 items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Upload className="h-4 w-4" />
                  {importingWorkbook ? `导入中 ${workbookImportProgress}%` : '上传 Excel'}
                </button>
                <input
                  ref={workbookImportInputRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) {
                      void handleImportWorkbookXlsx(file)
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => workbookFolderImportInputRef.current?.click()}
                  disabled={!canWriteCurrentFolder || importingWorkbook || importingWorkbookFolder}
                  className="order-2 inline-flex h-10 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderUp className="h-4 w-4" />
                  {importingWorkbookFolder ? `批量导入 ${workbookImportProgress}%` : '上传 Excel 文件夹'}
                </button>
                <input
                  ref={workbookFolderImportInputRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  multiple
                  className="hidden"
                  {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                  onChange={(event) => {
                    if (event.target.files?.length) void handleImportWorkbookFolder(event.target.files)
                  }}
                />
              </div>
            </div>

            {(importingWorkbook || importingWorkbookFolder || workbookFolderImportStatus || workbookImportError) && (
              <div className={`mb-4 rounded-2xl border px-4 py-3 text-sm ${
                workbookImportError
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-sky-200 bg-sky-50 text-sky-700'
              }`}>
                {workbookImportError ? (
                  <div className="font-medium">{workbookImportError}</div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between font-semibold">
                      <span>{importingWorkbookFolder ? (workbookFolderImportStatus || '正在批量导入 Excel 文件夹') : '正在导入 Excel 工作簿'}</span>
                      <span>{workbookImportProgress}%</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
                      <div className="h-full rounded-full bg-sky-500 transition-all duration-200" style={{ width: `${workbookImportProgress}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}

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

            {currentFolderMeta && !canWriteCurrentFolder && (
              <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
                当前位于只读共享文件夹中，你可以查看和打开文件，但不能在这里新建或写入内容。
              </div>
            )}

            {folderError && (
              <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                {folderError}
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
                      if (!canWriteCurrentFolder) return
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
                  className="ui-tooltip rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  title="取消新建文件夹"
                  aria-label="取消新建文件夹"
                  data-tooltip="取消新建文件夹"
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
                  className="ui-tooltip rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  title="取消新建工作簿"
                  aria-label="取消新建工作簿"
                  data-tooltip="取消新建工作簿"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {currentFolderId === null && visibleSharedFolders.length > 0 && (
              <div className="mb-4 space-y-3 rounded-[24px] border border-sky-200 bg-sky-50/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">共享给我的文件夹</div>
                    <div className="text-xs text-slate-500">这里显示别人直接共享给你的文件夹入口，避免深层共享文件夹找不到。</div>
                  </div>
                  <div className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500">
                    {visibleSharedFolders.length} 个入口
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {visibleSharedFolders.map((folder) => (
                    <button
                      key={`shared-${folder.id}`}
                      type="button"
                      onClick={() => void navigateToFolder(folder.id)}
                      className="rounded-2xl border border-sky-200 bg-white/90 p-4 text-left transition hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <FolderIcon className="h-8 w-8 flex-shrink-0 text-sky-500" />
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{folder.name}</div>
                            <div className="mt-1 text-xs text-slate-500">
                              共享者：{folder.owner_name || `用户 #${folder.owner_id}`}
                            </div>
                          </div>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          folder.access_level === 'edit'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }`}>
                          {folder.access_level === 'edit' ? '可写共享' : '只读共享'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Folder list */}
            {directoryFolders.length > 0 && (
              <div className="mb-4 space-y-3">
                {/* Folder search + pagination toolbar */}
                {(directoryFolders.length > foldersPerPage || folderSearchQuery.trim()) && (
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
                      className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title="上一页文件夹"
                      aria-label="上一页文件夹"
                      data-tooltip="上一页"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFolderPage((c) => Math.min(totalFolderPages, c + 1))}
                      disabled={folderPage >= totalFolderPages}
                      className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title="下一页文件夹"
                      aria-label="下一页文件夹"
                      data-tooltip="下一页"
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
                         if (draggedWorkbookId !== null && canWriteFolder(folder)) {
                           event.preventDefault()
                         }
                       }}
                       onDrop={(event) => {
                         event.preventDefault()
                         if (draggedWorkbookId !== null && canWriteFolder(folder)) {
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
                            <div className="text-xs text-slate-400">
                              {folder.can_write
                                ? '可拖入工作簿'
                                : `只读共享自 ${folder.owner_name || `用户 #${folder.owner_id}`}`}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5" />
                        </button>
                        <div className="flex items-center gap-1">
                          {canManageFolder(folder) && (
                            <button
                              type="button"
                              onClick={() => {
                                setSharingFolder(folder)
                                setSelectedShares({})
                                setShareMessage('')
                              }}
                              className="ui-tooltip rounded-full p-1.5 text-slate-300 transition hover:bg-sky-50 hover:text-sky-600"
                              title="共享文件夹"
                              aria-label={`共享文件夹 ${folder.name}`}
                              data-tooltip="共享文件夹"
                            >
                              <Share2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {canManageFolder(folder) && (
                            <button
                              type="button"
                              onClick={() => void handleDeleteFolder(folder.id, folder.name)}
                              className="ui-tooltip rounded-full p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"
                              title="删除文件夹"
                              aria-label={`删除文件夹 ${folder.name}`}
                              data-tooltip="删除文件夹"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {filteredFolders.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500 md:col-span-3 lg:col-span-4">
                      没有找到匹配的文件夹
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Search bar */}
            {!folderLoading && directoryWorkbooks.length > 0 && (
              <div className="mb-5 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div ref={searchRef} className="relative flex-1 xl:max-w-xl">
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-center text-slate-400">
                      <Search className="h-4 w-4" />
                    </span>
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onFocus={() => setSearchFocused(true)}
                      placeholder={adminMode ? '搜索工作簿 / 描述 / 员工...' : '搜索工作簿名称...'}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-12 pr-10 text-sm leading-[44px] text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => { setSearchQuery(''); setSearchFocused(false) }}
                        className="ui-tooltip absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        title="清除搜索"
                        aria-label="清除搜索"
                        data-tooltip="清除搜索"
                        data-tooltip-side="top"
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

            {folderLoading && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center text-slate-500">
                正在加载工作簿...
              </div>
            )}

            {folderError && (
              <div className="rounded-[24px] border border-rose-200 bg-rose-50 px-6 py-6 text-sm font-medium text-rose-700">
                {folderError}
              </div>
            )}

            {!folderLoading && !folderError && directoryWorkbooks.length === 0 && directoryFolders.length === 0 && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.98))] px-6 py-14 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-slate-900 text-white">
                  <FolderKanban className="h-7 w-7" />
                </div>
                <h3 className="text-2xl font-semibold text-slate-950">{showOnlyOwnResources ? '还没有自己的工作簿或文件夹' : '还没有工作簿'}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-500">
                  {showOnlyOwnResources ? '可以新建自己的文件夹或工作簿，关闭筛选后仍可查看其他有权限的资源。' : '从一个基础业务台账开始，后续可以逐步延展成销售、库存、采购和人事模块。'}
                </p>
              </div>
            )}

            {!folderLoading && !folderError && directoryWorkbooks.length > 0 && filteredWorkbooks.length === 0 && (
              <div className="rounded-[24px] border border-dashed border-slate-300 bg-slate-50/80 px-6 py-14 text-center">
                <Search className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                <h3 className="text-lg font-semibold text-slate-700">没有找到匹配的工作簿</h3>
                <p className="mt-2 text-sm text-slate-400">试试其他关键词，或清除搜索条件查看全部。</p>
              </div>
            )}

            {!folderLoading && !folderError && paginatedWorkbooks.length > 0 && (
              <div className="space-y-6">
                {adminMode && visibleAssignedTaskWorkbooks.length > 0 && (
                  <div className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">批量回收任务工作簿</div>
                        <div className="mt-1 text-xs leading-6 text-slate-600">
                          当前页共有 {visibleAssignedTaskWorkbooks.length} 个任务工作簿，已选 {selectedReclaimWorkbookIds.length} 个。
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleSelectAllVisibleTaskWorkbooks}
                          className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          {visibleAssignedTaskWorkbooks.every((workbook) => selectedReclaimWorkbookIds.includes(workbook.id)) ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                          {visibleAssignedTaskWorkbooks.every((workbook) => selectedReclaimWorkbookIds.includes(workbook.id)) ? '取消全选当前页' : '全选当前页任务'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleBatchUpdateWorkbookState('lock')}
                          disabled={batchWorkbookActionLoading || selectedReclaimWorkbookIds.length === 0}
                          className="rounded-full border border-amber-200 bg-white px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          批量锁定
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleBatchUpdateWorkbookState('hide')}
                          disabled={batchWorkbookActionLoading || selectedReclaimWorkbookIds.length === 0}
                          className="rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          批量设为不可见
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleBatchUpdateWorkbookState('unlock')}
                          disabled={batchWorkbookActionLoading || selectedReclaimWorkbookIds.length === 0}
                          className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          批量解除锁定
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleBatchUpdateWorkbookState('unhide')}
                          disabled={batchWorkbookActionLoading || selectedReclaimWorkbookIds.length === 0}
                          className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          批量恢复可见
                        </button>
                      </div>
                    </div>
                  </div>
                )}
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
                    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <div className="overflow-x-auto">
                        <div className="min-w-[1160px]">
                          <div className="grid grid-cols-[minmax(340px,1.6fr)_170px_140px_170px_365px] items-center border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500">
                            <div>名称</div>
                            <div>归属 / 状态</div>
                            <div>创建时间</div>
                            <div>更新时间</div>
                            <div className="text-right">操作</div>
                          </div>
                          <div className="divide-y divide-slate-100">
                            {group.items.map((workbook) => (
                              <div
                                key={workbook.id}
                                draggable={canManageWorkbook(workbook)}
                                onDragStart={() => canManageWorkbook(workbook) && setDraggedWorkbookId(workbook.id)}
                                onDragEnd={() => setDraggedWorkbookId(null)}
                                onDoubleClick={() => router.push(`/sheets/${workbook.id}`)}
                                className={`grid grid-cols-[minmax(340px,1.6fr)_170px_140px_170px_365px] items-center gap-3 px-4 py-2.5 text-sm transition ${
                                  workbook.is_hidden ? 'bg-slate-50/70 text-slate-500 hover:bg-slate-100' : 'hover:bg-sky-50/50'
                                }`}
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  {adminMode && isAssignedTaskWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        toggleReclaimWorkbookSelection(workbook.id)
                                      }}
                                      className="ui-tooltip inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
                                      title={selectedReclaimWorkbookIds.includes(workbook.id) ? '取消选择' : '选择用于批量回收'}
                                      aria-label={selectedReclaimWorkbookIds.includes(workbook.id) ? `取消选择 ${workbook.name}` : `选择 ${workbook.name} 用于批量回收`}
                                      data-tooltip={selectedReclaimWorkbookIds.includes(workbook.id) ? '取消选择' : '选择用于批量回收'}
                                      data-tooltip-side="top"
                                    >
                                      {selectedReclaimWorkbookIds.includes(workbook.id) ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                                    </button>
                                  )}
                                  <button type="button" onClick={() => router.push(`/sheets/${workbook.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                                      <FolderKanban className="h-4 w-4" />
                                    </span>
                                    <span className="min-w-0">
                                      <span className="block truncate font-semibold text-slate-900">{workbook.name}</span>
                                      <span className="block truncate text-xs leading-5 text-slate-500">{workbook.description?.trim() || `工作簿 #${workbook.id}`}</span>
                                    </span>
                                  </button>
                                </div>
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  {adminMode && workbook.owner_name && (
                                    <span className="max-w-[150px] truncate rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-600">
                                      {workbook.owner_name}
                                    </span>
                                  )}
                                  {workbook.is_locked && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                                      <Lock className="h-3 w-3" />
                                      锁定
                                    </span>
                                  )}
                                  {workbook.is_hidden && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                      <EyeOff className="h-3 w-3" />
                                      不可见
                                    </span>
                                  )}
                                  {workbook.is_public && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                      <Globe2 className="h-3 w-3" />
                                      公共
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-slate-500">{new Date(workbook.created_at).toLocaleDateString('zh-CN')}</div>
                                <div className="text-xs text-slate-500">{new Date(workbook.updated_at).toLocaleString('zh-CN')}</div>
                                <div className="flex items-center justify-end gap-1.5">
                                  {currentFolderId !== null && canManageWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={() => void handleMoveWorkbookToFolder(workbook.id, null)}
                                      disabled={movingWorkbookId === workbook.id}
                                      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                                      title="移出当前文件夹到根目录"
                                    >
                                      {movingWorkbookId === workbook.id ? '移动中' : '移出'}
                                    </button>
                                  )}
                                  {canManageWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={(event) => void handleDuplicateWorkbook(event, workbook)}
                                      disabled={duplicatingWorkbookId !== null}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-sky-200 bg-sky-50 text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                                      title="复制工作簿"
                                      aria-label={`复制工作簿 ${workbook.name}`}
                                      data-tooltip={duplicatingWorkbookId === workbook.id ? '正在复制工作簿' : '复制工作簿'}
                                      data-tooltip-side="top"
                                    >
                                      <Copy className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => void handleDownloadWorkbookSource(e, workbook)}
                                    disabled={downloadingSourceWorkbookId !== null}
                                    className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                                    title={hasWorkbookSourceXlsx(workbook) ? '下载原始 Excel' : '导出 Excel'}
                                    aria-label={`${hasWorkbookSourceXlsx(workbook) ? '下载原始 Excel' : '导出 Excel'} ${workbook.name}`}
                                    data-tooltip={hasWorkbookSourceXlsx(workbook) ? '下载原始 Excel' : '导出 Excel'}
                                    data-tooltip-side="top"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setWhatsAppResource({ workbookId: workbook.id, title: workbook.name, defaultContent: `工作簿：${workbook.name}` })
                                    }}
                                    className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-200 bg-white text-emerald-600 transition hover:bg-emerald-50"
                                    title="发送工作簿到 WhatsApp"
                                    aria-label={`发送 ${workbook.name} 到 WhatsApp`}
                                    data-tooltip="发送到 WhatsApp"
                                    data-tooltip-side="top"
                                  >
                                    <MessageCircle className="h-3.5 w-3.5" />
                                  </button>
                                  {canManageWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleUpdateWorkbookState(e, workbook.id, workbook.is_public ? 'unpublish' : 'publish')}
                                      className={`ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border transition ${workbook.is_public ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                                      title={workbook.is_public ? '取消公共访问' : '设为公共工作簿'}
                                      aria-label={`${workbook.is_public ? '取消公共访问' : '设为公共工作簿'} ${workbook.name}`}
                                      data-tooltip={workbook.is_public ? '取消公共访问' : '设为公共工作簿'}
                                      data-tooltip-side="top"
                                    >
                                      <Globe2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {adminMode && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleUpdateWorkbookState(e, workbook.id, workbook.is_locked ? 'unlock' : 'lock')}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 text-amber-700 transition hover:bg-amber-100"
                                      title={workbook.is_locked ? '解除工作簿锁定' : '锁定工作簿'}
                                      aria-label={`${workbook.is_locked ? '解除锁定' : '锁定'} ${workbook.name}`}
                                      data-tooltip={workbook.is_locked ? '解除工作簿锁定' : '锁定工作簿'}
                                      data-tooltip-side="top"
                                    >
                                      {workbook.is_locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                                    </button>
                                  )}
                                  {adminMode && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleUpdateWorkbookState(e, workbook.id, workbook.is_hidden ? 'unhide' : 'hide')}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                                      title={workbook.is_hidden ? '恢复工作簿可见' : '设为不可见'}
                                      aria-label={`${workbook.is_hidden ? '恢复可见' : '设为不可见'} ${workbook.name}`}
                                      data-tooltip={workbook.is_hidden ? '恢复工作簿可见' : '设为不可见'}
                                      data-tooltip-side="top"
                                    >
                                      <EyeOff className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {adminMode && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setAssigningWorkbook(workbook)
                                        setSelectedAssigneeIds([])
                                        setAssignmentMessage('')
                                      }}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-sky-200 bg-sky-50 text-sky-600 transition hover:bg-sky-100"
                                      title="发放任务"
                                      aria-label={`发放任务 ${workbook.name}`}
                                      data-tooltip="发放任务"
                                      data-tooltip-side="top"
                                    >
                                      <UserRoundPlus className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {canManageWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setEditingWorkbook({ id: workbook.id, name: workbook.name })
                                        setEditWorkbookName(workbook.name)
                                      }}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                                      title="重命名"
                                      aria-label={`重命名 ${workbook.name}`}
                                      data-tooltip="重命名工作簿"
                                      data-tooltip-side="top"
                                    >
                                      <PencilLine className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  {canManageWorkbook(workbook) && canDeleteWorkbook(workbook) && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleDeleteWorkbook(e, workbook.id)}
                                      className="ui-tooltip inline-flex h-7 w-7 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
                                      title="删除工作簿"
                                      aria-label={`删除 ${workbook.name}`}
                                      data-tooltip="删除工作簿"
                                      data-tooltip-side="top"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => router.push(`/sheets/${workbook.id}`)}
                                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-sky-700 transition hover:bg-sky-50"
                                  >
                                    打开
                                    <ArrowRight className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
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

          {sharingFolder && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm">
              <div className="w-full max-w-2xl rounded-[28px] border border-white/70 bg-white p-6 shadow-[0_24px_80px_-48px_rgba(15,23,42,0.75)] md:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold uppercase tracking-[0.24em] text-sky-700">Folder Sharing</div>
                    <h2 className="mt-2 text-2xl font-semibold text-slate-950">共享文件夹</h2>
                    <p className="mt-2 text-sm text-slate-500">
                      文件夹「{sharingFolder.name}」默认仅创建者和管理员可见。你可以按用户分别设置为只读共享或可写共享。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSharingFolder(null)
                      setShareableUsers([])
                      setSelectedShares({})
                      setShareMessage('')
                    }}
                    className="ui-tooltip rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    title="关闭共享设置"
                    aria-label="关闭共享设置"
                    data-tooltip="关闭"
                    data-tooltip-side="left"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {shareMessage && (
                  <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-700">
                    {shareMessage}
                  </div>
                )}

                <div className="max-h-[380px] space-y-3 overflow-y-auto pr-1">
                  {shareLoading ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                      正在加载可共享用户...
                    </div>
                  ) : shareableUsers.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                      当前没有可共享的启用账号。
                    </div>
                  ) : (
                    shareableUsers.map((user) => {
                      const accessLevel = selectedShares[user.id]
                      const checked = Boolean(accessLevel)

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
                              setSelectedShares((current) => {
                                const next = { ...current }
                                if (event.target.checked) {
                                  next[user.id] = next[user.id] || 'view'
                                } else {
                                  delete next[user.id]
                                }
                                return next
                              })
                            }}
                            className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-900">{user.username}</div>
                            <div className="truncate text-sm text-slate-500">{user.email}</div>
                          </div>
                          <select
                            value={accessLevel || 'view'}
                            disabled={!checked}
                            onChange={(event) => {
                              const value = event.target.value as 'view' | 'edit'
                              setSelectedShares((current) => ({
                                ...current,
                                [user.id]: value,
                              }))
                            }}
                            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <option value="view">只读共享</option>
                            <option value="edit">可写共享</option>
                          </select>
                        </label>
                      )
                    })
                  )}
                </div>

                <div className="mt-6 flex items-center justify-between gap-3">
                  <div className="text-sm text-slate-500">
                    已共享给 {Object.keys(selectedShares).length} 位用户
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSharingFolder(null)
                        setShareableUsers([])
                        setSelectedShares({})
                        setShareMessage('')
                      }}
                      className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      关闭
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveFolderShares}
                      disabled={shareSaving || shareLoading || shareLoadFailed}
                      className="rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {shareSaving ? '保存中...' : '保存共享设置'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

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
                    className="ui-tooltip rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                    title="关闭任务发放"
                    aria-label="关闭任务发放"
                    data-tooltip="关闭"
                    data-tooltip-side="left"
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
          <WhatsAppSendDialog open={Boolean(whatsAppResource)} resource={whatsAppResource} onClose={() => setWhatsAppResource(null)} />
        </div>
      </div>
    </AuthGuard>
  )
}
