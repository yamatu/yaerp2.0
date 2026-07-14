'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, LogOut, MessageCircle, RefreshCw, Save, Search, Smartphone, Users, Wifi, WifiOff } from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import type { WhatsAppAccount, WhatsAppChat } from '@/types'

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
  const accountRequestRef = useRef(false)
  const chatsRequestRef = useRef(false)
  const lastChatsLoadAtRef = useRef(0)

  const loadAccount = useCallback(async () => {
    if (accountRequestRef.current) return null
    accountRequestRef.current = true
    try {
      const response = await api.get<WhatsAppAccount>('/whatsapp/account')
      if (response.code === 0 && response.data) {
        setAccount(response.data)
        setAbout(response.data.about || '')
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
      setChats(response.code === 0 && response.data ? response.data : [])
      if (response.code === 0) lastChatsLoadAtRef.current = Date.now()
    } catch {
      setChats([])
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
      const current = await loadAccount()
      if (current?.status === 'ready' && Date.now() - lastChatsLoadAtRef.current >= 30000) {
        await loadChats()
      } else if (current && current.status !== 'ready') {
        setChats([])
        lastChatsLoadAtRef.current = 0
      }
    }, 3000)
    return () => window.clearInterval(timer)
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

  const filteredChats = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return chats
    return chats.filter((chat) => [chat.name, chat.about, chat.description, chat.lastMessage, chat.id].some((value) => value?.toLowerCase().includes(keyword)))
  }, [chats, search])

  const connected = account?.status === 'ready'
  const canStart = !account || ['disconnected', 'error', 'auth_failure'].includes(account.status)

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#efeae2]">
        <header className="border-b border-emerald-900/20 bg-[#075e54] text-white shadow-sm">
          <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-3 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Link href="/" className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10" title="返回工作台"><ArrowLeft className="h-4 w-4" /></Link>
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15"><MessageCircle className="h-5 w-5" /></div>
              <div className="min-w-0"><h1 className="truncate text-base font-semibold">我的 WhatsApp</h1><p className="truncate text-xs text-emerald-100">绑定账号并管理可用于频道的会话</p></div>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-black/15 px-3 py-1.5 text-xs font-medium">{connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{accountStatusLabel(account?.status)}</span>
          </div>
        </header>

        <main className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-[1440px] bg-white shadow-xl lg:grid-cols-[380px_minmax(0,1fr)]">
          <aside className="border-r border-slate-200 bg-white">
            {loading ? <div className="flex h-64 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载账号...</div> : (
              <div className="p-5">
                <div className="flex items-center gap-4">
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 text-emerald-700">
                    {account?.profile_pic_url ? <img src={account.profile_pic_url} alt="" className="h-full w-full object-cover" /> : <Smartphone className="h-8 w-8" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-lg font-semibold text-slate-900">{account?.display_name || account?.username || '尚未绑定'}</div>
                    <div className="mt-1 truncate text-sm text-slate-500">{account?.phone_number ? `+${account.phone_number}` : account?.email}</div>
                    {connected && <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />已连接 WhatsApp</div>}
                  </div>
                </div>

                {account?.status === 'qr' && account.qr_data_url && (
                  <div className="mt-5 rounded-lg border border-slate-200 bg-white p-3 text-center"><img src={account.qr_data_url} alt="WhatsApp 登录二维码" className="mx-auto w-full max-w-72" /><p className="mt-2 text-xs leading-5 text-slate-500">使用手机 WhatsApp 的“关联设备”扫描二维码。</p></div>
                )}
                {(account?.status === 'loading' || account?.status === 'initializing') && <div className="mt-5"><div className="mb-2 flex justify-between text-xs text-slate-500"><span>{account.loading_message || '正在加载 WhatsApp Web'}</span><span>{account.loading_percent || 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-[#25d366]" style={{ width: `${account.loading_percent || 0}%` }} /></div></div>}

                <div className="mt-5 flex flex-wrap gap-2">
                  {canStart && <button type="button" onClick={() => void runAction('start')} disabled={Boolean(acting)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-[#008069] px-4 text-sm font-semibold text-white hover:bg-[#006d59] disabled:opacity-50"><Smartphone className="h-4 w-4" />绑定账号</button>}
                  <button type="button" onClick={() => void runAction('restart')} disabled={Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${acting === 'restart' ? 'animate-spin' : ''}`} />重启</button>
                  <button type="button" onClick={() => void runAction('logout')} disabled={Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50" title="停止当前会话并清除本地 WhatsApp 登录状态"><LogOut className="h-4 w-4" />退出/清除</button>
                </div>

                <div className="mt-6 border-t border-slate-200 pt-5">
                  <label className="block text-xs font-semibold uppercase text-slate-500">WhatsApp 简介</label>
                  <textarea value={about} onChange={(event) => setAbout(event.target.value)} disabled={!connected} maxLength={139} className="mt-2 min-h-24 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-emerald-300 focus:bg-white disabled:opacity-60" placeholder="登录后可修改 WhatsApp 简介" />
                  <div className="mt-2 flex items-center justify-between"><span className="text-xs text-slate-400">{about.length}/139</span><button type="button" onClick={() => void saveAbout()} disabled={!connected || savingAbout} className="inline-flex h-8 items-center gap-2 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white disabled:opacity-40"><Save className="h-3.5 w-3.5" />保存简介</button></div>
                </div>
                {error && <div className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
                {notice && <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
              </div>
            )}
          </aside>

          <section className="flex min-h-0 flex-col bg-[#f7f8fa]">
            <div className="flex items-center gap-2 border-b border-slate-200 bg-white p-3 sm:p-4">
              <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500 focus-within:ring-1 focus-within:ring-emerald-300"><Search className="h-4 w-4" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 WhatsApp 联系人、群组或最近消息" className="min-w-0 flex-1 bg-transparent outline-none" /></label>
              <button type="button" onClick={() => void loadChats()} disabled={!connected || loadingChats} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新 WhatsApp 会话"><RefreshCw className={`h-4 w-4 ${loadingChats ? 'animate-spin' : ''}`} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!connected ? <div className="flex h-full min-h-96 flex-col items-center justify-center text-center text-slate-400"><div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><MessageCircle className="h-7 w-7" /></div><div className="mt-4 text-base font-semibold text-slate-700">绑定后显示 WhatsApp 会话</div><p className="mt-2 max-w-sm text-sm leading-6">员工只能管理自己的账号。系统代理由管理员统一配置，不会在这里显示。</p></div> : loadingChats && chats.length === 0 ? <div className="flex h-full min-h-72 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在读取 WhatsApp 会话...</div> : filteredChats.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">没有匹配的 WhatsApp 会话</div> : filteredChats.map((chat) => (
                <div key={chat.id} className="flex items-center gap-3 border-b border-slate-100 bg-white px-4 py-3 transition hover:bg-slate-50">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-slate-500">{chat.profilePicUrl ? <img src={chat.profilePicUrl} alt="" className="h-full w-full object-cover" /> : chat.isGroup ? <Users className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}</div>
                  <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><div className="truncate text-sm font-semibold text-slate-900">{chat.name}</div>{chat.timestamp > 0 && <span className="shrink-0 text-[11px] text-slate-400">{new Date(chat.timestamp * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>}</div><div className="mt-1 flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs text-slate-500">{chat.lastMessage || chat.description || chat.about || (chat.isGroup ? `${chat.participantCount} 位成员` : chat.id)}</span>{chat.unreadCount > 0 && <span className="rounded-full bg-[#25d366] px-2 py-0.5 text-[10px] font-semibold text-white">{chat.unreadCount}</span>}</div></div>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </AuthGuard>
  )
}
