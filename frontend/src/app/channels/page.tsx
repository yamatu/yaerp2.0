'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FileText,
  FileUp,
  GripVertical,
  Globe2,
  Hash,
  Image as ImageIcon,
  Images,
  MessageSquare,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Reply,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  SlidersHorizontal,
  Square,
  Table2,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import AIMessageContent from '@/components/ai/AIMessageContent'
import { useWorkbooks } from '@/hooks/useSheet'
import api from '@/lib/api'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { notifyDataChanged } from '@/lib/dataEvents'
import type { AIAssistant, Channel, ChannelAIAskResult, ChannelAIMember, ChannelMember, ChannelMessage, ChannelMessageSearchResult, GalleryDirectory, GalleryImage, PageData, Sheet, User, Workbook } from '@/types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

function getChannelAIProgress(elapsedSeconds: number) {
  if (elapsedSeconds < 3) return { label: '正在理解频道问题', progress: 20 + elapsedSeconds * 6 }
  if (elapsedSeconds < 8) return { label: '正在读取消息与附件', progress: 40 + (elapsedSeconds - 3) * 5 }
  if (elapsedSeconds < 18) return { label: '正在分析表格或执行工具', progress: 65 + (elapsedSeconds - 8) * 1.8 }
  return { label: '正在整理频道回答', progress: Math.min(94, 83 + Math.floor((elapsedSeconds - 18) / 4)) }
}

interface PendingTable {
  workbook: Workbook
  sheet?: Sheet
}

interface ContextMenuState {
  x: number
  y: number
  kind: 'message' | 'composer'
  message?: ChannelMessage
}

type SidebarSearchMode = 'channels' | 'history'
type HistoryMatchMode = 'contains' | 'exact' | 'regex'
type HistoryMessageType = 'all' | 'text' | 'image'
type GalleryPickerMode = 'message' | 'channel-avatar'

function channelStorageKey(userId: number, suffix: string) {
  return `yaerp:channels:${userId}:${suffix}`
}

function readChannelSoundSetting(userId: number | null) {
  if (typeof window === 'undefined' || !userId) return true
  return localStorage.getItem(channelStorageKey(userId, 'sound-enabled')) !== 'false'
}

function readStoredNumber(key: string) {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(key)
  if (raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function hasDraggedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types || []).includes('Files')
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatChannelTime(value: string) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function isImageMessage(message: ChannelMessage) {
  return Boolean(message.attachment_url && message.attachment_mime_type?.startsWith('image/'))
}

function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || '#'
}

function messagePreview(message: ChannelMessage) {
  if (message.recalled_at) return '消息已撤回'
  return message.content || message.attachment_filename || message.linked_sheet_name || message.linked_workbook_name || message.linked_summary_title || '消息'
}

function canRecallMessage(message: ChannelMessage, currentUserId: number | null) {
  return message.sender_type !== 'ai'
    && currentUserId === message.sender_id
    && !message.recalled_at
    && Date.now() - new Date(message.created_at).getTime() <= 3 * 60 * 1000
}

function sameMessages(left: ChannelMessage[], right: ChannelMessage[]) {
  if (left.length !== right.length) return false
  return left.every((message, index) => {
    const next = right[index]
    return message.id === next.id
      && message.content === next.content
      && message.sender_type === next.sender_type
      && message.assistant_id === next.assistant_id
      && message.attachment_url === next.attachment_url
      && message.attachment_filename === next.attachment_filename
      && message.linked_workbook_id === next.linked_workbook_id
      && message.linked_sheet_id === next.linked_sheet_id
      && message.linked_summary_id === next.linked_summary_id
      && message.reply_to_message_id === next.reply_to_message_id
      && message.reply_content === next.reply_content
      && message.reply_recalled_at === next.reply_recalled_at
      && message.recalled_at === next.recalled_at
  })
}

export default function ChannelsPage() {
  const { workbooks } = useWorkbooks()
  const [currentUser] = useState(() => getStoredUser())
  const [channels, setChannels] = useState<Channel[]>([])
  const [activeChannelId, setActiveChannelId] = useState<number | null>(() => {
    const user = getStoredUser()
    return user ? readStoredNumber(channelStorageKey(user.id, 'active-channel')) : null
  })
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [directories, setDirectories] = useState<GalleryDirectory[]>([])
  const [currentUserId] = useState<number | null>(() => getStoredUser()?.id || null)
  const [loadingChannels, setLoadingChannels] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [forwarding, setForwarding] = useState(false)
  const [pinningChannelId, setPinningChannelId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(() => readChannelSoundSetting(getStoredUser()?.id || null))

  const [channelSearch, setChannelSearch] = useState('')
  const [sidebarSearchMode, setSidebarSearchMode] = useState<SidebarSearchMode>('channels')
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [historyKeyword, setHistoryKeyword] = useState('')
  const [historyMatchMode, setHistoryMatchMode] = useState<HistoryMatchMode>('contains')
  const [historyChannelId, setHistoryChannelId] = useState('')
  const [historySenderId, setHistorySenderId] = useState('')
  const [historyMessageType, setHistoryMessageType] = useState<HistoryMessageType>('all')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historyResults, setHistoryResults] = useState<ChannelMessageSearchResult[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [searchingHistory, setSearchingHistory] = useState(false)
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelDescription, setNewChannelDescription] = useState('')

  const [messageText, setMessageText] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingFilePreviewUrl, setPendingFilePreviewUrl] = useState('')
  const [pendingGalleryImage, setPendingGalleryImage] = useState<GalleryImage | null>(null)
  const [savePendingImage, setSavePendingImage] = useState(false)
  const [selectedDirectoryId, setSelectedDirectoryId] = useState('')
  const [pendingTable, setPendingTable] = useState<PendingTable | null>(null)
  const [makePendingTablePublic, setMakePendingTablePublic] = useState(false)
  const [replyingToMessage, setReplyingToMessage] = useState<ChannelMessage | null>(null)
  const [recallingMessageId, setRecallingMessageId] = useState<number | null>(null)

  const [isTablePickerOpen, setIsTablePickerOpen] = useState(false)
  const [tableSearch, setTableSearch] = useState('')
  const [tablePickerWorkbookId, setTablePickerWorkbookId] = useState('')
  const [tablePickerSheetId, setTablePickerSheetId] = useState('')
  const [tablePickerSheets, setTablePickerSheets] = useState<Sheet[]>([])
  const [loadingTableSheets, setLoadingTableSheets] = useState(false)
  const [tablePickerPage, setTablePickerPage] = useState(1)

  const [isGalleryPickerOpen, setIsGalleryPickerOpen] = useState(false)
  const [galleryPickerMode, setGalleryPickerMode] = useState<GalleryPickerMode>('message')
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [galleryImageSearch, setGalleryImageSearch] = useState('')
  const [selectedGalleryImageId, setSelectedGalleryImageId] = useState('')
  const [loadingGalleryImages, setLoadingGalleryImages] = useState(false)
  const [renamingGalleryImage, setRenamingGalleryImage] = useState<GalleryImage | null>(null)
  const [galleryRenameValue, setGalleryRenameValue] = useState('')
  const [savingGalleryRename, setSavingGalleryRename] = useState(false)
  const [galleryRenameError, setGalleryRenameError] = useState('')

  const [forwardingMessage, setForwardingMessage] = useState<ChannelMessage | null>(null)
  const [forwardSearch, setForwardSearch] = useState('')
  const [forwardTargetChannelId, setForwardTargetChannelId] = useState('')

  const [isManageOpen, setIsManageOpen] = useState(false)
  const [isAssistantPickerOpen, setIsAssistantPickerOpen] = useState(false)
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([])
  const [availableAssistants, setAvailableAssistants] = useState<AIAssistant[]>([])
  const [channelAIMembers, setChannelAIMembers] = useState<ChannelAIMember[]>([])
  const [selectedChannelAssistantIds, setSelectedChannelAssistantIds] = useState<number[]>([])
  const [loadingAssistants, setLoadingAssistants] = useState(false)
  const [savingAssistants, setSavingAssistants] = useState(false)
  const [openingAssistantId, setOpeningAssistantId] = useState<number | null>(null)
  const [selectedAskAssistantId, setSelectedAskAssistantId] = useState<number | null>(null)
  const [askingAI, setAskingAI] = useState(false)
  const [aiThinkingElapsed, setAIThinkingElapsed] = useState(0)
  const [shareableUsers, setShareableUsers] = useState<User[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([])
  const [manageChannelName, setManageChannelName] = useState('')
  const [manageChannelDescription, setManageChannelDescription] = useState('')
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [savingChannel, setSavingChannel] = useState(false)
  const [addingMembers, setAddingMembers] = useState(false)
  const [removingMemberId, setRemovingMemberId] = useState<number | null>(null)
  const [uploadingChannelAvatar, setUploadingChannelAvatar] = useState(false)

  const [previewImageMessage, setPreviewImageMessage] = useState<ChannelMessage | null>(null)
  const [imageZoom, setImageZoom] = useState(1)
  const [previewDirectoryId, setPreviewDirectoryId] = useState('')
  const [savingImage, setSavingImage] = useState(false)
  const [savedImageIds, setSavedImageIds] = useState<number[]>([])

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [draggingMessageId, setDraggingMessageId] = useState<number | null>(null)
  const [dropTargetChannelId, setDropTargetChannelId] = useState<number | null>(null)
  const [isExternalFileDragging, setIsExternalFileDragging] = useState(false)
  const [draggingPinnedChannelId, setDraggingPinnedChannelId] = useState<number | null>(null)
  const [reorderingPins, setReorderingPins] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const channelAvatarInputRef = useRef<HTMLInputElement | null>(null)
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesViewportRef = useRef<HTMLDivElement | null>(null)
  const channelListRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const suppressImageClickRef = useRef(false)
  const pendingMessageScrollRef = useRef<number | 'bottom' | null>(null)
  const loadedMessagesChannelIdRef = useRef<number | null>(null)
  const externalDragDepthRef = useRef(0)
  const soundEnabledRef = useRef(soundEnabled)
  const audioContextRef = useRef<AudioContext | null>(null)
  const latestMessageIdsRef = useRef<Map<number, number>>(new Map())
  const channelsInitializedRef = useRef(false)

  const activeChannel = channels.find((channel) => channel.id === activeChannelId) || null
  const totalUnreadCount = useMemo(() => channels.reduce((sum, channel) => sum + (channel.unread_count || 0), 0), [channels])
  const selectedAskAssistantName = useMemo(() => {
    if (!selectedAskAssistantId) return ''
    return channelAIMembers.find((assistant) => assistant.assistant_id === selectedAskAssistantId)?.name
      || availableAssistants.find((assistant) => assistant.id === selectedAskAssistantId)?.name
      || activeChannel?.ai_assistant_name
      || 'AI 助手'
  }, [activeChannel?.ai_assistant_name, availableAssistants, channelAIMembers, selectedAskAssistantId])
  const selectedAskAssistant = useMemo(() => {
    if (!selectedAskAssistantId) return null
    const channelAssistant = channelAIMembers.find((assistant) => assistant.assistant_id === selectedAskAssistantId)
    if (channelAssistant) return channelAssistant
    return availableAssistants.find((assistant) => assistant.id === selectedAskAssistantId) || null
  }, [availableAssistants, channelAIMembers, selectedAskAssistantId])
  const channelAIProgress = getChannelAIProgress(aiThinkingElapsed)

  useEffect(() => {
    if (!askingAI) {
      setAIThinkingElapsed(0)
      return
    }
    const startedAt = Date.now()
    const update = () => setAIThinkingElapsed(Math.floor((Date.now() - startedAt) / 1000))
    update()
    const timer = window.setInterval(update, 700)
    return () => window.clearInterval(timer)
  }, [askingAI])

  const sortedChannels = useMemo(
    () => [...channels].sort((left, right) => {
      if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1
      if (left.is_pinned && right.is_pinned && left.pin_sort_order !== right.pin_sort_order) {
        return left.pin_sort_order - right.pin_sort_order
      }
      return right.updated_at.localeCompare(left.updated_at)
    }),
    [channels]
  )

  const filteredChannels = useMemo(() => {
    const keyword = channelSearch.trim().toLowerCase()
    if (!keyword) return sortedChannels
    return sortedChannels.filter((channel) => [channel.name, channel.description, channel.owner_name]
      .some((value) => value?.toLowerCase().includes(keyword)))
  }, [channelSearch, sortedChannels])

  const filteredForwardChannels = useMemo(() => {
    const keyword = forwardSearch.trim().toLowerCase()
    return sortedChannels.filter((channel) => channel.id !== activeChannelId
      && (!keyword || channel.name.toLowerCase().includes(keyword)))
  }, [activeChannelId, forwardSearch, sortedChannels])

  const filteredTableWorkbooks = useMemo(() => {
    const keyword = tableSearch.trim().toLowerCase()
    return [...workbooks]
      .filter((workbook) => !keyword || [workbook.name, workbook.owner_name, workbook.description]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.name.localeCompare(right.name, 'zh-CN'))
  }, [tableSearch, workbooks])

  const tablePickerPageSize = 30
  const totalTablePickerPages = Math.max(1, Math.ceil(filteredTableWorkbooks.length / tablePickerPageSize))
  const paginatedTableWorkbooks = useMemo(() => {
    const start = (tablePickerPage - 1) * tablePickerPageSize
    return filteredTableWorkbooks.slice(start, start + tablePickerPageSize)
  }, [filteredTableWorkbooks, tablePickerPage])

  const filteredGalleryImages = useMemo(() => {
    const keyword = galleryImageSearch.trim().toLowerCase()
    if (!keyword) return galleryImages
    return galleryImages.filter((image) => image.filename.toLowerCase().includes(keyword))
  }, [galleryImageSearch, galleryImages])

  const selectedPickerWorkbook = workbooks.find((workbook) => String(workbook.id) === tablePickerWorkbookId) || null
  const canPublishSelectedPickerWorkbook = Boolean(
    currentUser && selectedPickerWorkbook && (currentUser.id === selectedPickerWorkbook.owner_id || isAdmin(currentUser))
  )

  const availableDirectories = useMemo(
    () => directories.filter((directory) => !directory.channel_id || directory.channel_id === activeChannelId),
    [activeChannelId, directories]
  )

  const filteredMemberCandidates = useMemo(() => {
    const memberIds = new Set(channelMembers.map((member) => member.user_id))
    const keyword = memberSearch.trim().toLowerCase()
    return shareableUsers.filter((user) => {
      if (memberIds.has(user.id)) return false
      if (!keyword) return true
      return user.username.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword)
    })
  }, [channelMembers, memberSearch, shareableUsers])

  const historyUsers = useMemo(() => {
    const users = new Map<number, User>()
    if (currentUser) users.set(currentUser.id, currentUser)
    shareableUsers.forEach((user) => users.set(user.id, user))
    return [...users.values()].sort((left, right) => left.username.localeCompare(right.username, 'zh-CN'))
  }, [currentUser, shareableUsers])

  const ensureNotificationAudio = useCallback(async () => {
    if (typeof window === 'undefined') return null
    const AudioContextClass = window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return null
    if (!audioContextRef.current) audioContextRef.current = new AudioContextClass()
    if (audioContextRef.current.state === 'suspended') {
      try {
        await audioContextRef.current.resume()
      } catch {
        return null
      }
    }
    return audioContextRef.current
  }, [])

  const playNotificationSound = useCallback(async (force = false) => {
    if (!force && !soundEnabledRef.current) return
    const context = await ensureNotificationAudio()
    if (!context) return
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const now = context.currentTime
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(660, now)
    oscillator.frequency.setValueAtTime(880, now + 0.12)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.3)
  }, [ensureNotificationAudio])

  const loadChannels = useCallback(async (silent = false) => {
    if (!silent) setLoadingChannels(true)
    try {
      const res = await api.get<Channel[]>('/channels')
      if (res.code !== 0 || !res.data) {
        if (!silent) setError(res.message || '加载频道失败')
        return
      }
      const nextChannels = res.data
      const nextLatestMessageIds = new Map<number, number>()
      const newMessageChannels: Channel[] = []
      nextChannels.forEach((channel) => {
        const latestMessageId = channel.last_message_id || 0
        nextLatestMessageIds.set(channel.id, latestMessageId)
        const previousMessageId = latestMessageIdsRef.current.get(channel.id)
        if (channelsInitializedRef.current
          && previousMessageId !== undefined
          && latestMessageId > previousMessageId
          && channel.last_message_sender_id !== currentUserId
          && channel.unread_count > 0) {
          newMessageChannels.push(channel)
        }
      })
      latestMessageIdsRef.current = nextLatestMessageIds
      if (channelsInitializedRef.current && newMessageChannels.length > 0) {
        void playNotificationSound()
      }
      channelsInitializedRef.current = true
      setChannels(nextChannels)
      setActiveChannelId((current) => {
        if (current && res.data?.some((channel) => channel.id === current)) return current
        const stored = currentUserId ? readStoredNumber(channelStorageKey(currentUserId, 'active-channel')) : null
        if (stored && res.data?.some((channel) => channel.id === stored)) return stored
        return res.data?.[0]?.id ?? null
      })
    } catch {
      if (!silent) setError('加载频道失败')
    } finally {
      if (!silent) setLoadingChannels(false)
    }
  }, [currentUserId, playNotificationSound])

  const loadMessages = useCallback(async (channelId: number | null, silent = false) => {
    if (!channelId) {
      setMessages([])
      loadedMessagesChannelIdRef.current = null
      return
    }
    if (!silent) setLoadingMessages(true)
    try {
      const res = await api.get<PageData<ChannelMessage>>(`/channels/${channelId}/messages?page=1&size=100`)
      const nextMessages = res.code === 0 && res.data ? res.data.list : []
      setMessages((current) => sameMessages(current, nextMessages) ? current : nextMessages)
    } catch {
      if (!silent) setMessages([])
    } finally {
      loadedMessagesChannelIdRef.current = channelId
      if (!silent) setLoadingMessages(false)
    }
  }, [])

  const markChannelRead = useCallback(async (channelId: number) => {
    try {
      const res = await api.post(`/channels/${channelId}/read`)
      if (res.code === 0) {
        setChannels((current) => current.map((channel) => channel.id === channelId
          ? { ...channel, unread_count: 0 }
          : channel))
      }
    } catch {
      // A failed read receipt should not interrupt message viewing.
    }
  }, [])

  const loadDirectories = useCallback(async () => {
    try {
      const res = await api.get<GalleryDirectory[]>('/gallery/directories')
      setDirectories(res.code === 0 && res.data ? res.data : [])
    } catch {
      setDirectories([])
    }
  }, [])

  const loadGalleryImages = useCallback(async () => {
    setLoadingGalleryImages(true)
    try {
      const res = await api.get<PageData<GalleryImage>>('/attachments/images?page=1&size=100')
      setGalleryImages(res.code === 0 && res.data ? res.data.list : [])
    } catch {
      setGalleryImages([])
    } finally {
      setLoadingGalleryImages(false)
    }
  }, [])

  const loadChannelMembers = useCallback(async (channelId: number) => {
    setLoadingMembers(true)
    try {
      const res = await api.get<ChannelMember[]>(`/channels/${channelId}/members`)
      setChannelMembers(res.code === 0 && res.data ? res.data : [])
    } catch {
      setChannelMembers([])
    } finally {
      setLoadingMembers(false)
    }
  }, [])

  const loadAvailableAssistants = useCallback(async () => {
    setLoadingAssistants(true)
    try {
      const res = await api.get<AIAssistant[]>('/ai/assistants')
      setAvailableAssistants(res.code === 0 && res.data ? res.data.filter((assistant) => assistant.enabled && assistant.id > 0) : [])
    } catch {
      setAvailableAssistants([])
    } finally {
      setLoadingAssistants(false)
    }
  }, [])

  const loadChannelAIMembers = useCallback(async (channelId: number) => {
    try {
      const res = await api.get<ChannelAIMember[]>(`/channels/${channelId}/ai-members`)
      const members = res.code === 0 && res.data ? res.data : []
      setChannelAIMembers(members)
      setSelectedChannelAssistantIds(members.map((member) => member.assistant_id))
    } catch {
      setChannelAIMembers([])
      setSelectedChannelAssistantIds([])
    }
  }, [])

  const loadShareableUsers = useCallback(async () => {
    try {
      const res = await api.get<User[]>('/users/shareable')
      setShareableUsers(res.code === 0 && res.data ? res.data : [])
    } catch {
      setShareableUsers([])
    }
  }, [])

  useEffect(() => {
    void Promise.all([loadChannels(), loadDirectories(), loadAvailableAssistants()])
  }, [loadAvailableAssistants, loadChannels, loadDirectories])

  useEffect(() => {
    soundEnabledRef.current = soundEnabled
    if (currentUserId) {
      localStorage.setItem(channelStorageKey(currentUserId, 'sound-enabled'), String(soundEnabled))
    }
  }, [currentUserId, soundEnabled])

  useEffect(() => {
    const baseTitle = '频道 - YaERP 2.0'
    document.title = totalUnreadCount > 0 ? `(${totalUnreadCount}) ${baseTitle}` : baseTitle
    return () => {
      document.title = 'YaERP 2.0'
    }
  }, [totalUnreadCount])

  useEffect(() => {
    const unlockAudio = () => {
      if (soundEnabledRef.current) void ensureNotificationAudio()
    }
    window.addEventListener('pointerdown', unlockAudio, { once: true })
    window.addEventListener('keydown', unlockAudio, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [ensureNotificationAudio])

  useEffect(() => () => {
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context && context.state !== 'closed') void context.close()
  }, [])

  useEffect(() => {
    loadedMessagesChannelIdRef.current = null
    const storedScroll = activeChannelId && currentUserId
      ? readStoredNumber(channelStorageKey(currentUserId, `message-scroll:${activeChannelId}`))
      : null
    pendingMessageScrollRef.current = storedScroll ?? 'bottom'
    shouldStickToBottomRef.current = storedScroll === null
    setSelectedDirectoryId('')
    setSavePendingImage(false)
    setMessageText('')
    setPendingFile(null)
    setPendingGalleryImage(null)
    setPendingTable(null)
    setMakePendingTablePublic(false)
    setReplyingToMessage(null)
    setSelectedAskAssistantId(null)
    setContextMenu(null)
    externalDragDepthRef.current = 0
    setIsExternalFileDragging(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!activeChannelId) {
      void loadMessages(null)
      setChannelAIMembers([])
      return
    }
    void (async () => {
      await Promise.all([loadMessages(activeChannelId), loadChannelAIMembers(activeChannelId)])
      if (document.visibilityState === 'visible') await markChannelRead(activeChannelId)
      await loadChannels(true)
    })()
  }, [activeChannelId, currentUserId, loadChannelAIMembers, loadChannels, loadMessages, markChannelRead])

  useEffect(() => {
    if (activeChannel?.channel_type !== 'ai_private' || !activeChannel.ai_assistant_id) return
    setSelectedAskAssistantId(activeChannel.ai_assistant_id)
  }, [activeChannel?.ai_assistant_id, activeChannel?.channel_type])

  useEffect(() => {
    if (!activeChannelId || !currentUserId) return
    localStorage.setItem(channelStorageKey(currentUserId, 'active-channel'), String(activeChannelId))
  }, [activeChannelId, currentUserId])

  useEffect(() => {
    if (loadingChannels || !currentUserId || sidebarSearchMode !== 'channels') return
    const storedScroll = readStoredNumber(channelStorageKey(currentUserId, 'channel-list-scroll'))
    if (storedScroll === null) return
    const frame = window.requestAnimationFrame(() => {
      if (channelListRef.current) channelListRef.current.scrollTop = storedScroll
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentUserId, loadingChannels, sidebarSearchMode, sortedChannels.length])

  useEffect(() => {
    if (!isGalleryPickerOpen) return
    setGalleryImageSearch('')
    setSelectedGalleryImageId(galleryPickerMode === 'channel-avatar'
      ? (activeChannel?.avatar_attachment_id ? String(activeChannel.avatar_attachment_id) : '')
      : (pendingGalleryImage ? String(pendingGalleryImage.id) : ''))
    void loadGalleryImages()
  }, [activeChannel?.avatar_attachment_id, galleryPickerMode, isGalleryPickerOpen, loadGalleryImages, pendingGalleryImage])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const closeMenu = () => setContextMenu(null)
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  useEffect(() => {
    if (!activeChannelId) return
    const timer = window.setInterval(() => {
      void (async () => {
        await loadMessages(activeChannelId, true)
        if (document.visibilityState === 'visible') await markChannelRead(activeChannelId)
        await loadChannels(true)
      })()
    }, 8000)
    return () => window.clearInterval(timer)
  }, [activeChannelId, loadChannels, loadMessages, markChannelRead])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !activeChannelId) return
      void (async () => {
        await loadMessages(activeChannelId, true)
        await markChannelRead(activeChannelId)
        await loadChannels(true)
      })()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [activeChannelId, loadChannels, loadMessages, markChannelRead])

  useEffect(() => {
    if (!pendingFile || !pendingFile.type.startsWith('image/')) {
      setPendingFilePreviewUrl('')
      return
    }
    const previewUrl = URL.createObjectURL(pendingFile)
    setPendingFilePreviewUrl(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [pendingFile])

  useEffect(() => {
    const viewport = messagesViewportRef.current
    if (!viewport || !activeChannelId || loadedMessagesChannelIdRef.current !== activeChannelId) return
    const frame = window.requestAnimationFrame(() => {
      const pendingScroll = pendingMessageScrollRef.current
      if (pendingScroll === 'bottom') {
        viewport.scrollTop = viewport.scrollHeight
        shouldStickToBottomRef.current = true
        pendingMessageScrollRef.current = null
        return
      }
      if (typeof pendingScroll === 'number') {
        viewport.scrollTop = Math.min(pendingScroll, Math.max(0, viewport.scrollHeight - viewport.clientHeight))
        shouldStickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120
        pendingMessageScrollRef.current = null
        return
      }
      if (shouldStickToBottomRef.current) viewport.scrollTop = viewport.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeChannelId, loadingMessages, messages.length])

  useEffect(() => {
    if (!highlightMessageId || loadedMessagesChannelIdRef.current !== activeChannelId) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-message-id="${highlightMessageId}"]`)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    const timer = window.setTimeout(() => setHighlightMessageId(null), 3200)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [activeChannelId, highlightMessageId, messages])

  useEffect(() => {
    if (!isTablePickerOpen) return
    const initialWorkbookId = pendingTable?.workbook.id || workbooks[0]?.id
    setTablePickerWorkbookId(initialWorkbookId ? String(initialWorkbookId) : '')
    setTablePickerSheetId(pendingTable?.sheet ? String(pendingTable.sheet.id) : '')
    if (!pendingTable) {
      const initialWorkbook = workbooks.find((workbook) => workbook.id === initialWorkbookId)
      setMakePendingTablePublic(Boolean(initialWorkbook?.is_public))
    }
    setTableSearch('')
    setTablePickerPage(1)
  }, [isTablePickerOpen, pendingTable, workbooks])

  useEffect(() => {
    setTablePickerPage(1)
  }, [tableSearch])

  useEffect(() => {
    if (tablePickerPage > totalTablePickerPages) setTablePickerPage(totalTablePickerPages)
  }, [tablePickerPage, totalTablePickerPages])

  useEffect(() => {
    const resetExternalDrag = () => {
      externalDragDepthRef.current = 0
      setIsExternalFileDragging(false)
    }
    window.addEventListener('dragend', resetExternalDrag)
    window.addEventListener('drop', resetExternalDrag)
    return () => {
      window.removeEventListener('dragend', resetExternalDrag)
      window.removeEventListener('drop', resetExternalDrag)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setTablePickerSheets([])
    if (!tablePickerWorkbookId) {
      setLoadingTableSheets(false)
      return () => {
        cancelled = true
      }
    }

    setLoadingTableSheets(true)
    ;(async () => {
      try {
        const res = await api.get<Workbook>(`/workbooks/${tablePickerWorkbookId}`)
        if (!cancelled) {
          setTablePickerSheets(res.code === 0 && res.data?.sheets ? res.data.sheets : [])
        }
      } catch {
        if (!cancelled) setTablePickerSheets([])
      } finally {
        if (!cancelled) setLoadingTableSheets(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tablePickerWorkbookId])

  useEffect(() => {
    if (!previewImageMessage) return
    setImageZoom(1)
    setPreviewDirectoryId('')
  }, [previewImageMessage])

  const handleCreateChannel = async () => {
    if (!newChannelName.trim() || creatingChannel) return
    setCreatingChannel(true)
    setError('')
    try {
      const res = await api.post<Channel>('/channels', {
        name: newChannelName.trim(),
        description: newChannelDescription.trim() || undefined,
      })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '创建频道失败')
        return
      }
      setNewChannelName('')
      setNewChannelDescription('')
      setIsCreateOpen(false)
      await loadChannels(true)
      setActiveChannelId(res.data.id)
    } catch {
      setError('创建频道失败')
    } finally {
      setCreatingChannel(false)
    }
  }

  const sendMessage = async () => {
    if (!activeChannelId || sending) return
    const hasMessage = messageText.trim() || pendingFile || pendingGalleryImage || pendingTable
    if (!hasMessage) return
    if (selectedAskAssistantId && !messageText.trim()) {
      setError('向机器人提问时需要输入文字问题。')
      return
    }
    setSending(true)
    setAskingAI(Boolean(selectedAskAssistantId))
    setError('')
    shouldStickToBottomRef.current = true
    try {
      if (selectedAskAssistantId) {
        let attachmentId = pendingGalleryImage?.id
        if (pendingFile) {
          const uploadRes = await api.upload(pendingFile)
          if (uploadRes.code !== 0 || !uploadRes.data?.id) {
            setError(uploadRes.message || '附件上传失败')
            return
          }
          attachmentId = uploadRes.data.id
        }
        const response = await api.post<ChannelAIAskResult>(`/channels/${activeChannelId}/ai/ask`, {
          assistant_id: selectedAskAssistantId,
          content: messageText.trim(),
          reply_to_message_id: replyingToMessage?.id,
          attachment_id: attachmentId,
          workbook_id: pendingTable?.workbook.id,
          sheet_ids: pendingTable?.sheet ? [pendingTable.sheet.id] : [],
        })
        if (response.code !== 0 || !response.data) {
          setError(response.message || '机器人回答失败')
          return
        }
        setMessageText('')
        setPendingFile(null)
        setPendingGalleryImage(null)
        setPendingTable(null)
        setMakePendingTablePublic(false)
        setReplyingToMessage(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
        if (activeChannel?.channel_type !== 'ai_private') setSelectedAskAssistantId(null)
        notifyDataChanged({
          source: 'ai',
          sheetIds: response.data.changed_sheet_ids || response.data.touched_sheet_ids || [],
          resourcesChanged: Boolean(response.data.resources_changed),
        })
        await Promise.all([loadMessages(activeChannelId, true), loadChannels(true)])
        return
      }

      const formData = new FormData()
      formData.append('content', messageText.trim())
      if (pendingFile) formData.append('file', pendingFile)
      if (pendingGalleryImage) formData.append('attachment_id', String(pendingGalleryImage.id))
      if (pendingTable) {
        formData.append('linked_workbook_id', String(pendingTable.workbook.id))
        if (pendingTable.sheet) formData.append('linked_sheet_id', String(pendingTable.sheet.id))
        if (makePendingTablePublic) formData.append('make_workbook_public', 'true')
      }
      if (replyingToMessage) formData.append('reply_to_message_id', String(replyingToMessage.id))
      if (pendingFile?.type.startsWith('image/') && savePendingImage) {
        formData.append('save_to_gallery', 'true')
        if (selectedDirectoryId) formData.append('gallery_directory_id', selectedDirectoryId)
      }
      const res = await fetch(`${API_BASE}/channels/${activeChannelId}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })
      const data = await res.json()
      if (!res.ok || data.code !== 0) {
        setError(data.message || '发送失败')
        return
      }
      setMessageText('')
      setPendingFile(null)
      setPendingGalleryImage(null)
      setPendingTable(null)
      setMakePendingTablePublic(false)
      setReplyingToMessage(null)
      setSavePendingImage(false)
      setSelectedDirectoryId('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      await Promise.all([loadMessages(activeChannelId, true), loadChannels(true), loadDirectories()])
    } catch {
      setError('发送失败')
    } finally {
      setSending(false)
      setAskingAI(false)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void sendMessage()
  }

  const selectPendingFile = (file: File | null) => {
    if (!file) return
    if (selectedAskAssistantId) {
      const isImage = file.type.startsWith('image/')
      if (isImage && !selectedAskAssistant?.supports_vision) {
        setError('当前机器人未启用图片理解能力。')
        return
      }
      if (!isImage && !selectedAskAssistant?.supports_files) {
        setError('当前机器人未启用文件读取能力。')
        return
      }
    }
    setPendingFile(file)
    setPendingGalleryImage(null)
    setSavePendingImage(false)
    setSelectedDirectoryId('')
    window.requestAnimationFrame(() => messageInputRef.current?.focus())
  }

  const handleExternalFileDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!activeChannel || sending || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    externalDragDepthRef.current += 1
    setIsExternalFileDragging(true)
  }

  const handleExternalFileDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!activeChannel || sending || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!isExternalFileDragging) setIsExternalFileDragging(true)
  }

  const handleExternalFileDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!isExternalFileDragging) return
    event.preventDefault()
    externalDragDepthRef.current = Math.max(0, externalDragDepthRef.current - 1)
    if (externalDragDepthRef.current === 0) setIsExternalFileDragging(false)
  }

  const handleExternalFileDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!activeChannel || sending || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    externalDragDepthRef.current = 0
    setIsExternalFileDragging(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length === 0) return
    selectPendingFile(files[0])
    if (files.length > 1) setNotice(`已添加 ${files[0].name}，每条消息可发送一个外部文件`)
  }

  const clearPendingFile = () => {
    setPendingFile(null)
    setSavePendingImage(false)
    setSelectedDirectoryId('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const confirmGallerySelection = async () => {
    const selected = galleryImages.find((image) => String(image.id) === selectedGalleryImageId)
    if (!selected) return
    if (galleryPickerMode === 'channel-avatar') {
      await setChannelAvatar(selected.id)
      setIsGalleryPickerOpen(false)
      return
    }
    setPendingGalleryImage(selected)
    setPendingFile(null)
    setSavePendingImage(false)
    setSelectedDirectoryId('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    setIsGalleryPickerOpen(false)
  }

  const confirmTableSelection = () => {
    if (!selectedPickerWorkbook) return
    const selectedSheet = tablePickerSheetId
      ? tablePickerSheets.find((sheet) => String(sheet.id) === tablePickerSheetId)
      : undefined
    setPendingTable({ workbook: selectedPickerWorkbook, sheet: selectedSheet })
    setIsTablePickerOpen(false)
  }

  const openForwardDialog = (message: ChannelMessage) => {
    setForwardingMessage(message)
    setForwardTargetChannelId('')
    setForwardSearch('')
  }

  const forwardMessageToChannel = async (message: ChannelMessage, targetChannelId: number) => {
    if (message.channel_id === targetChannelId) return false
    setForwarding(true)
    setError('')
    try {
      const res = await api.post<ChannelMessage>(
        `/channels/${message.channel_id}/messages/${message.id}/forward`,
        { target_channel_id: targetChannelId }
      )
      if (res.code !== 0) {
        setError(res.message || '转发失败')
        return false
      }
      await loadChannels(true)
      return true
    } catch {
      setError('转发失败')
      return false
    } finally {
      setForwarding(false)
    }
  }

  const handleForward = async () => {
    if (!forwardingMessage || !forwardTargetChannelId || forwarding) return
    const success = await forwardMessageToChannel(forwardingMessage, Number(forwardTargetChannelId))
    if (!success) return
    setForwardingMessage(null)
    setForwardTargetChannelId('')
    setNotice('消息已转发')
  }

  const handleTogglePin = async (channel: Channel) => {
    if (pinningChannelId) return
    setPinningChannelId(channel.id)
    try {
      const res = await api.post(`/channels/${channel.id}/pin`, { pinned: !channel.is_pinned })
      if (res.code !== 0) {
        setError(res.message || '置顶操作失败')
        return
      }
      await loadChannels(true)
    } catch {
      setError('置顶操作失败')
    } finally {
      setPinningChannelId(null)
    }
  }

  const handlePinnedChannelDrop = async (targetChannelId: number) => {
    if (!draggingPinnedChannelId || draggingPinnedChannelId === targetChannelId || reorderingPins) return
    const pinnedChannels = sortedChannels.filter((channel) => channel.is_pinned)
    const fromIndex = pinnedChannels.findIndex((channel) => channel.id === draggingPinnedChannelId)
    const targetIndex = pinnedChannels.findIndex((channel) => channel.id === targetChannelId)
    if (fromIndex < 0 || targetIndex < 0) return
    const reordered = [...pinnedChannels]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(targetIndex, 0, moved)
    const orderIds = reordered.map((channel) => channel.id)
    setChannels((current) => current.map((channel) => {
      const orderIndex = orderIds.indexOf(channel.id)
      return orderIndex >= 0 ? { ...channel, pin_sort_order: orderIndex + 1 } : channel
    }))
    setReorderingPins(true)
    try {
      const res = await api.put('/channels/pins/order', { channel_ids: orderIds })
      if (res.code !== 0) {
        setError(res.message || '保存置顶顺序失败')
        await loadChannels(true)
      }
    } catch {
      setError('保存置顶顺序失败')
      await loadChannels(true)
    } finally {
      setDraggingPinnedChannelId(null)
      setReorderingPins(false)
    }
  }

  const setChannelAvatar = async (attachmentId: number) => {
    if (!activeChannel) return
    const res = await api.put<Channel>(`/channels/${activeChannel.id}/avatar`, { attachment_id: attachmentId })
    if (res.code !== 0) throw new Error(res.message || '设置频道头像失败')
    await loadChannels(true)
    setNotice('频道头像已更新')
  }

  const handleChannelAvatarUpload = async (file: File | null) => {
    if (!file || !activeChannel || uploadingChannelAvatar) return
    if (!file.type.startsWith('image/')) {
      setError('频道头像必须是图片')
      return
    }
    setUploadingChannelAvatar(true)
    try {
      const uploadRes = await api.upload(file)
      if (uploadRes.code !== 0 || !uploadRes.data?.id) throw new Error(uploadRes.message || '上传头像失败')
      await setChannelAvatar(uploadRes.data.id)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : '上传头像失败')
    } finally {
      setUploadingChannelAvatar(false)
      if (channelAvatarInputRef.current) channelAvatarInputRef.current.value = ''
    }
  }

  const startReply = (message: ChannelMessage) => {
    if (message.recalled_at) return
    setReplyingToMessage(message)
    setContextMenu(null)
    window.requestAnimationFrame(() => messageInputRef.current?.focus())
  }

  const handleRecallMessage = async (message: ChannelMessage) => {
    if (!canRecallMessage(message, currentUserId) || recallingMessageId) return
    setRecallingMessageId(message.id)
    setContextMenu(null)
    try {
      const res = await api.post<ChannelMessage>(`/channels/${message.channel_id}/messages/${message.id}/recall`)
      if (res.code !== 0) {
        setError(res.message || '撤回消息失败')
        return
      }
      setMessages((current) => current.map((item) => item.id === message.id && res.data ? res.data : item))
      setReplyingToMessage((current) => current?.id === message.id ? null : current)
      setNotice('消息已撤回')
      await loadChannels(true)
    } catch {
      setError('撤回消息失败')
    } finally {
      setRecallingMessageId(null)
    }
  }

  const handleSaveChannelSettings = async () => {
    if (!activeChannel || !manageChannelName.trim() || savingChannel) return
    setSavingChannel(true)
    try {
      const res = await api.put<Channel>(`/channels/${activeChannel.id}`, {
        name: manageChannelName.trim(),
        description: manageChannelDescription.trim(),
      })
      if (res.code !== 0) {
        setError(res.message || '保存频道设置失败')
        return
      }
      await loadChannels(true)
      setNotice('频道设置已保存')
    } catch {
      setError('保存频道设置失败')
    } finally {
      setSavingChannel(false)
    }
  }

  const openManageChannel = () => {
    if (!activeChannel) return
    setManageChannelName(activeChannel.name)
    setManageChannelDescription(activeChannel.description || '')
    setMemberSearch('')
    setSelectedMemberIds([])
    setChannelMembers([])
    setChannelAIMembers([])
    setSelectedChannelAssistantIds([])
    setIsManageOpen(true)
    void Promise.all([loadChannelMembers(activeChannel.id), loadShareableUsers(), loadAvailableAssistants(), loadChannelAIMembers(activeChannel.id)])
  }

  const handleSaveAIMembers = async () => {
    if (!activeChannel || savingAssistants) return
    setSavingAssistants(true)
    setError('')
    try {
      const res = await api.put<ChannelAIMember[]>(`/channels/${activeChannel.id}/ai-members`, {
        assistant_ids: selectedChannelAssistantIds,
      })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '保存频道机器人失败')
        return
      }
      setChannelAIMembers(res.data)
      await loadChannels(true)
      setNotice('频道机器人已更新')
    } catch {
      setError('保存频道机器人失败')
    } finally {
      setSavingAssistants(false)
    }
  }

  const handleOpenAIPrivateChannel = async (assistant: AIAssistant) => {
    if (openingAssistantId !== null) return
    setOpeningAssistantId(assistant.id)
    setError('')
    try {
      const res = await api.post<Channel>('/channels/ai/private', { assistant_id: assistant.id })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '打开机器人私聊失败')
        return
      }
      await loadChannels(true)
      setActiveChannelId(res.data.id)
      setSelectedAskAssistantId(assistant.id)
      setIsAssistantPickerOpen(false)
    } catch {
      setError('打开机器人私聊失败')
    } finally {
      setOpeningAssistantId(null)
    }
  }

  const selectAssistantForQuestion = (assistantID: number, message?: ChannelMessage) => {
    if (pendingFile || pendingGalleryImage || pendingTable) {
      setError('当前已有待发送附件，请先移除附件再向机器人提问。')
      setContextMenu(null)
      return
    }
    const assistant = channelAIMembers.find((item) => item.assistant_id === assistantID)
    setSelectedAskAssistantId(assistantID)
    if (message) {
      setReplyingToMessage(message)
      setMessageText((current) => current.trim() ? current : `请结合这条消息回答：${messagePreview(message)}`)
    }
    setContextMenu(null)
    window.requestAnimationFrame(() => messageInputRef.current?.focus())
    if (assistant) setNotice(`已 @${assistant.name}`)
  }

  const toggleSelectedMember = (userId: number) => {
    setSelectedMemberIds((current) => current.includes(userId)
      ? current.filter((id) => id !== userId)
      : [...current, userId])
  }

  const toggleSelectedAssistant = (assistantId: number) => {
    setSelectedChannelAssistantIds((current) => current.includes(assistantId)
      ? current.filter((id) => id !== assistantId)
      : [...current, assistantId])
  }

  const handleAskAssistantSelection = (value: string) => {
    const assistantId = Number(value)
    setSelectedAskAssistantId(assistantId > 0 ? assistantId : null)
    window.requestAnimationFrame(() => messageInputRef.current?.focus())
  }

  const handleAddMembers = async () => {
    if (!activeChannel || selectedMemberIds.length === 0 || addingMembers) return
    setAddingMembers(true)
    try {
      const res = await api.post<ChannelMember[]>(`/channels/${activeChannel.id}/members`, { user_ids: selectedMemberIds })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '添加成员失败')
        return
      }
      setChannelMembers(res.data)
      setSelectedMemberIds([])
      await loadChannels(true)
      setNotice('成员已添加')
    } catch {
      setError('添加成员失败')
    } finally {
      setAddingMembers(false)
    }
  }

  const handleRemoveMember = async (member: ChannelMember) => {
    if (!activeChannel || member.role === 'owner' || removingMemberId) return
    setRemovingMemberId(member.user_id)
    try {
      const res = await api.delete(`/channels/${activeChannel.id}/members/${member.user_id}`)
      if (res.code !== 0) {
        setError(res.message || '移除成员失败')
        return
      }
      await Promise.all([loadChannelMembers(activeChannel.id), loadChannels(true)])
    } catch {
      setError('移除成员失败')
    } finally {
      setRemovingMemberId(null)
    }
  }

  const handleDeleteChannel = async () => {
    if (!activeChannel || !window.confirm(`确定删除频道“${activeChannel.name}”吗？频道消息也会一并删除。`)) return
    try {
      const res = await api.delete(`/channels/${activeChannel.id}`)
      if (res.code !== 0) {
        setError(res.message || '删除频道失败')
        return
      }
      setIsManageOpen(false)
      setActiveChannelId(null)
      await loadChannels(true)
    } catch {
      setError('删除频道失败')
    }
  }

  const handleSaveImage = async (message: ChannelMessage, directoryId = previewDirectoryId) => {
    if (savingImage || !message.attachment_id) return
    setSavingImage(true)
    try {
      const res = await api.post(`/channels/${message.channel_id}/messages/${message.id}/save-image`, {
        gallery_directory_id: directoryId ? Number(directoryId) : undefined,
      })
      if (res.code !== 0) {
        setError(res.message || '保存图片失败')
        return
      }
      setSavedImageIds((current) => current.includes(message.id) ? current : [...current, message.id])
      setNotice('图片已保存到图库')
      await loadDirectories()
    } catch {
      setError('保存图片失败')
    } finally {
      setSavingImage(false)
    }
  }

  const openHistorySearch = (channelId?: number) => {
    const nextChannelId = channelId ? String(channelId) : ''
    if (nextChannelId !== historyChannelId) {
      setHistoryResults([])
      setHistoryTotal(0)
    }
    setHistoryChannelId(nextChannelId)
    setHistorySearchOpen(true)
    void loadShareableUsers()
  }

  const runHistorySearch = async (channelOverride?: string) => {
    if (searchingHistory) return
    setSearchingHistory(true)
    setError('')
    try {
      const params = new URLSearchParams({
        match: historyMatchMode,
        type: historyMessageType,
        page: '1',
        size: '100',
      })
      const keyword = historyKeyword.trim()
      const scopedChannelId = channelOverride === undefined ? historyChannelId : channelOverride
      if (keyword) params.set('q', keyword)
      if (scopedChannelId) params.set('channel_id', scopedChannelId)
      if (historySenderId) params.set('sender_id', historySenderId)
      if (historyFrom) params.set('from', new Date(historyFrom).toISOString())
      if (historyTo) params.set('to', new Date(historyTo).toISOString())

      const res = await api.get<PageData<ChannelMessageSearchResult>>(`/channels/search/messages?${params.toString()}`)
      if (res.code !== 0 || !res.data) {
        setHistoryResults([])
        setHistoryTotal(0)
        setError(res.message || '搜索历史消息失败')
        return
      }
      setHistoryResults(res.data.list || [])
      setHistoryTotal(res.data.total)
    } catch {
      setHistoryResults([])
      setHistoryTotal(0)
      setError('搜索历史消息失败')
    } finally {
      setSearchingHistory(false)
    }
  }

  const selectHistoryResult = (result: ChannelMessageSearchResult) => {
    setHighlightMessageId(result.id)
    setActiveChannelId(result.channel_id)
  }

  const updateSoundEnabled = (enabled: boolean) => {
    soundEnabledRef.current = enabled
    setSoundEnabled(enabled)
    if (currentUserId) localStorage.setItem(channelStorageKey(currentUserId, 'sound-enabled'), String(enabled))
    if (enabled) void playNotificationSound(true)
  }

  const markAllChannelsRead = async () => {
    const unreadChannelIds = channels.filter((channel) => channel.unread_count > 0).map((channel) => channel.id)
    if (unreadChannelIds.length === 0) return
    await Promise.all(unreadChannelIds.map((channelId) => markChannelRead(channelId)))
    await loadChannels(true)
  }

  const openGalleryImageRename = (image: GalleryImage, event?: ReactMouseEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setRenamingGalleryImage(image)
    setGalleryRenameValue(image.filename)
    setGalleryRenameError('')
  }

  const handleGalleryImageRename = async () => {
    if (!renamingGalleryImage || !galleryRenameValue.trim() || savingGalleryRename) return
    setSavingGalleryRename(true)
    setGalleryRenameError('')
    try {
      const res = await api.put<GalleryImage>(`/gallery/images/${renamingGalleryImage.id}/name`, {
        filename: galleryRenameValue.trim(),
      })
      if (res.code !== 0 || !res.data) {
        setGalleryRenameError(res.message || '重命名失败')
        return
      }
      const renamed = res.data
      setGalleryImages((current) => current.map((image) => image.id === renamed.id ? renamed : image))
      setPendingGalleryImage((current) => current?.id === renamed.id ? renamed : current)
      setMessages((current) => current.map((message) => message.attachment_id === renamed.id
        ? { ...message, attachment_filename: renamed.filename }
        : message))
      setHistoryResults((current) => current.map((message) => message.attachment_id === renamed.id
        ? { ...message, attachment_filename: renamed.filename }
        : message))
      setPreviewImageMessage((current) => current?.attachment_id === renamed.id
        ? { ...current, attachment_filename: renamed.filename }
        : current)
      setRenamingGalleryImage(null)
      setNotice('图片名称已更新')
    } catch {
      setGalleryRenameError('重命名失败')
    } finally {
      setSavingGalleryRename(false)
    }
  }

  const openMessageContextMenu = (event: ReactMouseEvent, message: ChannelMessage) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 430),
      kind: 'message',
      message,
    })
  }

  const openComposerContextMenu = (event: ReactMouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 170),
      kind: 'composer',
    })
  }

  const copyText = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(successMessage)
    } catch {
      setError('浏览器未允许复制到剪贴板')
    }
    setContextMenu(null)
  }

  const copyComposerSelection = async () => {
    const input = messageInputRef.current
    if (!input) return
    const start = input.selectionStart || 0
    const end = input.selectionEnd || 0
    const selected = messageText.slice(start, end) || messageText
    await copyText(selected, '文字已复制')
  }

  const pasteIntoComposer = async () => {
    const input = messageInputRef.current
    if (!input) return
    try {
      const clipboardText = await navigator.clipboard.readText()
      const start = input.selectionStart || messageText.length
      const end = input.selectionEnd || start
      const nextValue = `${messageText.slice(0, start)}${clipboardText}${messageText.slice(end)}`
      setMessageText(nextValue)
      window.requestAnimationFrame(() => {
        const caret = start + clipboardText.length
        input.focus()
        input.setSelectionRange(caret, caret)
      })
    } catch {
      setError('浏览器未允许读取剪贴板')
    }
    setContextMenu(null)
  }

  const selectAllComposerText = () => {
    messageInputRef.current?.focus()
    messageInputRef.current?.select()
    setContextMenu(null)
  }

  const handleImagePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, message: ChannelMessage) => {
    if (event.button !== 0 || event.pointerType !== 'mouse') return
    const startX = event.clientX
    const startY = event.clientY
    let dragged = false

    const resolveTargetChannelId = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-channel-drop-id]')
      const channelId = Number(target?.dataset.channelDropId || 0)
      return channelId > 0 && channelId !== message.channel_id ? channelId : null
    }

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      if (!dragged && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 8) return
      dragged = true
      moveEvent.preventDefault()
      setDraggingMessageId(message.id)
      setDropTargetChannelId(resolveTargetChannelId(moveEvent.clientX, moveEvent.clientY))
    }

    const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      if (!dragged) return

      suppressImageClickRef.current = true
      window.setTimeout(() => {
        suppressImageClickRef.current = false
      }, 0)
      const targetChannelId = resolveTargetChannelId(upEvent.clientX, upEvent.clientY)
      setDraggingMessageId(null)
      setDropTargetChannelId(null)
      if (!targetChannelId) return
      void forwardMessageToChannel(message, targetChannelId).then((success) => {
        if (success) setNotice('图片已拖动转发')
      })
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp, { once: true })
  }

  const handleMessagesScroll = () => {
    const viewport = messagesViewportRef.current
    if (!viewport) return
    shouldStickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120
    if (activeChannelId && currentUserId) {
      localStorage.setItem(
        channelStorageKey(currentUserId, `message-scroll:${activeChannelId}`),
        String(Math.max(0, Math.round(viewport.scrollTop)))
      )
    }
  }

  const handleChannelListScroll = () => {
    if (!channelListRef.current || !currentUserId || sidebarSearchMode !== 'channels') return
    localStorage.setItem(
      channelStorageKey(currentUserId, 'channel-list-scroll'),
      String(Math.max(0, Math.round(channelListRef.current.scrollTop)))
    )
  }

  return (
    <AuthGuard>
      <div className="h-[100dvh] overflow-hidden bg-slate-100 p-0 md:p-5">
        <div className="mx-auto flex h-full max-w-[1440px] flex-col overflow-hidden">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 md:border md:border-b-0">
            <a href="/" className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-900">
              <ArrowLeft className="h-4 w-4" />
              返回首页
            </a>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setNotificationSettingsOpen(true)} className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-sky-600" title="频道通知设置">
                {soundEnabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                {totalUnreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-4 text-white">{totalUnreadCount > 99 ? '99+' : totalUnreadCount}</span>
                )}
              </button>
              <button type="button" onClick={() => void Promise.all([loadChannels(), activeChannelId ? loadMessages(activeChannelId) : Promise.resolve()])} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900" title="刷新">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </header>

          {error && (
            <div className="flex items-center justify-between border-x border-t border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
              <span>{error}</span>
              <button type="button" onClick={() => setError('')} className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-rose-100" title="关闭提示">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {notice && (
            <div className="border-x border-t border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
              {notice}
            </div>
          )}

          <main className="flex min-h-0 flex-1 overflow-hidden border-x border-b border-slate-200 bg-white">
            <aside className={`${activeChannel ? 'hidden lg:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white lg:w-[320px]`}>
              <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">频道</div>
                  <div className="mt-0.5 text-xs text-slate-400">{channels.length} 个会话</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => { setIsAssistantPickerOpen(true); void loadAvailableAssistants() }} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700" title="打开 AI 机器人私聊">
                    <Bot className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setIsCreateOpen(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white transition hover:bg-slate-700" title="新建频道">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="border-b border-slate-100 p-3">
                <div className="mb-2 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-xs font-medium">
                  <button type="button" onClick={() => setSidebarSearchMode('channels')} className={`h-7 rounded-md transition ${sidebarSearchMode === 'channels' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>频道</button>
                  <button type="button" onClick={() => { setSidebarSearchMode('history'); setHistoryChannelId(''); setHistoryResults([]); setHistoryTotal(0); void loadShareableUsers() }} className={`h-7 rounded-md transition ${sidebarSearchMode === 'history' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>历史消息</button>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:bg-white focus-within:ring-1 focus-within:ring-sky-300">
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <input
                      value={sidebarSearchMode === 'channels' ? channelSearch : historyKeyword}
                      onChange={(event) => sidebarSearchMode === 'channels' ? setChannelSearch(event.target.value) : setHistoryKeyword(event.target.value)}
                      onKeyDown={(event) => { if (sidebarSearchMode === 'history' && event.key === 'Enter') void runHistorySearch('') }}
                      placeholder={sidebarSearchMode === 'channels' ? '搜索频道' : '搜索历史消息'}
                      className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400"
                    />
                  </label>
                  {sidebarSearchMode === 'history' && (
                    <button type="button" onClick={() => openHistorySearch()} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-sky-600" title="历史搜索筛选">
                      <SlidersHorizontal className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {sidebarSearchMode === 'history' && (
                  <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                    <span>{historyTotal ? `找到 ${historyTotal} 条消息` : '支持精确和正则匹配'}</span>
                    <button type="button" onClick={() => void runHistorySearch('')} disabled={searchingHistory} className="font-medium text-sky-600 disabled:text-slate-300">{searchingHistory ? '搜索中...' : '搜索'}</button>
                  </div>
                )}
              </div>

              <div ref={channelListRef} onScroll={handleChannelListScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                {sidebarSearchMode === 'history' ? (
                  searchingHistory ? (
                    <div className="p-4 text-sm text-slate-400">正在搜索历史消息...</div>
                  ) : historyResults.length === 0 ? (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
                      <Search className="h-6 w-6 text-slate-300" />
                      输入关键词搜索，或打开筛选设置按时间、账号和消息类型查询。
                    </div>
                  ) : historyResults.map((result) => (
                    <button key={`${result.channel_id}-${result.id}`} type="button" onClick={() => selectHistoryResult(result)} className={`flex w-full gap-3 border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50 ${highlightMessageId === result.id ? 'bg-sky-50' : ''}`}>
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-slate-500">
                        {isImageMessage(result) ? <img src={result.attachment_url} alt="" className="h-full w-full object-cover" /> : <MessageSquare className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">#{result.channel_name}</span>
                          <span className="shrink-0 text-[10px] text-slate-400">{formatChannelTime(result.created_at)}</span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{result.content || result.attachment_filename || result.linked_sheet_name || result.linked_workbook_name || '消息'}</div>
                        <div className="mt-1 truncate text-[10px] text-slate-400">{result.sender_name || `用户 #${result.sender_id}`}</div>
                      </div>
                    </button>
                  ))
                ) : loadingChannels ? (
                  <div className="p-4 text-sm text-slate-400">正在加载...</div>
                ) : filteredChannels.length === 0 ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
                    <MessageSquare className="h-6 w-6 text-slate-300" />
                    {channels.length === 0 ? '还没有频道，点击右上角新建。' : '没有匹配的频道。'}
                  </div>
                ) : filteredChannels.map((channel) => (
                  <div
                    key={channel.id}
                    data-channel-drop-id={channel.id}
                    draggable={channel.is_pinned && !channelSearch.trim()}
                    onDragStart={(event) => {
                      if (!channel.is_pinned || channelSearch.trim()) return
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('application/x-yaerp-pinned-channel', String(channel.id))
                      setDraggingPinnedChannelId(channel.id)
                    }}
                    onDragOver={(event) => {
                      if (!draggingPinnedChannelId || !channel.is_pinned) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(event) => {
                      if (!draggingPinnedChannelId || !channel.is_pinned) return
                      event.preventDefault()
                      event.stopPropagation()
                      void handlePinnedChannelDrop(channel.id)
                    }}
                    onDragEnd={() => setDraggingPinnedChannelId(null)}
                    className={`group/channel flex border-b border-slate-100 transition ${draggingPinnedChannelId === channel.id ? 'opacity-45' : ''} ${draggingPinnedChannelId && channel.is_pinned && draggingPinnedChannelId !== channel.id ? 'hover:bg-sky-50' : ''} ${dropTargetChannelId === channel.id ? 'bg-emerald-50 ring-2 ring-inset ring-emerald-300' : channel.id === activeChannelId ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                  >
                    {channel.is_pinned && !channelSearch.trim() && (
                      <div className="flex w-5 shrink-0 cursor-grab items-center justify-center text-slate-300 active:cursor-grabbing" title="拖动调整置顶顺序">
                        <GripVertical className="h-4 w-4" />
                      </div>
                    )}
                    <button type="button" onClick={() => setActiveChannelId(channel.id)} className="flex min-w-0 flex-1 gap-3 px-4 py-3 text-left">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg ${channel.id === activeChannelId ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                        {channel.avatar_url ? <img src={channel.avatar_url} alt="" className="h-full w-full object-cover" /> : channel.channel_type === 'ai_private' ? <Bot className="h-4 w-4" /> : <Hash className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {channel.is_pinned && <Pin className="h-3 w-3 shrink-0 text-sky-600" />}
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{channel.name}</span>
                          {channel.unread_count > 0 && <span className="shrink-0 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{channel.unread_count > 99 ? '99+' : channel.unread_count}</span>}
                          <span className="shrink-0 text-[11px] text-slate-400">{formatChannelTime(channel.updated_at)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                          <span className="min-w-0 flex-1 truncate">{channel.channel_type === 'ai_private' ? 'AI 机器人私聊' : (channel.description || `由 ${channel.owner_name || '成员'} 创建`)}</span>
                          <span className="shrink-0">{channel.channel_type === 'ai_private' ? '专属会话' : `${channel.member_count || 1} 人${channel.ai_assistant_count ? ` · ${channel.ai_assistant_count} 机器人` : ''}`}</span>
                        </div>
                      </div>
                    </button>
                    <button type="button" onClick={() => void handleTogglePin(channel)} disabled={pinningChannelId === channel.id} className="mr-2 self-center inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 opacity-100 transition hover:bg-white hover:text-sky-600 disabled:opacity-40 lg:opacity-0 lg:group-hover/channel:opacity-100" title={channel.is_pinned ? '取消置顶' : '置顶频道'}>
                      {channel.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            </aside>

            <section
              onDragEnter={handleExternalFileDragEnter}
              onDragOver={handleExternalFileDragOver}
              onDragLeave={handleExternalFileDragLeave}
              onDrop={handleExternalFileDrop}
              className={`${activeChannel ? 'flex' : 'hidden lg:flex'} relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-50`}
            >
              {isExternalFileDragging && activeChannel && (
                <div className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-sky-400 bg-sky-50/95 shadow-xl">
                  <div className="text-center">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-sky-600 text-white">
                      <FileUp className="h-6 w-6" />
                    </div>
                    <div className="mt-3 text-base font-semibold text-slate-900">松开鼠标添加到当前频道</div>
                    <div className="mt-1 max-w-sm px-6 text-sm text-slate-500">文件会进入消息附件区，确认内容后点击发送</div>
                  </div>
                </div>
              )}
              {activeChannel ? (
                <>
                  <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
                    <button type="button" onClick={() => setActiveChannelId(null)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden" title="返回频道列表">
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sky-600 text-white">
                      {activeChannel.avatar_url ? <img src={activeChannel.avatar_url} alt="" className="h-full w-full object-cover" /> : activeChannel.channel_type === 'ai_private' ? <Bot className="h-4 w-4" /> : <Hash className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-900">{activeChannel.name}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-400">{activeChannel.channel_type === 'ai_private' ? '专属 AI 机器人会话' : (activeChannel.description || `${messages.length} 条消息`)}</div>
                    </div>
                    <div className="hidden items-center gap-3 text-xs text-slate-400 sm:flex">
                      <span>{activeChannel.channel_type === 'ai_private' ? 'AI 私聊' : `${activeChannel.member_count || 1} 位成员`}</span>
                      <span>{messages.length} 条消息</span>
                    </div>
                    <button type="button" onClick={() => openHistorySearch(activeChannel.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-sky-600" title="搜索当前频道历史">
                      <Search className="h-4 w-4" />
                    </button>
                    {activeChannel.can_manage && activeChannel.channel_type !== 'ai_private' && (
                      <button type="button" onClick={openManageChannel} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-sky-600" title="管理频道">
                        <Settings className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div ref={messagesViewportRef} onScroll={handleMessagesScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [scrollbar-gutter:stable] md:px-8">
                    {loadingMessages ? (
                      <div className="text-center text-sm text-slate-400">正在加载消息...</div>
                    ) : messages.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-400">
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-slate-300 shadow-sm">
                          <MessageSquare className="h-5 w-5" />
                        </div>
                        发送第一条消息开始交流
                      </div>
                    ) : (
                      <div className="mx-auto max-w-4xl space-y-5">
                        {messages.map((message) => {
                          const isAI = message.sender_type === 'ai'
                          const isMine = !isAI && currentUserId === message.sender_id
                          const senderName = isAI ? (message.assistant_name || 'AI 助手') : (message.sender_name || `用户 #${message.sender_id}`)
                          if (message.recalled_at) {
                            return (
                              <div data-message-id={message.id} key={message.id} className={`flex justify-center ${highlightMessageId === message.id ? 'outline outline-2 outline-offset-4 outline-sky-300' : ''}`}>
                                <div className="inline-flex items-center gap-2 rounded-lg bg-slate-200/70 px-3 py-1.5 text-xs text-slate-500">
                                  <Undo2 className="h-3.5 w-3.5" />
                                  {isMine ? '你' : senderName}撤回了一条消息
                                  <span className="text-slate-400">{formatTime(message.recalled_at)}</span>
                                </div>
                              </div>
                            )
                          }
                          return (
                            <div data-message-id={message.id} key={message.id} onContextMenu={(event) => openMessageContextMenu(event, message)} className={`group flex items-start gap-3 rounded-lg transition ${isMine ? 'flex-row-reverse' : ''} ${highlightMessageId === message.id ? 'outline outline-2 outline-offset-4 outline-sky-300' : ''}`}>
                              <div className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-xs font-semibold ${isMine ? 'bg-sky-600 text-white' : isAI ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 shadow-sm'}`}>
                                {isAI ? <Bot className="h-4 w-4" /> : message.sender_avatar ? <img src={message.sender_avatar} alt="" className="h-full w-full object-cover" /> : initials(senderName)}
                              </div>
                              <div className={`flex min-w-0 max-w-[min(88%,680px)] flex-col sm:max-w-[min(78%,680px)] ${isMine ? 'items-end' : 'items-start'}`}>
                                <div className={`mb-1 flex items-center gap-2 text-[11px] text-slate-400 ${isMine ? 'flex-row-reverse' : ''}`}>
                                  <span className={`font-medium ${isAI ? 'text-emerald-700' : 'text-slate-500'}`}>{senderName}</span>
                                  {isAI && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">AI</span>}
                                  <span>{formatTime(message.created_at)}</span>
                                </div>
                                {message.forwarded_from_message_id && (
                                  <div className="mb-1 text-[11px] text-sky-600">转发的消息</div>
                                )}
                                <div className={`flex items-center gap-2 ${isMine ? 'flex-row-reverse' : ''}`}>
                                  <div className={`min-w-0 space-y-2 ${(message.content || message.reply_to_message_id) ? `rounded-lg px-3 py-2 ${isMine ? 'bg-sky-600 text-white' : isAI ? 'border border-emerald-200 bg-emerald-50/70 text-slate-800' : 'border border-slate-200 bg-white text-slate-800'}` : ''}`}>
                                    {message.reply_to_message_id && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setHighlightMessageId(message.reply_to_message_id || null)
                                          const target = document.querySelector<HTMLElement>(`[data-message-id="${message.reply_to_message_id}"]`)
                                          target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                                        }}
                                        className={`block w-full min-w-0 border-l-2 pl-2 text-left text-xs ${isMine ? 'border-white/55 text-sky-50' : 'border-sky-400 text-slate-500'}`}
                                      >
                                        <span className={`block truncate font-semibold ${isMine ? 'text-white' : 'text-sky-700'}`}>{message.reply_sender_name || '成员'}</span>
                                        <span className="mt-0.5 block max-w-md truncate">{message.reply_recalled_at ? '原消息已撤回' : (message.reply_content || message.reply_attachment_filename || '消息')}</span>
                                      </button>
                                    )}
                                    {message.content && (isAI
                                      ? <div className="text-sm"><AIMessageContent content={message.content} /></div>
                                      : <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</div>)}
                                  </div>
                                  <button type="button" onClick={() => startReply(message)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 opacity-60 transition hover:bg-white hover:text-sky-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100" title="回复消息">
                                    <Reply className="h-4 w-4" />
                                  </button>
                                  <button type="button" onClick={() => openForwardDialog(message)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 opacity-60 transition hover:bg-white hover:text-sky-600 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100" title="转发消息">
                                    <Share2 className="h-4 w-4" />
                                  </button>
                                </div>

                                {isImageMessage(message) && (
                                  <button
                                    type="button"
                                    onPointerDown={(event) => handleImagePointerDown(event, message)}
                                    onClick={() => { if (!suppressImageClickRef.current) setPreviewImageMessage(message) }}
                                    className={`relative mt-2 block max-w-full cursor-grab touch-pan-y overflow-hidden rounded-lg border border-slate-200 bg-white p-1 text-left shadow-sm transition active:cursor-grabbing ${draggingMessageId === message.id ? 'opacity-50' : 'hover:border-sky-300'}`}
                                    title="查看图片"
                                  >
                                    <img src={message.attachment_url} alt={message.attachment_filename || '频道图片'} className="max-h-72 max-w-full object-contain" />
                                    {savedImageIds.includes(message.id) && (
                                      <span className="absolute bottom-2 right-2 rounded-lg bg-emerald-600 px-2 py-1 text-[11px] text-white">已保存</span>
                                    )}
                                  </button>
                                )}

                                {message.attachment_url && !isImageMessage(message) && (
                                  <a href={message.attachment_url} target="_blank" rel="noreferrer" className="mt-2 flex max-w-sm items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left shadow-sm transition hover:border-sky-200">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                                      <FileText className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-semibold text-slate-800">{message.attachment_filename || '下载附件'}</div>
                                      <div className="mt-0.5 text-xs text-slate-400">{message.attachment_size ? formatFileSize(message.attachment_size) : '文件附件'}</div>
                                    </div>
                                    <ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
                                  </a>
                                )}

                                {message.linked_workbook_id && (
                                  <a href={`/sheets/${message.linked_workbook_id}${message.linked_sheet_id ? `/${message.linked_sheet_id}` : ''}`} className="mt-2 flex w-full max-w-sm items-center gap-3 rounded-lg border border-sky-100 bg-white px-3 py-3 text-left shadow-sm transition hover:border-sky-300">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                                      <Table2 className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-semibold text-slate-900">{message.linked_sheet_name || message.linked_workbook_name || '共享表格'}</div>
                                      <div className="mt-1 truncate text-xs text-slate-500">
                                        {message.linked_sheet_name ? `${message.linked_workbook_name || '工作簿'} / 工作表` : '整个工作簿'}
                                      </div>
                                    </div>
                                    <ArrowRight className="h-4 w-4 shrink-0 text-sky-500" />
                                  </a>
                                )}
                                {message.linked_summary_id && (
                                  <a href={`/ai/summaries?selected=${message.linked_summary_id}`} className="mt-2 flex w-full max-w-sm items-center gap-3 rounded-lg border border-violet-100 bg-white px-3 py-3 text-left shadow-sm transition hover:border-violet-300">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><BarChart3 className="h-5 w-5" /></div>
                                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-900">{message.linked_summary_title || 'AI 数据总结'}</div><div className="mt-1 truncate text-xs text-slate-500">频道共享的 AI 总结页面</div></div>
                                    <ArrowRight className="h-4 w-4 shrink-0 text-violet-500" />
                                  </a>
                                )}
                              </div>
                            </div>
                          )
                        })}
                        <div ref={messagesEndRef} />
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 border-t border-slate-200 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:py-4">
                    <div className="mx-auto max-w-4xl overflow-hidden rounded-lg border border-slate-200 bg-white focus-within:border-sky-300 focus-within:ring-1 focus-within:ring-sky-100">
                      {selectedAskAssistantId && (
                        <div className="flex items-center gap-3 border-b border-emerald-100 bg-emerald-50 px-3 py-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"><Bot className="h-3.5 w-3.5" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold text-emerald-800">{askingAI ? channelAIProgress.label : `正在向 ${selectedAskAssistantName} 提问`}</div>
                            <div className="mt-0.5 truncate text-[11px] text-emerald-700/70">{askingAI ? `${selectedAskAssistantName} 已思考 ${aiThinkingElapsed} 秒，进度为估算值` : '回答支持 Markdown、表格、公式和工作表操作'}</div>
                            {askingAI && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-emerald-100"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700" style={{ width: `${channelAIProgress.progress}%` }} /></div>}
                          </div>
                          {activeChannel.channel_type !== 'ai_private' && (
                            <button type="button" onClick={() => setSelectedAskAssistantId(null)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-emerald-700 hover:bg-white" title="退出机器人提问"><X className="h-3.5 w-3.5" /></button>
                          )}
                        </div>
                      )}
                      {replyingToMessage && (
                        <div className="flex items-center gap-3 border-b border-sky-100 bg-sky-50 px-3 py-2">
                          <Reply className="h-4 w-4 shrink-0 text-sky-600" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-sky-800">回复 {replyingToMessage.sender_name || `用户 #${replyingToMessage.sender_id}`}</div>
                            <div className="mt-0.5 truncate text-xs text-slate-500">{messagePreview(replyingToMessage)}</div>
                          </div>
                          <button type="button" onClick={() => setReplyingToMessage(null)} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-white hover:text-slate-700" title="取消回复"><X className="h-3.5 w-3.5" /></button>
                        </div>
                      )}
                      {(pendingFile || pendingGalleryImage || pendingTable) && (
                        <div className="flex flex-wrap gap-2 border-b border-slate-100 bg-slate-50 p-2">
                          {pendingFile && (
                            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                              {pendingFilePreviewUrl ? (
                                <img src={pendingFilePreviewUrl} alt={pendingFile.name} className="h-9 w-9 rounded-lg object-cover" />
                              ) : (
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Paperclip className="h-4 w-4" /></div>
                              )}
                              <div className="min-w-0">
                                <div className="max-w-56 truncate text-xs font-semibold text-slate-700">{pendingFile.name}</div>
                                <div className="text-[11px] text-slate-400">{formatFileSize(pendingFile.size)}</div>
                              </div>
                              <button type="button" onClick={clearPendingFile} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="移除文件"><X className="h-3.5 w-3.5" /></button>
                            </div>
                          )}
                          {pendingGalleryImage && (
                            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-emerald-100 bg-white p-2">
                              <img src={pendingGalleryImage.url} alt={pendingGalleryImage.filename} className="h-9 w-9 rounded-lg bg-slate-100 object-cover" />
                              <div className="min-w-0">
                                <div className="max-w-56 truncate text-xs font-semibold text-slate-700">{pendingGalleryImage.filename}</div>
                                <div className="text-[11px] text-emerald-600">来自图库</div>
                              </div>
                              <button type="button" onClick={() => setPendingGalleryImage(null)} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="移除图库图片"><X className="h-3.5 w-3.5" /></button>
                            </div>
                          )}
                          {pendingTable && (
                            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-sky-100 bg-white p-2">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600"><Table2 className="h-4 w-4" /></div>
                              <div className="min-w-0">
                                <div className="max-w-56 truncate text-xs font-semibold text-slate-700">{pendingTable.sheet?.name || pendingTable.workbook.name}</div>
                                <div className="flex max-w-56 items-center gap-1 truncate text-[11px] text-slate-400">
                                  <span className="truncate">{pendingTable.sheet ? `${pendingTable.workbook.name} / 工作表` : '整个工作簿'}</span>
                                  {makePendingTablePublic && <span className="inline-flex shrink-0 items-center gap-1 text-emerald-600"><Globe2 className="h-3 w-3" />公共</span>}
                                </div>
                              </div>
                              <button type="button" onClick={() => { setPendingTable(null); setMakePendingTablePublic(false) }} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="移除表格"><X className="h-3.5 w-3.5" /></button>
                            </div>
                          )}
                        </div>
                      )}

                      <textarea ref={messageInputRef} value={messageText} onChange={(event) => setMessageText(event.target.value)} onKeyDown={handleComposerKeyDown} onContextMenu={openComposerContextMenu} placeholder={selectedAskAssistantId ? `向 ${selectedAskAssistantName} 提问...` : replyingToMessage ? `回复 ${replyingToMessage.sender_name || '成员'}...` : '输入消息...'} className="block min-h-20 w-full resize-none px-3 py-3 text-sm text-slate-800 outline-none placeholder:text-slate-400" />

                      <div className="flex min-h-11 items-end justify-between gap-2 border-t border-slate-100 px-2 py-1.5 sm:items-center sm:gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          {channelAIMembers.length > 0 && (
                            <label className={`mr-1 flex h-8 max-w-52 items-center gap-1.5 rounded-lg border px-2 text-xs ${selectedAskAssistantId ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500'}`} title="选择频道机器人">
                              <Bot className="h-3.5 w-3.5 shrink-0" />
                              <select value={selectedAskAssistantId || ''} onChange={(event) => handleAskAssistantSelection(event.target.value)} disabled={sending || activeChannel.channel_type === 'ai_private'} className="min-w-0 flex-1 bg-transparent outline-none disabled:opacity-100">
                                {activeChannel.channel_type !== 'ai_private' && <option value="">普通消息</option>}
                                {channelAIMembers.map((assistant) => <option key={assistant.assistant_id} value={assistant.assistant_id}>@{assistant.name}</option>)}
                              </select>
                            </label>
                          )}
                          <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => selectPendingFile(event.target.files?.[0] || null)} />
                          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending || Boolean(selectedAskAssistantId && !selectedAskAssistant?.supports_files && !selectedAskAssistant?.supports_vision)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40" title={selectedAskAssistantId ? '添加机器人可读取的图片或文件' : '发送文件'}>
                            <Paperclip className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => setIsTablePickerOpen(true)} disabled={sending || workbooks.length === 0} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-sky-600 disabled:opacity-40" title={selectedAskAssistantId ? '选择机器人需要读取的工作簿或工作表' : '发送工作簿或工作表'}>
                            <Table2 className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => { setGalleryPickerMode('message'); setIsGalleryPickerOpen(true) }} disabled={sending || Boolean(selectedAskAssistantId && !selectedAskAssistant?.supports_vision)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-emerald-600 disabled:opacity-40" title={selectedAskAssistantId ? '从图库选择机器人需要查看的图片' : '从图库选择图片'}>
                            <Images className="h-4 w-4" />
                          </button>
                          {pendingFile?.type.startsWith('image/') && (
                            <>
                              <button type="button" onClick={() => { setSavePendingImage((current) => !current); if (savePendingImage) setSelectedDirectoryId('') }} className={`ml-1 inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs transition ${savePendingImage ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`} title="是否保存到图库">
                                {savePendingImage ? <Check className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                                保存到图库
                              </button>
                              {savePendingImage && (
                                <select value={selectedDirectoryId} onChange={(event) => setSelectedDirectoryId(event.target.value)} className="h-8 min-w-0 max-w-44 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-500 outline-none focus:border-sky-300" title="图片保存目录">
                                  <option value="">频道默认目录</option>
                                  {availableDirectories.map((directory) => <option key={directory.id} value={directory.id}>{directory.name}</option>)}
                                </select>
                              )}
                            </>
                          )}
                        </div>
                        <button type="button" onClick={() => void sendMessage()} disabled={sending || (!messageText.trim() && !pendingFile && !pendingGalleryImage && !pendingTable)} className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white transition disabled:bg-slate-200 disabled:text-slate-400 ${selectedAskAssistantId ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-sky-600 hover:bg-sky-700'}`} title={askingAI ? 'AI 正在回答' : selectedAskAssistantId ? `发送给 ${selectedAskAssistantName}` : '发送'}>
                          {askingAI ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-400">
                  <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-white text-slate-300 shadow-sm"><MessageSquare className="h-6 w-6" /></div>
                  从左侧选择一个频道
                </div>
              )}
            </section>
          </main>
        </div>

        {historySearchOpen && (
          <section className="fixed inset-x-3 top-16 z-[55] flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl md:left-auto md:right-8 md:top-20 md:w-[460px]">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">搜索历史消息</div>
                <div className="mt-0.5 text-[11px] text-slate-400">关键词、时间、账号和消息类型可以组合筛选</div>
              </div>
              <button type="button" onClick={() => setHistorySearchOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">关键词</span>
                  <div className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 focus-within:border-sky-300">
                    <Search className="h-4 w-4 shrink-0 text-slate-400" />
                    <input autoFocus value={historyKeyword} onChange={(event) => setHistoryKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runHistorySearch() }} placeholder="消息文字、图片名、工作簿或工作表" className="min-w-0 flex-1 text-sm outline-none placeholder:text-slate-400" />
                  </div>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">匹配方式</span>
                    <select value={historyMatchMode} onChange={(event) => setHistoryMatchMode(event.target.value as HistoryMatchMode)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
                      <option value="contains">包含关键词</option>
                      <option value="exact">精确匹配</option>
                      <option value="regex">正则表达式</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">消息类型</span>
                    <select value={historyMessageType} onChange={(event) => setHistoryMessageType(event.target.value as HistoryMessageType)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
                      <option value="all">全部消息</option>
                      <option value="text">文本消息</option>
                      <option value="image">图片消息</option>
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">频道范围</span>
                    <select value={historyChannelId} onChange={(event) => setHistoryChannelId(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
                      <option value="">全部可访问频道</option>
                      {sortedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">发送账号</span>
                    <select value={historySenderId} onChange={(event) => setHistorySenderId(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
                      <option value="">全部账号</option>
                      {historyUsers.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">开始时间</span>
                    <input type="datetime-local" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-sky-300" />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-medium text-slate-600">结束时间</span>
                    <input type="datetime-local" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-sky-300" />
                  </label>
                </div>

                <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
                  <button type="button" onClick={() => { setHistoryKeyword(''); setHistoryMatchMode('contains'); setHistorySenderId(''); setHistoryMessageType('all'); setHistoryFrom(''); setHistoryTo('') }} className="h-9 rounded-lg px-3 text-sm text-slate-500 hover:bg-slate-100">重置条件</button>
                  <button type="button" onClick={() => void runHistorySearch()} disabled={searchingHistory} className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
                    <Search className="h-4 w-4" />
                    {searchingHistory ? '搜索中...' : '搜索'}
                  </button>
                </div>
              </div>

              <div className="pt-3">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                  <span>搜索结果</span>
                  <span>{historyTotal} 条</span>
                </div>
                {historyResults.length === 0 ? (
                  <div className="rounded-lg bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">设置条件后点击搜索</div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    {historyResults.map((result) => (
                      <button key={`panel-${result.channel_id}-${result.id}`} type="button" onClick={() => selectHistoryResult(result)} className="flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left last:border-b-0 hover:bg-slate-50">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-slate-500">
                          {isImageMessage(result) ? <img src={result.attachment_url} alt="" className="h-full w-full object-cover" /> : <MessageSquare className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[11px] text-slate-400">
                            <span className="min-w-0 flex-1 truncate font-medium text-slate-600">#{result.channel_name} · {result.sender_name || `用户 #${result.sender_id}`}</span>
                            <span className="shrink-0">{formatTime(result.created_at)}</span>
                          </div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-700">{result.content || result.attachment_filename || result.linked_sheet_name || result.linked_workbook_name || '消息'}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {notificationSettingsOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setNotificationSettingsOpen(false) }}>
            <div className="w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">频道通知设置</div>
                  <div className="mt-1 text-xs text-slate-400">管理未读消息和新消息提示音</div>
                </div>
                <button type="button" onClick={() => setNotificationSettingsOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>

              <div className="space-y-3 p-5">
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">当前未读消息</div>
                    <div className="mt-1 text-xs text-slate-400">来自你已加入频道的同事消息</div>
                  </div>
                  <div className="text-2xl font-semibold text-slate-900">{totalUnreadCount}</div>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Volume2 className="h-4 w-4 text-sky-600" />新消息提示音</div>
                    <div className="mt-1 text-xs leading-5 text-slate-400">关闭后仍显示未读数量，但不会播放声音。</div>
                  </div>
                  <button type="button" role="switch" aria-checked={soundEnabled} onClick={() => updateSoundEnabled(!soundEnabled)} className={`relative h-6 w-11 shrink-0 rounded-full transition ${soundEnabled ? 'bg-sky-600' : 'bg-slate-300'}`} title={soundEnabled ? '关闭提示音' : '开启提示音'}>
                    <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${soundEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <button type="button" onClick={() => void playNotificationSound(true)} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900">
                  <Volume2 className="h-4 w-4" />
                  播放测试音
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => void markAllChannelsRead()} disabled={totalUnreadCount === 0} className="h-9 rounded-lg px-3 text-sm text-sky-700 hover:bg-sky-50 disabled:text-slate-300 disabled:hover:bg-transparent">全部标记已读</button>
                <button type="button" onClick={() => setNotificationSettingsOpen(false)} className="h-9 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700">完成</button>
              </div>
            </div>
          </div>
        )}

        {isAssistantPickerOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsAssistantPickerOpen(false) }}>
            <div className="flex max-h-[78vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2 text-base font-semibold text-slate-900"><Bot className="h-4 w-4 text-emerald-600" />AI 机器人</div>
                  <div className="mt-1 text-xs text-slate-400">选择一个机器人打开专属私聊</div>
                </div>
                <button type="button" onClick={() => setIsAssistantPickerOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {loadingAssistants ? (
                  <div className="flex h-32 items-center justify-center gap-2 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" />正在加载机器人...</div>
                ) : availableAssistants.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 px-5 py-10 text-center">
                    <Bot className="mx-auto h-7 w-7 text-slate-300" />
                    <div className="mt-3 text-sm font-medium text-slate-600">暂无可用机器人</div>
                    <div className="mt-1 text-xs text-slate-400">管理员可在 AI 配置中启用助手</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {availableAssistants.map((assistant) => (
                      <button key={assistant.id} type="button" onClick={() => void handleOpenAIPrivateChannel(assistant)} disabled={openingAssistantId !== null} className="flex w-full items-center gap-3 rounded-lg border border-slate-200 px-3 py-3 text-left transition hover:border-emerald-200 hover:bg-emerald-50/60 disabled:opacity-50">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"><Bot className="h-4 w-4" /></div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">{assistant.name}</span>
                            {assistant.is_default && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">默认</span>}
                          </div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{assistant.description || `${assistant.model} 模型`}</div>
                        </div>
                        {openingAssistantId === assistant.id ? <RefreshCw className="h-4 w-4 animate-spin text-emerald-600" /> : <ArrowRight className="h-4 w-4 text-slate-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {isCreateOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsCreateOpen(false) }}>
            <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">新建频道</div>
                  <div className="mt-1 text-xs text-slate-400">频道创建后即可发送消息和表格</div>
                </div>
                <button type="button" onClick={() => setIsCreateOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="space-y-4 p-5">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">频道名称</span>
                  <input autoFocus value={newChannelName} onChange={(event) => setNewChannelName(event.target.value)} placeholder="例如：销售协作" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">频道说明</span>
                  <textarea value={newChannelDescription} onChange={(event) => setNewChannelDescription(event.target.value)} placeholder="选填" className="min-h-20 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-300" />
                </label>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => setIsCreateOpen(false)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                <button type="button" onClick={() => void handleCreateChannel()} disabled={creatingChannel || !newChannelName.trim()} className="h-9 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">创建</button>
              </div>
            </div>
          </div>
        )}

        {isTablePickerOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsTablePickerOpen(false) }}>
            <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">发送表格</div>
                  <div className="mt-1 text-xs text-slate-400">共 {workbooks.length} 个工作簿，可搜索并选择整个工作簿或其中一个工作表</div>
                </div>
                <button type="button" onClick={() => setIsTablePickerOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(220px,38vh)_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-none">
                <div className="flex min-h-0 flex-col border-b border-slate-200 md:border-b-0 md:border-r">
                  <div className="border-b border-slate-100 p-3">
                    <label className="flex h-9 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:ring-1 focus-within:ring-sky-300">
                      <Search className="h-4 w-4" />
                      <input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="搜索工作簿" className="min-w-0 flex-1 bg-transparent outline-none" />
                    </label>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                      <span>匹配 {filteredTableWorkbooks.length} 个</span>
                      <span>按最近更新排序</span>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                    {paginatedTableWorkbooks.map((workbook) => (
                      <button key={workbook.id} type="button" onClick={() => { setTablePickerWorkbookId(String(workbook.id)); setTablePickerSheetId(''); setMakePendingTablePublic(Boolean(workbook.is_public)) }} className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left ${String(workbook.id) === tablePickerWorkbookId ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                        <Table2 className={`h-4 w-4 shrink-0 ${String(workbook.id) === tablePickerWorkbookId ? 'text-sky-600' : 'text-slate-400'}`} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-700">{workbook.name}</div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-400">
                            <span className="min-w-0 flex-1 truncate">{workbook.owner_name || `用户 #${workbook.owner_id}`}</span>
                            <span className="shrink-0">{formatChannelTime(workbook.updated_at)}</span>
                          </div>
                        </div>
                        {String(workbook.id) === tablePickerWorkbookId && <Check className="h-4 w-4 shrink-0 text-sky-600" />}
                      </button>
                    ))}
                    {filteredTableWorkbooks.length === 0 && <div className="p-4 text-sm text-slate-400">没有匹配的工作簿</div>}
                  </div>
                  {totalTablePickerPages > 1 && (
                    <div className="flex h-11 shrink-0 items-center justify-between border-t border-slate-200 px-3 text-xs text-slate-500">
                      <span>{tablePickerPage} / {totalTablePickerPages} 页</span>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setTablePickerPage((page) => Math.max(1, page - 1))} disabled={tablePickerPage <= 1} className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:text-slate-300" title="上一页"><ChevronLeft className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setTablePickerPage((page) => Math.min(totalTablePickerPages, page + 1))} disabled={tablePickerPage >= totalTablePickerPages} className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:text-slate-300" title="下一页"><ChevronRight className="h-4 w-4" /></button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="min-h-0 overflow-y-auto p-3 [scrollbar-gutter:stable]">
                  {selectedPickerWorkbook ? (
                    <div className="space-y-1">
                      <button type="button" onClick={() => setTablePickerSheetId('')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left ${tablePickerSheetId === '' ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${tablePickerSheetId === '' ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}><Table2 className="h-4 w-4" /></div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800">{selectedPickerWorkbook.name}</div>
                          <div className="mt-0.5 text-xs text-slate-400">发送整个工作簿</div>
                        </div>
                        {tablePickerSheetId === '' && <Check className="h-4 w-4 text-sky-600" />}
                      </button>
                      <div className="flex items-center justify-between px-3 pb-1 pt-3 text-xs font-medium text-slate-400"><span>工作表</span><span>{tablePickerSheets.length} 个</span></div>
                      {loadingTableSheets ? (
                        <div className="px-3 py-4 text-sm text-slate-400">正在加载...</div>
                      ) : tablePickerSheets.length === 0 ? (
                        <div className="px-3 py-4 text-sm text-slate-400">这个工作簿还没有工作表</div>
                      ) : tablePickerSheets.map((sheet) => (
                        <button key={sheet.id} type="button" onClick={() => setTablePickerSheetId(String(sheet.id))} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${String(sheet.id) === tablePickerSheetId ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-500">S</div>
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{sheet.name}</span>
                          {String(sheet.id) === tablePickerSheetId && <Check className="h-4 w-4 text-sky-600" />}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-48 items-center justify-center text-sm text-slate-400">先选择一个工作簿</div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
                <div className="min-w-0">
                  <span className="block truncate text-xs text-slate-400">{selectedPickerWorkbook ? `已选择：${tablePickerSheetId ? tablePickerSheets.find((sheet) => String(sheet.id) === tablePickerSheetId)?.name || selectedPickerWorkbook.name : selectedPickerWorkbook.name}` : '尚未选择工作簿'}</span>
                  {selectedPickerWorkbook && canPublishSelectedPickerWorkbook && (
                    <button type="button" onClick={() => setMakePendingTablePublic((current) => !current)} className={`mt-2 inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition ${makePendingTablePublic ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                      <Globe2 className="h-3.5 w-3.5" />
                      {makePendingTablePublic ? '发送时设为公共表' : '仅按现有权限发送'}
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => setIsTablePickerOpen(false)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                  <button type="button" onClick={confirmTableSelection} disabled={!selectedPickerWorkbook} className="h-9 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">添加到消息</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isGalleryPickerOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/35 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsGalleryPickerOpen(false) }}>
            <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">{galleryPickerMode === 'channel-avatar' ? '选择频道头像' : '从图库选择图片'}</div>
                  <div className="mt-1 text-xs text-slate-400">{galleryPickerMode === 'channel-avatar' ? '仅显示你当前有权查看的图库图片' : '选择已经保存到图库的图片作为消息发送'}</div>
                </div>
                <button type="button" onClick={() => setIsGalleryPickerOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>

              <div className="border-b border-slate-100 p-3">
                <label className="flex h-9 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:ring-1 focus-within:ring-emerald-300">
                  <Search className="h-4 w-4" />
                  <input value={galleryImageSearch} onChange={(event) => setGalleryImageSearch(event.target.value)} placeholder="搜索图片名称" className="min-w-0 flex-1 bg-transparent outline-none" />
                </label>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
                {loadingGalleryImages ? (
                  <div className="flex h-52 items-center justify-center text-sm text-slate-400">正在加载图库...</div>
                ) : filteredGalleryImages.length === 0 ? (
                  <div className="flex h-52 flex-col items-center justify-center gap-2 text-sm text-slate-400">
                    <Images className="h-7 w-7 text-slate-300" />
                    图库中没有匹配的图片
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {filteredGalleryImages.map((image) => {
                      const selected = String(image.id) === selectedGalleryImageId
                      return (
                        <div key={image.id} className={`group relative overflow-hidden rounded-lg border bg-slate-50 text-left transition ${selected ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-slate-200 hover:border-emerald-300'}`}>
                          <button type="button" onClick={() => setSelectedGalleryImageId(String(image.id))} className="block w-full text-left">
                            <div className="aspect-square overflow-hidden bg-slate-100">
                              <img src={image.url} alt={image.filename} className="h-full w-full object-cover transition group-hover:scale-105" />
                            </div>
                            <div className="px-2 py-2 pr-9">
                              <div className="truncate text-xs font-semibold text-slate-700">{image.filename}</div>
                              <div className="mt-0.5 truncate text-[11px] text-slate-400">{image.uploader_name || `用户 #${image.uploader_id}`} · {formatFileSize(image.size)}</div>
                            </div>
                          </button>
                          <button type="button" onClick={(event) => openGalleryImageRename(image, event)} className="absolute bottom-1.5 right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white/95 text-slate-500 shadow-sm transition hover:text-emerald-600" title="重命名图片">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-600 text-white"><Check className="h-4 w-4" /></span>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
                <span className="text-xs text-slate-400">共 {galleryImages.length} 张已保存图片</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setIsGalleryPickerOpen(false)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                  <button type="button" onClick={() => void confirmGallerySelection()} disabled={!selectedGalleryImageId} className="h-9 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">{galleryPickerMode === 'channel-avatar' ? '设为频道头像' : '添加到消息'}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {renamingGalleryImage && (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setRenamingGalleryImage(null) }}>
            <div className="w-full max-w-md rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">重命名图片</div>
                  <div className="mt-1 text-xs text-slate-400">修改后图库和频道消息中的名称会同步更新</div>
                </div>
                <button type="button" onClick={() => setRenamingGalleryImage(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-5">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">图片名称</span>
                  <input autoFocus value={galleryRenameValue} onChange={(event) => setGalleryRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleGalleryImageRename() }} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300" />
                </label>
                <div className="mt-2 text-xs text-slate-400">不填写扩展名时会保留原图片扩展名。</div>
                {galleryRenameError && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{galleryRenameError}</div>}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => setRenamingGalleryImage(null)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                <button type="button" onClick={() => void handleGalleryImageRename()} disabled={savingGalleryRename || !galleryRenameValue.trim()} className="h-9 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{savingGalleryRename ? '保存中...' : '保存名称'}</button>
              </div>
            </div>
          </div>
        )}

        {forwardingMessage && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setForwardingMessage(null) }}>
            <div className="flex max-h-[72vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">转发消息</div>
                  <div className="mt-1 text-xs text-slate-400">选择接收频道</div>
                </div>
                <button type="button" onClick={() => setForwardingMessage(null)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>
              <div className="border-b border-slate-100 p-3">
                <label className="flex h-9 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:ring-1 focus-within:ring-sky-300">
                  <Search className="h-4 w-4" />
                  <input autoFocus value={forwardSearch} onChange={(event) => setForwardSearch(event.target.value)} placeholder="搜索频道" className="min-w-0 flex-1 bg-transparent outline-none" />
                </label>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {filteredForwardChannels.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">没有可转发的频道</div>
                ) : filteredForwardChannels.map((channel) => (
                  <button key={channel.id} type="button" onClick={() => setForwardTargetChannelId(String(channel.id))} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${String(channel.id) === forwardTargetChannelId ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                    <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${String(channel.id) === forwardTargetChannelId ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}><Hash className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">{channel.name}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-400">{channel.description || '频道会话'}</div>
                    </div>
                    {String(channel.id) === forwardTargetChannelId && <Check className="h-4 w-4 text-sky-600" />}
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => setForwardingMessage(null)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
                <button type="button" onClick={() => void handleForward()} disabled={!forwardTargetChannelId || forwarding} className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"><Share2 className="h-4 w-4" />转发</button>
              </div>
            </div>
          </div>
        )}

        {isManageOpen && activeChannel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsManageOpen(false) }}>
            <div className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">管理频道</div>
                  <div className="mt-1 text-xs text-slate-400">{activeChannel.member_count || channelMembers.length || 1} 位成员</div>
                </div>
                <button type="button" onClick={() => setIsManageOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <section className="border-b border-slate-200 p-5">
                  <div className="mb-3 text-sm font-semibold text-slate-800">频道信息</div>
                  <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-sky-600 text-white">
                      {activeChannel.avatar_url ? <img src={activeChannel.avatar_url} alt="" className="h-full w-full object-cover" /> : <Hash className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-slate-800">频道头像</div>
                      <div className="mt-1 text-xs text-slate-400">支持直接上传图片，或从当前可访问的图库中选择。</div>
                    </div>
                    <input ref={channelAvatarInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void handleChannelAvatarUpload(event.target.files?.[0] || null)} />
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => channelAvatarInputRef.current?.click()} disabled={uploadingChannelAvatar} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"><ImageIcon className="h-4 w-4" />{uploadingChannelAvatar ? '上传中' : '上传'}</button>
                      <button type="button" onClick={() => { setGalleryPickerMode('channel-avatar'); setIsGalleryPickerOpen(true) }} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50"><Images className="h-4 w-4" />图库选择</button>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                    <input value={manageChannelName} onChange={(event) => setManageChannelName(event.target.value)} placeholder="频道名称" className="h-10 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300" />
                    <input value={manageChannelDescription} onChange={(event) => setManageChannelDescription(event.target.value)} placeholder="频道说明" className="h-10 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300" />
                    <button type="button" onClick={() => void handleSaveChannelSettings()} disabled={savingChannel || !manageChannelName.trim()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
                      <Save className="h-4 w-4" />
                      保存
                    </button>
                  </div>
                </section>

                <section className="border-b border-slate-200 p-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Bot className="h-4 w-4 text-emerald-600" />频道机器人</div>
                    <span className="text-xs text-slate-400">已选择 {selectedChannelAssistantIds.length} 个</span>
                  </div>
                  <div className="mb-3 text-xs leading-5 text-slate-500">加入后，成员可以在输入区选择机器人，或右键消息通过 @机器人 继续提问。</div>
                  {loadingAssistants ? (
                    <div className="flex items-center gap-2 py-5 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" />正在加载机器人...</div>
                  ) : availableAssistants.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">暂无已启用的 AI 机器人</div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {availableAssistants.map((assistant) => {
                        const selected = selectedChannelAssistantIds.includes(assistant.id)
                        return (
                          <button key={assistant.id} type="button" onClick={() => toggleSelectedAssistant(assistant.id)} className={`flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}><Bot className="h-4 w-4" /></div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-slate-800">{assistant.name}</div>
                              <div className="mt-0.5 truncate text-xs text-slate-400">{assistant.description || assistant.model}</div>
                            </div>
                            <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white'}`}>{selected && <Check className="h-3.5 w-3.5" />}</div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <div className="mt-3 flex justify-end">
                    <button type="button" onClick={() => void handleSaveAIMembers()} disabled={savingAssistants || loadingAssistants} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                      {savingAssistants ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      保存机器人
                    </button>
                  </div>
                </section>

                <section className="border-b border-slate-200 p-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Users className="h-4 w-4 text-sky-600" />频道成员</div>
                    <span className="text-xs text-slate-400">{channelMembers.length} 人</span>
                  </div>
                  {loadingMembers ? (
                    <div className="py-6 text-sm text-slate-400">正在加载成员...</div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {channelMembers.map((member) => (
                        <div key={member.user_id} className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">{member.avatar ? <img src={member.avatar} alt="" className="h-full w-full object-cover" /> : initials(member.username)}</div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-slate-800">{member.username}</span>
                              {member.role === 'owner' && <span className="rounded-lg bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">创建者</span>}
                            </div>
                            <div className="truncate text-xs text-slate-400">{member.email}</div>
                          </div>
                          {member.role !== 'owner' && (
                            <button type="button" onClick={() => void handleRemoveMember(member)} disabled={removingMemberId === member.user_id} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40" title="移除成员"><X className="h-4 w-4" /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="p-5">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800"><UserPlus className="h-4 w-4 text-sky-600" />添加成员</div>
                  <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 focus-within:border-sky-300 focus-within:bg-white">
                    <Search className="h-4 w-4 shrink-0" />
                    <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="搜索员工姓名或邮箱" className="min-w-0 flex-1 bg-transparent outline-none" />
                  </label>
                  <div className="mt-3 max-h-60 overflow-y-auto rounded-lg border border-slate-200">
                    {filteredMemberCandidates.length === 0 ? (
                      <div className="p-6 text-center text-sm text-slate-400">没有可添加的员工</div>
                    ) : filteredMemberCandidates.map((user) => {
                      const selected = selectedMemberIds.includes(user.id)
                      return (
                        <button key={user.id} type="button" onClick={() => toggleSelectedMember(user.id)} className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 ${selected ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">{initials(user.username)}</div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-slate-800">{user.username}</div>
                            <div className="truncate text-xs text-slate-400">{user.email}</div>
                          </div>
                          <div className={`flex h-5 w-5 items-center justify-center rounded border ${selected ? 'border-sky-600 bg-sky-600 text-white' : 'border-slate-300 bg-white'}`}>
                            {selected && <Check className="h-3.5 w-3.5" />}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-400">已选择 {selectedMemberIds.length} 人</span>
                    <button type="button" onClick={() => void handleAddMembers()} disabled={addingMembers || selectedMemberIds.length === 0} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40">
                      <UserPlus className="h-4 w-4" />
                      添加已选
                    </button>
                  </div>
                </section>
              </div>

              <div className="flex items-center justify-between border-t border-slate-200 px-5 py-4">
                <button type="button" onClick={() => void handleDeleteChannel()} className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" />删除频道</button>
                <button type="button" onClick={() => setIsManageOpen(false)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">完成</button>
              </div>
            </div>
          </div>
        )}

        {previewImageMessage?.attachment_url && (
          <div className="fixed inset-0 z-[60] flex flex-col bg-slate-950/95" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewImageMessage(null) }}>
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-3 text-white md:px-5">
              <div className="min-w-0 truncate text-sm text-slate-300">{previewImageMessage.attachment_filename || '频道图片'}</div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setImageZoom((value) => Math.max(0.5, value - 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" title="缩小"><ZoomOut className="h-4 w-4" /></button>
                <button type="button" onClick={() => setImageZoom(1)} className="inline-flex h-9 min-w-12 items-center justify-center rounded-lg px-2 text-xs text-slate-300 hover:bg-white/10 hover:text-white" title="恢复原始缩放">{Math.round(imageZoom * 100)}%</button>
                <button type="button" onClick={() => setImageZoom((value) => Math.min(3, value + 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" title="放大"><ZoomIn className="h-4 w-4" /></button>
                <button type="button" onClick={() => setImageZoom(1)} className="hidden h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white sm:inline-flex" title="重置"><RotateCcw className="h-4 w-4" /></button>
                <a href={previewImageMessage.attachment_url} download={previewImageMessage.attachment_filename || 'channel-image'} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" title="下载图片"><Download className="h-4 w-4" /></a>
                <button type="button" onClick={() => setPreviewImageMessage(null)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" title="关闭"><X className="h-5 w-5" /></button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4" onWheel={(event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setImageZoom((value) => Math.min(3, Math.max(0.5, value + (event.deltaY < 0 ? 0.15 : -0.15)))) }}>
              <div className="flex min-h-full min-w-full items-center justify-center">
                <img src={previewImageMessage.attachment_url} alt={previewImageMessage.attachment_filename || '频道图片'} className="max-h-[calc(100vh-9rem)] max-w-[calc(100vw-2rem)] object-contain transition-transform duration-150" style={{ transform: `scale(${imageZoom})` }} />
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-slate-950 px-3 py-3">
              <select value={previewDirectoryId} onChange={(event) => setPreviewDirectoryId(event.target.value)} className="h-9 max-w-56 rounded-lg border border-white/15 bg-slate-900 px-3 text-sm text-slate-200 outline-none">
                <option value="">频道默认目录</option>
                {availableDirectories.map((directory) => <option key={directory.id} value={directory.id}>{directory.name}</option>)}
              </select>
              <button type="button" onClick={() => void handleSaveImage(previewImageMessage)} disabled={savingImage || savedImageIds.includes(previewImageMessage.id)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400">
                <Save className="h-4 w-4" />
                {savedImageIds.includes(previewImageMessage.id) ? '已保存到图库' : savingImage ? '保存中...' : '保存到图库'}
              </button>
            </div>
          </div>
        )}

        {contextMenu && (
          <div className="fixed z-[70] max-h-[70vh] w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            {contextMenu.kind === 'message' && contextMenu.message ? (
              <>
                {!contextMenu.message.recalled_at && (
                  <button type="button" onClick={() => { const message = contextMenu.message; if (message) startReply(message) }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><Reply className="h-4 w-4 text-slate-400" />回复消息</button>
                )}
                {!contextMenu.message.recalled_at && channelAIMembers.length > 0 && (
                  <div className="border-y border-slate-100 py-1">
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">@机器人提问</div>
                    {channelAIMembers.map((assistant) => (
                      <button key={assistant.assistant_id} type="button" onClick={() => { const message = contextMenu.message; selectAssistantForQuestion(assistant.assistant_id, message) }} className="flex min-h-9 w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-slate-700 hover:bg-emerald-50 hover:text-emerald-800">
                        <Bot className="h-4 w-4 shrink-0 text-emerald-600" />
                        <span className="min-w-0 flex-1 truncate">@{assistant.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!contextMenu.message.recalled_at && contextMenu.message.content && (
                  <button type="button" onClick={() => void copyText(contextMenu.message?.content || '', '消息文字已复制')} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />复制文字</button>
                )}
                {!contextMenu.message.recalled_at && isImageMessage(contextMenu.message) && (
                  <>
                    <button type="button" onClick={() => { setPreviewImageMessage(contextMenu.message || null); setContextMenu(null) }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><ImageIcon className="h-4 w-4 text-slate-400" />查看图片</button>
                    <button type="button" onClick={() => void copyText(contextMenu.message?.attachment_url || '', '图片地址已复制')} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />复制图片地址</button>
                    <button type="button" onClick={() => { const message = contextMenu.message; setContextMenu(null); if (message) void handleSaveImage(message, '') }} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><Save className="h-4 w-4 text-slate-400" />保存到图库</button>
                  </>
                )}
                {!contextMenu.message.recalled_at && (
                  <button type="button" onClick={() => { const message = contextMenu.message; setContextMenu(null); if (message) openForwardDialog(message) }} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><Share2 className="h-4 w-4 text-slate-400" />转发消息</button>
                )}
                {canRecallMessage(contextMenu.message, currentUserId) && (
                  <button type="button" onClick={() => { const message = contextMenu.message; if (message) void handleRecallMessage(message) }} disabled={recallingMessageId === contextMenu.message.id} className="flex h-9 w-full items-center gap-2.5 border-t border-slate-100 px-3 text-left text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Undo2 className="h-4 w-4" />撤回消息</button>
                )}
                {contextMenu.message.recalled_at && <div className="px-3 py-2 text-xs text-slate-400">该消息已撤回</div>}
              </>
            ) : (
              <>
                <button type="button" onClick={() => void copyComposerSelection()} disabled={!messageText} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-300"><Copy className="h-4 w-4" />复制</button>
                <button type="button" onClick={() => void pasteIntoComposer()} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><ClipboardPaste className="h-4 w-4" />粘贴</button>
                <button type="button" onClick={selectAllComposerText} disabled={!messageText} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-300"><Check className="h-4 w-4" />全选</button>
              </>
            )}
          </div>
        )}
      </div>
    </AuthGuard>
  )
}
