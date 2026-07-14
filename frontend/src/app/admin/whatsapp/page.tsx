'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, LogOut, MessageCircle, Play, RefreshCw, Save, Server, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { WhatsAppChat, WhatsAppSettings, WhatsAppStatus } from '@/types'

const defaultSettings: WhatsAppSettings = {
  enabled: false,
  auto_start: true,
  proxy_type: 'none',
  proxy_host: '',
  proxy_port: 0,
  proxy_username: '',
  proxy_password: '',
  proxy_password_configured: false,
}

function statusText(status?: WhatsAppStatus['status']) {
  switch (status) {
    case 'ready': return '已连接'
    case 'qr': return '等待扫码'
    case 'authenticated': return '已扫码，正在登录'
    case 'initializing': return '正在启动'
    case 'loading': return '正在加载 WhatsApp Web'
    case 'disabled': return '未启用'
    case 'disconnected': return '已断开'
    case 'auth_failure': return '登录失败'
    case 'error': return '服务错误'
    default: return '服务不可用'
  }
}

export default function WhatsAppAdminPage() {
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings)
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadStatus = useCallback(async () => {
    const response = await api.get<WhatsAppStatus>('/admin/whatsapp/status')
    if (response.code === 0 && response.data) setStatus(response.data)
  }, [])

  const loadChats = useCallback(async () => {
    try {
      const response = await api.get<WhatsAppChat[]>('/whatsapp/chats')
      setChats(response.code === 0 && response.data ? response.data : [])
    } catch {
      setChats([])
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const [settingsResponse] = await Promise.all([
          api.get<WhatsAppSettings>('/admin/whatsapp/settings'),
          loadStatus(),
        ])
        if (settingsResponse.code === 0 && settingsResponse.data) setSettings({ ...defaultSettings, ...settingsResponse.data, proxy_password: '' })
      } catch {
        setError('加载 WhatsApp 配置失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [loadStatus])

  useEffect(() => {
    const timer = window.setInterval(() => void loadStatus(), 2500)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  useEffect(() => {
    if (status?.status === 'ready') void loadChats()
    else setChats([])
  }, [loadChats, status?.status])

  const connected = status?.status === 'ready'
  const proxyEnabled = settings.proxy_type !== 'none'
  const statusTone = connected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : status?.status === 'qr' ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-slate-200 bg-slate-50 text-slate-600'
  const accountName = status?.account?.pushname || status?.account?.wid || ''

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await api.put<WhatsAppSettings>('/admin/whatsapp/settings', settings)
      if (response.code !== 0 || !response.data) {
        setError(response.message || '保存配置失败')
        return
      }
      setSettings({ ...response.data, proxy_password: '' })
      setNotice('配置已保存。代理修改后请重启 WhatsApp 会话。')
    } catch {
      setError('保存配置失败')
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: 'start' | 'restart' | 'logout') => {
    setActing(action)
    setError('')
    setNotice('')
    try {
      const response = await api.post(`/admin/whatsapp/${action}`)
      if (response.code !== 0) {
        setError(response.message || '操作失败')
        return
      }
      setNotice(action === 'logout' ? '已退出 WhatsApp 登录。' : 'WhatsApp 会话正在启动，请稍候。')
      window.setTimeout(() => void loadStatus(), 800)
    } catch {
      setError('WhatsApp 服务操作失败')
    } finally {
      setActing('')
    }
  }

  const recentChats = useMemo(() => chats.slice(0, 12), [chats])

  return (
    <AdminShell title="WhatsApp 集成" description="管理二维码登录、系统代理和频道消息联动">
      {loading ? (
        <section className="flex min-h-64 items-center justify-center rounded-lg border border-slate-200 bg-white text-sm text-slate-400"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />正在加载配置...</section>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">服务状态</h2>
                  <p className="mt-1 text-sm text-slate-500">登录状态会持久化在独立 Docker 数据卷中。</p>
                </div>
                <span className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium ${statusTone}`}>{connected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}{statusText(status?.status)}</span>
              </div>

              {accountName && <div className="mt-4 flex items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50 p-3"><CheckCircle2 className="h-5 w-5 text-emerald-600" /><div><div className="text-sm font-semibold text-emerald-900">{accountName}</div><div className="mt-0.5 text-xs text-emerald-700">{status?.account?.platform || 'WhatsApp Web'}</div></div></div>}
              {status?.status === 'loading' && <div className="mt-4"><div className="mb-2 flex justify-between text-xs text-slate-500"><span>{status.loadingMessage || '正在加载'}</span><span>{status.loadingPercent || 0}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${status.loadingPercent || 0}%` }} /></div></div>}
              {status?.lastError && <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{status.lastError}</div>}

              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => void runAction('start')} disabled={!settings.enabled || Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"><Play className="h-4 w-4" />启动登录</button>
                <button type="button" onClick={() => void runAction('restart')} disabled={!settings.enabled || Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${acting === 'restart' ? 'animate-spin' : ''}`} />重启会话</button>
                <button type="button" onClick={() => void runAction('logout')} disabled={!connected || Boolean(acting)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-4 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40"><LogOut className="h-4 w-4" />退出登录</button>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex items-center gap-2"><Server className="h-5 w-5 text-slate-500" /><h2 className="text-base font-semibold text-slate-900">服务与代理</h2></div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2"><div><div className="text-sm font-medium text-slate-800">启用 WhatsApp</div><div className="mt-1 text-xs text-slate-400">关闭后停止会话，不再同步频道消息。</div></div><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-emerald-600" /></label>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 sm:col-span-2"><div><div className="text-sm font-medium text-slate-800">容器启动时自动连接</div><div className="mt-1 text-xs text-slate-400">已有登录态时无需重新扫码。</div></div><input type="checkbox" checked={settings.auto_start} onChange={(event) => setSettings((current) => ({ ...current, auto_start: event.target.checked }))} className="h-4 w-4 accent-emerald-600" /></label>
                <label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理类型</span><select value={settings.proxy_type} onChange={(event) => setSettings((current) => ({ ...current, proxy_type: event.target.value as WhatsAppSettings['proxy_type'] }))} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-300"><option value="none">不使用代理</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label>
                <label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理端口</span><input type="number" min={1} max={65535} disabled={!proxyEnabled} value={settings.proxy_port || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_port: Number(event.target.value || 0) }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300 disabled:bg-slate-50" placeholder="1080" /></label>
                <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-medium text-slate-600">代理主机</span><input disabled={!proxyEnabled} value={settings.proxy_host} onChange={(event) => setSettings((current) => ({ ...current, proxy_host: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300 disabled:bg-slate-50" placeholder="10.0.0.10 或 proxy.internal" /></label>
                <label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理账号</span><input disabled={!proxyEnabled} value={settings.proxy_username} onChange={(event) => setSettings((current) => ({ ...current, proxy_username: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300 disabled:bg-slate-50" /></label>
                <label><span className="mb-1.5 block text-xs font-medium text-slate-600">代理密码</span><input type="password" disabled={!proxyEnabled} value={settings.proxy_password || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_password: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300 disabled:bg-slate-50" placeholder={settings.proxy_password_configured ? '已保存，留空表示不修改' : ''} /></label>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4"><div className="text-xs text-slate-400">HTTP、HTTPS 和 SOCKS5 都会通过本地代理中转后交给 Chromium。</div><button type="button" onClick={() => void saveSettings()} disabled={saving} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"><Save className="h-4 w-4" />{saving ? '保存中...' : '保存配置'}</button></div>
              {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
              {notice && <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
            </section>
          </div>

          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-sky-600" /><h2 className="text-base font-semibold text-slate-900">扫码登录</h2></div>
              <div className="mt-4 flex min-h-80 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4">
                {status?.status === 'qr' && status.qrDataUrl ? <img src={status.qrDataUrl} alt="WhatsApp 登录二维码" className="h-auto w-full max-w-72 bg-white" /> : connected ? <div className="text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" /><div className="mt-3 text-sm font-semibold text-slate-800">WhatsApp 已连接</div><div className="mt-1 text-xs text-slate-400">无需重复扫码</div></div> : <div className="text-center text-sm text-slate-400"><MessageCircle className="mx-auto mb-3 h-10 w-10 text-slate-300" />启用配置并点击“启动登录”后显示二维码</div>}
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
              <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-slate-900">最近会话</h2><span className="text-xs text-slate-400">{chats.length} 个</span></div>
              <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
                {recentChats.length === 0 ? <div className="py-10 text-center text-sm text-slate-400">连接后显示联系人和群组</div> : recentChats.map((chat) => <div key={chat.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><MessageCircle className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-800">{chat.name}</div><div className="truncate text-xs text-slate-400">{chat.isGroup ? '群组' : '联系人'} · {chat.id}</div></div>{chat.unreadCount > 0 && <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">{chat.unreadCount}</span>}</div>)}
              </div>
            </section>
          </div>
        </div>
      )}
    </AdminShell>
  )
}
