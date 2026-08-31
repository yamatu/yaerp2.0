'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LogOut, MessageCircle, RefreshCw, Save, Search, Server, Smartphone, Users, Wifi, WifiOff } from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { WhatsAppAccount, WhatsAppChat, WhatsAppSettings } from '@/types'

const defaultSettings: WhatsAppSettings = {
  enabled: false, auto_start: true, proxy_type: 'none', proxy_host: '', proxy_port: 0,
  proxy_username: '', proxy_password: '', proxy_password_configured: false,
}

function statusLabel(status: string) {
  switch (status) {
    case 'ready': return '已连接'
    case 'qr': return '等待扫码'
    case 'authenticated': return '正在登录'
    case 'initializing': return '正在启动'
    case 'loading': return '正在加载'
    case 'auth_failure': return '认证失败'
    case 'error': return '连接错误'
    default: return '未连接'
  }
}

export default function WhatsAppAdminPage() {
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings)
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [accountSearch, setAccountSearch] = useState('')
  const [chatSearch, setChatSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingChats, setLoadingChats] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const chatRequestSequenceRef = useRef(0)

  const loadAccounts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const response = await api.get<WhatsAppAccount[]>('/admin/whatsapp/accounts')
      const next = response.code === 0 && response.data ? response.data : []
      setAccounts(next)
      setSelectedUserId((current) => current && next.some((account) => account.user_id === current) ? current : next[0]?.user_id || null)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  const loadChats = useCallback(async (userId: number) => {
    const requestSequence = ++chatRequestSequenceRef.current
    setLoadingChats(true)
    try {
      const response = await api.get<WhatsAppChat[]>(`/admin/whatsapp/accounts/${userId}/chats`)
      if (requestSequence === chatRequestSequenceRef.current) setChats(response.code === 0 && response.data ? response.data : [])
    } catch {
      if (requestSequence === chatRequestSequenceRef.current) setChats([])
    } finally {
      if (requestSequence === chatRequestSequenceRef.current) setLoadingChats(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const response = await api.get<WhatsAppSettings>('/admin/whatsapp/settings')
      if (response.code === 0 && response.data) setSettings({ ...response.data, proxy_password: '' })
      await loadAccounts()
    })()
  }, [loadAccounts])

  const selectedAccount = accounts.find((account) => account.user_id === selectedUserId) || null

  useEffect(() => {
    if (!selectedAccount || selectedAccount.status !== 'ready') {
      chatRequestSequenceRef.current += 1
      setLoadingChats(false)
      setChats([])
      return
    }
    void loadChats(selectedAccount.user_id)
  }, [loadChats, selectedAccount?.status, selectedAccount?.user_id])

  useEffect(() => {
    const timer = window.setInterval(() => void loadAccounts(true), 3000)
    return () => window.clearInterval(timer)
  }, [loadAccounts])

  const filteredAccounts = useMemo(() => {
    const keyword = accountSearch.trim().toLowerCase()
    if (!keyword) return accounts
    return accounts.filter((account) => [account.username, account.email, account.display_name, account.phone_number].some((value) => value?.toLowerCase().includes(keyword)))
  }, [accountSearch, accounts])

  const filteredChats = useMemo(() => {
    const keyword = chatSearch.trim().toLowerCase()
    if (!keyword) return chats
    return chats.filter((chat) => [chat.name, chat.id, chat.lastMessage, chat.about, chat.description].some((value) => value?.toLowerCase().includes(keyword)))
  }, [chatSearch, chats])

  const saveSettings = async () => {
    setSaving(true); setError(''); setNotice('')
    try {
      const response = await api.put<WhatsAppSettings>('/admin/whatsapp/settings', settings)
      if (response.code !== 0 || !response.data) { setError(response.message || '保存配置失败'); return }
      setSettings({ ...response.data, proxy_password: '' })
      setNotice('系统代理配置已保存。正在运行的员工会话需要重启后使用新代理。')
    } catch { setError('保存配置失败') } finally { setSaving(false) }
  }

  const runAction = async (action: 'start' | 'restart' | 'logout') => {
    if (!selectedAccount) return
    setActing(action); setError(''); setNotice('')
    try {
      const response = await api.post(`/admin/whatsapp/accounts/${selectedAccount.user_id}/${action}`)
      if (response.code !== 0) { setError(response.message || '账号操作失败'); return }
      setNotice(`已对 ${selectedAccount.username} 的 WhatsApp 账号执行操作。`)
      window.setTimeout(() => void loadAccounts(true), 700)
    } catch { setError('账号操作失败') } finally { setActing('') }
  }

  return (
    <AdminShell title="WhatsApp 账号管理" description="统一配置系统代理，管理每位员工的独立 WhatsApp 登录">
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="grid min-h-[620px] xl:grid-cols-[330px_390px_minmax(0,1fr)]">
          <aside className="border-r border-slate-200 bg-[#f7f8fa]">
            <div className="border-b border-slate-200 p-3"><label className="flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-sm text-slate-500 shadow-sm"><Search className="h-4 w-4" /><input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="搜索员工或 WhatsApp 号码" className="min-w-0 flex-1 outline-none" /></label></div>
            <div className="max-h-[720px] overflow-y-auto">
              {loading ? <div className="flex h-40 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />加载员工账号...</div> : filteredAccounts.map((account) => (
                <button key={account.id} type="button" onClick={() => { setSelectedUserId(account.user_id); setChatSearch('') }} className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left ${selectedUserId === account.user_id ? 'bg-emerald-50' : 'bg-white hover:bg-slate-50'}`}>
                  <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-slate-500">{account.profile_pic_url ? <img src={account.profile_pic_url} alt="" className="h-full w-full object-cover" /> : <Smartphone className="h-5 w-5" />}<span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white ${account.status === 'ready' ? 'bg-[#25d366]' : 'bg-slate-400'}`} /></div>
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-900">{account.username}</div><div className="mt-0.5 truncate text-xs text-slate-500">{account.display_name || account.phone_number || account.email}</div></div>
                  <span className={`shrink-0 text-[10px] font-medium ${account.status === 'ready' ? 'text-emerald-700' : 'text-slate-400'}`}>{statusLabel(account.status)}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="border-r border-slate-200 bg-white p-5">
            {selectedAccount ? <>
              <div className="flex items-center gap-4"><div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-100 text-emerald-700">{selectedAccount.profile_pic_url ? <img src={selectedAccount.profile_pic_url} alt="" className="h-full w-full object-cover" /> : <Smartphone className="h-8 w-8" />}</div><div className="min-w-0"><div className="truncate text-lg font-semibold text-slate-900">{selectedAccount.display_name || selectedAccount.username}</div><div className="mt-1 truncate text-sm text-slate-500">员工：{selectedAccount.username}</div><div className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">{selectedAccount.status === 'ready' ? <Wifi className="h-3.5 w-3.5 text-emerald-600" /> : <WifiOff className="h-3.5 w-3.5" />}{statusLabel(selectedAccount.status)}</div></div></div>
              {selectedAccount.status === 'qr' && selectedAccount.qr_data_url && <div className="mt-5 rounded-lg border border-slate-200 p-3 text-center"><img src={selectedAccount.qr_data_url} alt="登录二维码" className="mx-auto w-full max-w-64" /><p className="mt-2 text-xs text-slate-500">管理员可以让员工扫码，也可以由员工进入自己的 WhatsApp 页面扫码。</p></div>}
              {(selectedAccount.status === 'loading' || selectedAccount.status === 'initializing') && <div className="mt-5"><div className="mb-2 flex justify-between text-xs text-slate-500"><span>{selectedAccount.loading_message || '正在加载'}</span><span>{selectedAccount.loading_percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-[#25d366]" style={{ width: `${selectedAccount.loading_percent}%` }} /></div></div>}
              <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => void runAction('start')} disabled={!settings.enabled || Boolean(acting) || !['disconnected', 'error', 'auth_failure'].includes(selectedAccount.status)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#008069] px-4 text-sm font-semibold text-white disabled:opacity-40"><Smartphone className="h-4 w-4" />启动/绑定</button><button type="button" onClick={() => void runAction('restart')} disabled={!settings.enabled || Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${acting === 'restart' ? 'animate-spin' : ''}`} />重启</button><button type="button" onClick={() => void runAction('logout')} disabled={Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600 disabled:opacity-40" title="强制停止会话并清除该员工的本地登录状态"><LogOut className="h-4 w-4" />退出/清除</button></div>
              <dl className="mt-6 space-y-3 border-t border-slate-200 pt-5 text-sm"><div><dt className="text-xs text-slate-400">WhatsApp 号码</dt><dd className="mt-1 font-medium text-slate-800">{selectedAccount.phone_number ? `+${selectedAccount.phone_number}` : '未读取'}</dd></div><div><dt className="text-xs text-slate-400">简介</dt><dd className="mt-1 leading-6 text-slate-700">{selectedAccount.about || '未设置简介'}</dd></div><div><dt className="text-xs text-slate-400">设备</dt><dd className="mt-1 text-slate-700">{selectedAccount.platform || 'WhatsApp Web'}</dd></div></dl>
            </> : <div className="flex h-full items-center justify-center text-sm text-slate-400">选择员工账号</div>}
          </section>

          <section className="flex min-h-0 flex-col bg-[#f7f8fa]">
            <div className="flex items-center gap-2 border-b border-slate-200 bg-white p-3"><label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg bg-slate-100 px-3 text-sm text-slate-500"><Search className="h-4 w-4" /><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="搜索该员工的联系人和群组" className="min-w-0 flex-1 bg-transparent outline-none" /></label><button type="button" onClick={() => selectedAccount && void loadChats(selectedAccount.user_id)} disabled={selectedAccount?.status !== 'ready' || loadingChats} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40" title="刷新该员工的 WhatsApp 会话"><RefreshCw className={`h-4 w-4 ${loadingChats ? 'animate-spin' : ''}`} /></button></div>
            <div className="min-h-0 flex-1 overflow-y-auto">{selectedAccount?.status !== 'ready' ? <div className="flex h-full min-h-72 flex-col items-center justify-center text-center text-sm text-slate-400"><MessageCircle className="mb-3 h-10 w-10 text-slate-300" />员工账号连接后显示 WhatsApp 会话</div> : loadingChats && chats.length === 0 ? <div className="flex h-full min-h-72 items-center justify-center text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在读取 WhatsApp 会话...</div> : filteredChats.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">没有匹配的会话</div> : filteredChats.map((chat) => <div key={chat.id} className="flex items-center gap-3 border-b border-slate-100 bg-white px-4 py-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-slate-500">{chat.profilePicUrl ? <img src={chat.profilePicUrl} alt="" className="h-full w-full object-cover" /> : chat.isGroup ? <Users className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-900">{chat.name}</div><div className="mt-1 truncate text-xs text-slate-500">{chat.lastMessage || chat.description || chat.about || chat.id}</div></div>{chat.unreadCount > 0 && <span className="rounded-full bg-[#25d366] px-2 py-0.5 text-[10px] font-semibold text-white">{chat.unreadCount}</span>}</div>)}</div>
          </section>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="flex items-center gap-2"><Server className="h-5 w-5 text-slate-500" /><h2 className="text-base font-semibold text-slate-900">系统代理配置</h2></div><p className="mt-1 text-sm text-slate-500">仅管理员可见。所有员工 WhatsApp 会话统一使用这里配置的代理。</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2"><div><div className="text-sm font-medium text-slate-800">启用 WhatsApp 服务</div><div className="mt-1 text-xs text-slate-400">关闭后员工不能启动新会话。</div></div><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-emerald-600" /></label><label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2"><div><div className="text-sm font-medium text-slate-800">系统启动时恢复员工会话</div><div className="mt-1 text-xs text-slate-400">只恢复员工自己启用自动连接的账号。</div></div><input type="checkbox" checked={settings.auto_start} onChange={(event) => setSettings((current) => ({ ...current, auto_start: event.target.checked }))} className="h-4 w-4 accent-emerald-600" /></label><label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理类型</span><select value={settings.proxy_type} onChange={(event) => setSettings((current) => ({ ...current, proxy_type: event.target.value as WhatsAppSettings['proxy_type'] }))} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="none">不使用代理</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label><label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理主机</span><input disabled={settings.proxy_type === 'none'} value={settings.proxy_host} onChange={(event) => setSettings((current) => ({ ...current, proxy_host: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50" /></label><label><span className="mb-1.5 block text-xs font-medium text-slate-600">端口</span><input type="number" disabled={settings.proxy_type === 'none'} value={settings.proxy_port || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_port: Number(event.target.value || 0) }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50" /></label><label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理账号</span><input disabled={settings.proxy_type === 'none'} value={settings.proxy_username} onChange={(event) => setSettings((current) => ({ ...current, proxy_username: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50" /></label><label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理密码</span><input type="password" disabled={settings.proxy_type === 'none'} value={settings.proxy_password || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_password: event.target.value }))} placeholder={settings.proxy_password_configured ? '已保存，留空不修改' : ''} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50" /></label></div>
        <div className="mt-4 flex items-center justify-end gap-3 border-t border-slate-100 pt-4"><button type="button" onClick={() => void saveSettings()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50"><Save className="h-4 w-4" />{saving ? '保存中...' : '保存系统配置'}</button></div>
        {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}{notice && <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      </section>
    </AdminShell>
  )
}
