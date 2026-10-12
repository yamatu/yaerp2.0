'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCheck, CheckCircle2, ChevronLeft, ChevronRight, Inbox, Link2, LogOut, MessageCircle, RefreshCw, Save, Search, Smartphone, UserRound, Users, Wifi, WifiOff } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import { WhatsAppAvatarImage } from '@/components/whatsapp/WhatsAppAvatarImage'
import { useHistoryLayer, useMediaQuery } from '@/hooks/useMobileGestures'
import api from '@/lib/api'
import type { WhatsAppAccount, WhatsAppChat, WhatsAppContactSyncResult } from '@/types'

function accountStatusLabel(status?: string) {
  switch (status) {
    case 'ready': return '已连接'
    case 'qr': return '等待扫码'
    case 'authenticated': return '正在登录'
    case 'initializing': return '正在启动'
    case 'loading': return '正在加载'
    case 'auth_failure': return '登录失败'
    case 'error': return '连接错误'
    default: return '未连接'
  }
}

function formatChatTime(timestamp: number) {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

// Below lg the account panel, the chat list and a chat are stacked screens.
const COMPACT_LAYOUT_QUERY = '(max-width: 1023px)'

export default function WhatsAppWorkspacePage() {
  const [account, setAccount] = useState<WhatsAppAccount | null>(null)
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingChats, setLoadingChats] = useState(false)
  const [acting, setActing] = useState('')
  const [about, setAbout] = useState('')
  const [savingAbout, setSavingAbout] = useState(false)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [markingReadChatId, setMarkingReadChatId] = useState('')
  const [markingAllRead, setMarkingAllRead] = useState(false)
  const [syncingContacts, setSyncingContacts] = useState(false)
  const [onlyUnread, setOnlyUnread] = useState(false)
  const accountRequestRef = useRef(false)
  const chatsRequestRef = useRef(false)
  const lastChatsLoadAtRef = useRef(0)
  const accountStatusRef = useRef('')
  const compactLayout = useMediaQuery(COMPACT_LAYOUT_QUERY)
  const [accountScreenOpen, setAccountScreenOpen] = useState(false)
  const [openChatId, setOpenChatId] = useState('')
  const closeAccountScreen = useCallback(() => setAccountScreenOpen(false), [])
  const closeChatScreen = useCallback(() => setOpenChatId(''), [])
  useHistoryLayer(compactLayout && accountScreenOpen, closeAccountScreen)
  useHistoryLayer(compactLayout && Boolean(openChatId), closeChatScreen)

  const loadAccount = useCallback(async () => {
    if (accountRequestRef.current) return null
    accountRequestRef.current = true
    try {
      const response = await api.get<WhatsAppAccount>('/whatsapp/account')
      if (response.code === 0 && response.data) {
        const previousStatus = accountStatusRef.current
        accountStatusRef.current = response.data.status
        setAccount(response.data)
        setAbout(response.data.about || '')
        if (response.data.status === 'ready' && previousStatus && previousStatus !== 'ready') {
          // Freshly scanned: load the conversation list right away instead of
          // waiting for the periodic refresh.
          setError('')
          setNotice('WhatsApp 已连接，正在同步会话...')
          lastChatsLoadAtRef.current = 0
        }
        return response.data
      }
      setError(response.message || '加载 WhatsApp 账号失败')
    } catch {
      setError('加载 WhatsApp 账号失败')
    } finally {
      accountRequestRef.current = false
    }
    return null
  }, [])

  const loadChats = useCallback(async () => {
    if (chatsRequestRef.current) return
    chatsRequestRef.current = true
    setLoadingChats(true)
    try {
      const response = await api.get<WhatsAppChat[]>('/whatsapp/chats')
      if (response.code !== 0) {
        setChats([])
        setError(response.message || '读取 WhatsApp 会话失败')
        return
      }
      setChats(response.data || [])
      setError('')
      lastChatsLoadAtRef.current = Date.now()
    } catch (requestError) {
      setChats([])
      setError(requestError instanceof Error ? requestError.message : '读取 WhatsApp 会话失败，请重新连接后重试')
    } finally {
      chatsRequestRef.current = false
      setLoadingChats(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const current = await loadAccount()
      if (current?.status === 'ready') await loadChats()
      setLoading(false)
    })()
  }, [loadAccount, loadChats])

  useEffect(() => {
    const timer = window.setInterval(async () => {
      // No point asking the WhatsApp sidecar for the status of a tab nobody is
      // looking at; the visibility listener below catches up immediately.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const current = await loadAccount()
      if (current?.status === 'ready' && Date.now() - lastChatsLoadAtRef.current >= 30000) {
        await loadChats()
      } else if (current && current.status !== 'ready') {
        setChats((existing) => (existing.length === 0 ? existing : []))
        lastChatsLoadAtRef.current = 0
      }
    }, 3000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadAccount()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadAccount, loadChats])

  const runAction = async (action: 'start' | 'restart' | 'logout') => {
    setActing(action)
    setError('')
    setNotice('')
    try {
      const response = await api.post(`/whatsapp/account/${action}`)
      if (response.code !== 0) {
        setError(response.message || 'WhatsApp 账号操作失败')
        return
      }
      setNotice(action === 'logout' ? '已退出 WhatsApp 登录。' : '会话正在启动，请稍候。')
      window.setTimeout(() => void loadAccount(), 700)
    } catch {
      setError('WhatsApp 账号操作失败')
    } finally {
      setActing('')
    }
  }

  const saveAbout = async () => {
    if (!account || account.status !== 'ready') return
    setSavingAbout(true)
    setError('')
    try {
      const response = await api.put<WhatsAppAccount>('/whatsapp/account/about', { about: about.trim() })
      if (response.code !== 0 || !response.data) {
        setError(response.message || '保存 WhatsApp 简介失败')
        return
      }
      setAccount(response.data)
      setNotice('WhatsApp 简介已更新。')
    } catch {
      setError('保存 WhatsApp 简介失败')
    } finally {
      setSavingAbout(false)
    }
  }

  const syncContactsToChannels = async () => {
    if (!connected || syncingContacts) return
    setSyncingContacts(true)
    setError('')
    setNotice('')
    try {
      const response = await api.post<WhatsAppContactSyncResult>('/whatsapp/contacts/sync-channels', { limit: 1000 })
      if (response.code !== 0 || !response.data) {
        setError(response.message || '同步 WhatsApp 联系人到频道失败')
        return
      }
      const failureText = response.data.failed > 0 ? `，${response.data.failed} 个失败` : ''
      setNotice(`已把 ${response.data.created} 个联系人同步为 ERP 频道，更新 / 跳过 ${response.data.skipped} 个${failureText}。可在「频道」中继续跟进。`)
    } catch {
      setError('同步 WhatsApp 联系人到频道失败')
    } finally {
      setSyncingContacts(false)
    }
  }

  const markChatRead = async (chat: WhatsAppChat) => {
    if (!connected || markingReadChatId) return
    setMarkingReadChatId(chat.id)
    setError('')
    try {
      const response = await api.post(`/whatsapp/chats/${encodeURIComponent(chat.id)}/read`)
      if (response.code !== 0) {
        setError(response.message || '标记 WhatsApp 会话已读失败')
        return
      }
      setChats((current) => current.map((item) => item.id === chat.id ? { ...item, unreadCount: 0 } : item))
      setNotice(`已将「${chat.name}」标记为已读`)
    } catch {
      setError('标记 WhatsApp 会话已读失败')
    } finally {
      setMarkingReadChatId('')
    }
  }

  const markAllChatsRead = async () => {
    const targets = chats.filter((chat) => chat.unreadCount > 0)
    if (targets.length === 0 || markingAllRead || !connected) return
    setMarkingAllRead(true)
    setError('')
    let done = 0
    let failed = 0
    for (const chat of targets) {
      try {
        const response = await api.post(`/whatsapp/chats/${encodeURIComponent(chat.id)}/read`)
        if (response.code === 0) {
          done += 1
          setChats((current) => current.map((item) => item.id === chat.id ? { ...item, unreadCount: 0 } : item))
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }
    setMarkingAllRead(false)
    if (failed > 0) {
      setError(`已将 ${done} 个会话标记为已读，${failed} 个失败，请稍后重试`)
      return
    }
    setNotice(`已将 ${done} 个会话标记为已读`)
  }

  const sortedChats = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return chats
      .filter((chat) => !onlyUnread || chat.unreadCount > 0)
      .filter((chat) => !keyword || [chat.name, chat.about, chat.description, chat.lastMessage, chat.id].some((value) => value?.toLowerCase().includes(keyword)))
      .sort((left, right) => {
        // Unread conversations first, then the most recent activity.
        const leftUnread = left.unreadCount > 0 ? 1 : 0
        const rightUnread = right.unreadCount > 0 ? 1 : 0
        return rightUnread - leftUnread || right.timestamp - left.timestamp
      })
  }, [chats, onlyUnread, search])

  const totalUnread = useMemo(
    () => chats.reduce((sum, chat) => sum + (chat.unreadCount > 0 ? chat.unreadCount : 0), 0),
    [chats],
  )

  const connected = account?.status === 'ready'
  const canStart = !account || ['disconnected', 'error', 'auth_failure'].includes(account.status)
  const openChat = chats.find((chat) => chat.id === openChatId) || null
  // Phones land on the chat list once WhatsApp is connected; until then the
  // account screen (QR code, status) is the first screen.
  const showAccountOnPhone = !loading && (!connected || accountScreenOpen)

  return (
    <AuthGuard>
      <div className="min-h-[calc(100dvh-var(--mobile-tabbar-offset))] bg-[#efeae2]">
        <header className="sticky top-0 z-20 border-b border-emerald-900/20 bg-[#075e54] pt-[env(safe-area-inset-top)] text-white shadow-sm lg:static">
          <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-2 px-2 sm:h-16 sm:px-5">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              {compactLayout && connected && accountScreenOpen ? (
                <button type="button" onClick={closeAccountScreen} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10" title="返回会话列表" aria-label="返回会话列表"><ChevronLeft className="h-5 w-5" /></button>
              ) : (
                <>
                  <Link href="/channels" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10 lg:hidden" title="返回频道" aria-label="返回频道"><ChevronLeft className="h-5 w-5" /></Link>
                  <Link href="/" className="hidden h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10 lg:inline-flex" title="返回工作台"><ArrowLeft className="h-4 w-4" /></Link>
                </>
              )}
              <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 sm:flex"><MessageCircle className="h-5 w-5" /></div>
              <div className="min-w-0"><h1 className="truncate text-base font-semibold">{compactLayout && connected && accountScreenOpen ? '账号与绑定' : '我的 WhatsApp'}</h1><p className="hidden truncate text-xs text-emerald-100 sm:block">绑定账号并管理可用于频道的会话</p></div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
              {totalUnread > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#25d366] px-2.5 py-1.5 text-xs font-semibold text-white sm:px-3" title="未读消息总数">
                  <Inbox className="h-3.5 w-3.5" />
                  {totalUnread}<span className="hidden sm:inline"> 条未读</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-black/15 px-2.5 py-1.5 text-xs font-medium sm:gap-2 sm:px-3">{connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{accountStatusLabel(account?.status)}</span>
              {connected && !accountScreenOpen && (
                <button type="button" onClick={() => setAccountScreenOpen(true)} className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-white/15 lg:hidden" title="账号与绑定" aria-label="账号与绑定">
                  <WhatsAppAvatarImage src={account?.profile_pic_url} fallback={<UserRound className="h-5 w-5" />} />
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto grid grid-cols-1 min-h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-var(--mobile-tabbar-offset))] max-w-[1440px] bg-white shadow-xl sm:min-h-[calc(100dvh-4rem-env(safe-area-inset-top)-var(--mobile-tabbar-offset))] lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[380px_minmax(0,1fr)]">
          <aside className={`${showAccountOnPhone || loading ? 'block' : 'hidden'} border-r border-slate-200 bg-white lg:block`}>
            {loading ? <div className="flex h-64 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载账号...</div> : (
              <div className="p-4 sm:p-5">
                <div className="flex items-center gap-4">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 text-emerald-700">
                    <WhatsAppAvatarImage src={account?.profile_pic_url} fallback={<Smartphone className="h-8 w-8" />} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-semibold text-slate-900">{account?.display_name || account?.username || '尚未绑定'}</div>
                    <div className="mt-1 truncate text-sm text-slate-500">{account?.phone_number ? `+${account.phone_number}` : account?.email}</div>
                    {connected && <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />已连接 WhatsApp</div>}
                  </div>
                </div>

                {account?.status === 'qr' && (
                  <div className="mt-5 rounded-lg border border-slate-200 bg-white p-3 text-center">
                    {account.qr_data_url ? (
                      <img src={account.qr_data_url} alt="WhatsApp 登录二维码" className="mx-auto w-full max-w-72" />
                    ) : (
                      <div className="flex h-72 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在生成登录二维码...</div>
                    )}
                    <p className="mt-2 text-xs leading-5 text-slate-500">二维码会自动更新，无需手动刷新。用手机 WhatsApp 的“关联设备”扫描即可。</p>
                    <ol className="mt-3 space-y-1 rounded-lg bg-slate-50 p-3 text-left text-xs leading-5 text-slate-500">
                      <li>1. 手机打开 WhatsApp，进入「设置 → 关联设备」</li>
                      <li>2. 点击「关联设备」，对准左侧二维码扫描</li>
                      <li>3. 扫码后保持本页打开，等待会话同步完成</li>
                    </ol>
                    {account.loading_message && <p className="mt-2 text-xs text-slate-400">{account.loading_message}</p>}
                  </div>
                )}
                {account?.status === 'authenticated' && (
                  <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs leading-5 text-emerald-800">
                    <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" />已扫码，请在手机上确认登录</div>
                    <p className="mt-1">确认后会自动同步已有的会话与消息，通常需要 1-2 分钟，请保持本页打开。</p>
                  </div>
                )}
                {(account?.status === 'loading' || account?.status === 'initializing' || (account?.status === 'authenticated' && (account.loading_percent || 0) > 0)) && <div className="mt-5"><div className="mb-2 flex justify-between text-xs text-slate-500"><span>{account.loading_message || '正在加载 WhatsApp Web'}</span><span>{account.loading_percent || 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-[#25d366]" style={{ width: `${account.loading_percent || 0}%` }} /></div></div>}

                {!connected && account?.last_error && (account.status === 'error' || account.status === 'auth_failure') && (
                  <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                    <div className="font-semibold">上次连接失败</div>
                    <p className="mt-1 break-words">{account.last_error}</p>
                    <p className="mt-1 text-rose-600/80">可点击下方「重启」重新生成登录二维码。</p>
                  </div>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  {canStart && <button type="button" onClick={() => void runAction('start')} disabled={Boolean(acting)} className="inline-flex h-11 flex-1 basis-full items-center justify-center gap-2 rounded-lg bg-[#008069] px-4 text-sm font-semibold text-white hover:bg-[#006d59] disabled:opacity-50 sm:h-9 sm:basis-auto"><Smartphone className="h-4 w-4" />绑定账号</button>}
                  <button type="button" onClick={() => void runAction('restart')} disabled={Boolean(acting)} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50 sm:h-9 sm:flex-none"><RefreshCw className={`h-4 w-4 ${acting === 'restart' ? 'animate-spin' : ''}`} />重启</button>
                  <button type="button" onClick={() => void runAction('logout')} disabled={Boolean(acting)} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50 sm:h-9 sm:flex-none" title="停止当前会话并清除本地 WhatsApp 登录状态"><LogOut className="h-4 w-4" />退出/清除</button>
                </div>

                <div className="mt-6 border-t border-slate-200 pt-5">
                  <label className="block text-xs font-semibold uppercase text-slate-500">WhatsApp 简介</label>
                  <textarea value={about} onChange={(event) => setAbout(event.target.value)} disabled={!connected} maxLength={139} className="mt-2 min-h-24 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-base outline-none sm:text-sm focus:border-emerald-300 focus:bg-white disabled:opacity-60" placeholder="登录后可修改 WhatsApp 简介" />
                  <div className="mt-2 flex items-center justify-between"><span className="text-xs text-slate-400">{about.length}/139</span><button type="button" onClick={() => void saveAbout()} disabled={!connected || savingAbout} className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-40 sm:h-8"><Save className="h-3.5 w-3.5" />保存简介</button></div>
                </div>
                <div className="mt-6 border-t border-slate-200 pt-5">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Link2 className="h-4 w-4 text-emerald-700" />与 ERP 联动</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">把 WhatsApp 联系人同步成 ERP 频道后，可以在频道里分配跟进、保存历史消息并再次发送。</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void syncContactsToChannels()} disabled={!connected || syncingContacts} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#008069] px-3 text-sm font-semibold text-white hover:bg-[#006d59] disabled:opacity-40 sm:h-9">
                      <RefreshCw className={`h-4 w-4 ${syncingContacts ? 'animate-spin' : ''}`} />同步联系人为频道
                    </button>
                    <Link href="/channels" className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 sm:h-9">
                      <MessageCircle className="h-4 w-4" />打开频道
                    </Link>
                  </div>
                </div>
                {error && <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
                {notice && <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
              </div>
            )}
          </aside>

          <section className={`${showAccountOnPhone || loading ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col bg-[#f7f8fa] lg:flex`}>
            {(error || notice) && (
              <div className="space-y-2 border-b border-slate-200 bg-white px-3 py-2 lg:hidden">
                {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
                {notice && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
              </div>
            )}
            <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 border-b border-slate-200 bg-white p-3 sm:top-[calc(4rem+env(safe-area-inset-top))] sm:p-4 lg:static">
              <div className="flex items-center gap-2">
                <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:ring-1 focus-within:ring-emerald-300"><Search className="h-4 w-4 shrink-0" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索联系人、群组或最近消息" className="min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm" /></label>
                <button type="button" onClick={() => void loadChats()} disabled={!connected || loadingChats} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新 WhatsApp 会话"><RefreshCw className={`h-4 w-4 ${loadingChats ? 'animate-spin' : ''}`} /></button>
              </div>
              {connected && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setOnlyUnread((current) => !current)}
                    className={`inline-flex h-10 items-center gap-1.5 rounded-full px-3 font-medium transition sm:h-8 ${onlyUnread ? 'bg-[#008069] text-white' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                    aria-pressed={onlyUnread}
                  >
                    <Inbox className="h-3.5 w-3.5" />仅看未读{totalUnread > 0 ? `（${totalUnread}）` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => void markAllChatsRead()}
                    disabled={totalUnread === 0 || markingAllRead}
                    className="inline-flex h-10 items-center gap-1.5 rounded-full border border-slate-200 px-3 font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 sm:h-8"
                    title="把所有未读会话标记为已读"
                  >
                    <CheckCheck className={`h-3.5 w-3.5 ${markingAllRead ? 'animate-pulse' : ''}`} />全部已读
                  </button>
                  <Link href="/channels" className="inline-flex h-10 items-center gap-1.5 rounded-full border border-slate-200 px-3 font-medium text-slate-600 transition hover:bg-slate-50 sm:h-8" title="在频道页面发送消息与使用模板">
                    <MessageCircle className="h-3.5 w-3.5" />去频道发送
                  </Link>
                  <span className="ml-auto text-slate-400">共 {sortedChats.length} 个会话</span>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!connected ? <div className="flex h-full min-h-96 flex-col items-center justify-center text-center text-slate-400"><div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><MessageCircle className="h-7 w-7" /></div><div className="mt-4 text-base font-semibold text-slate-700">绑定后显示 WhatsApp 会话</div><p className="mt-2 max-w-sm text-sm leading-6">员工只能管理自己的账号。系统代理由管理员统一配置，不会在这里显示。</p></div> : loadingChats && chats.length === 0 ? <div className="flex h-full min-h-72 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在读取 WhatsApp 会话...</div> : sortedChats.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">{onlyUnread ? '没有未读的 WhatsApp 会话' : '没有匹配的 WhatsApp 会话'}</div> : sortedChats.map((chat) => (
                <div key={chat.id} className="flex items-center gap-3 border-b border-slate-100 bg-white px-4 py-3 transition hover:bg-slate-50">
                  <button type="button" onClick={() => { if (compactLayout) setOpenChatId(chat.id) }} className="flex min-w-0 flex-1 items-center gap-3 text-left lg:cursor-default" aria-label={`查看 ${chat.name}`}>
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-slate-500"><WhatsAppAvatarImage src={chat.profilePicUrl} fallback={chat.isGroup ? <Users className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />} /></div>
                    <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><div className="truncate text-sm font-semibold text-slate-900">{chat.name}</div>{chat.timestamp > 0 && <span className={`shrink-0 text-[11px] ${chat.unreadCount > 0 ? 'font-semibold text-[#25d366]' : 'text-slate-400'}`}>{formatChatTime(chat.timestamp)}</span>}</div><div className="mt-1 flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs text-slate-500">{chat.lastMessage || chat.description || chat.about || (chat.isGroup ? `${chat.participantCount} 位成员` : chat.id)}</span>{chat.unreadCount > 0 && <span className="rounded-full bg-[#25d366] px-2 py-0.5 text-[10px] font-semibold text-white">{chat.unreadCount}</span>}</div></div>
                  </button>
                  {chat.unreadCount > 0 && <button type="button" onClick={() => void markChatRead(chat)} disabled={Boolean(markingReadChatId)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#008069] transition hover:bg-emerald-50 disabled:opacity-40 sm:h-9 sm:w-9" title="将这个 WhatsApp 会话标记为已读" aria-label="标记已读"><CheckCheck className={`h-4 w-4 ${markingReadChatId === chat.id ? 'animate-pulse' : ''}`} /></button>}
                  {chat.unreadCount === 0 && <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 lg:hidden" />}
                </div>
              ))}
            </div>
          </section>
        </main>

        {compactLayout && openChat && (
          // Phone "conversation" screen: chat details and quick actions. The
          // messages themselves are handled in linked ERP channels.
          <div className="fixed inset-x-0 top-0 bottom-[var(--mobile-tabbar-offset)] z-[55] flex flex-col bg-[#efeae2] lg:hidden" role="dialog" aria-label={openChat.name}>
            <div className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 bg-[#075e54] px-2 pt-[env(safe-area-inset-top)] text-white">
              <button type="button" onClick={closeChatScreen} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-white/10" title="返回会话列表" aria-label="返回会话列表"><ChevronLeft className="h-5 w-5" /></button>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/15"><WhatsAppAvatarImage src={openChat.profilePicUrl} fallback={openChat.isGroup ? <Users className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />} /></div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold">{openChat.name}</div>
                <div className="truncate text-xs text-emerald-100">{openChat.isGroup ? `群组 · ${openChat.participantCount} 位成员` : openChat.id.replace(/@.*$/, '')}</div>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
              <div className="flex flex-col items-center rounded-2xl bg-white px-4 py-6 text-center shadow-sm">
                <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-slate-500"><WhatsAppAvatarImage src={openChat.profilePicUrl} fallback={openChat.isGroup ? <Users className="h-9 w-9" /> : <MessageCircle className="h-9 w-9" />} /></div>
                <div className="mt-3 max-w-full break-words text-lg font-semibold text-slate-900">{openChat.name}</div>
                {(openChat.about || openChat.description) && <p className="mt-1 max-w-full break-words text-sm leading-6 text-slate-500">{openChat.about || openChat.description}</p>}
              </div>
              {openChat.lastMessage && (
                <div className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between text-xs text-slate-400"><span>最近消息</span><span>{formatChatTime(openChat.timestamp)}</span></div>
                  <div className="mt-2 max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tl-sm bg-[#f0f2f5] px-3 py-2 text-sm leading-6 text-slate-800">{openChat.lastMessage}</div>
                </div>
              )}
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
                <button type="button" onClick={() => void markChatRead(openChat)} disabled={openChat.unreadCount === 0 || Boolean(markingReadChatId)} className="flex h-14 w-full items-center gap-3 border-b border-slate-100 px-4 text-left text-sm text-slate-700 disabled:text-slate-300">
                  <CheckCheck className={`h-5 w-5 text-[#008069] ${markingReadChatId === openChat.id ? 'animate-pulse' : ''}`} />
                  <span className="flex-1">{openChat.unreadCount > 0 ? `标记已读（${openChat.unreadCount} 条未读）` : '没有未读消息'}</span>
                </button>
                <Link href="/channels" className="flex h-14 items-center gap-3 border-b border-slate-100 px-4 text-sm text-slate-700">
                  <MessageCircle className="h-5 w-5 text-[#008069]" />
                  <span className="flex-1">在频道中跟进与回复</span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </Link>
                <button type="button" onClick={() => void syncContactsToChannels()} disabled={!connected || syncingContacts} className="flex h-14 w-full items-center gap-3 px-4 text-left text-sm text-slate-700 disabled:opacity-40">
                  <RefreshCw className={`h-5 w-5 text-[#008069] ${syncingContacts ? 'animate-spin' : ''}`} />
                  <span className="flex-1">同步联系人为 ERP 频道</span>
                </button>
              </div>
              {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
              {notice && <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  )
}
