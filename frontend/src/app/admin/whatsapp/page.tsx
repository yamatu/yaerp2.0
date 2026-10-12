'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Hourglass, LogOut, MessageCircle, Power, RefreshCw, Save, Server, Smartphone, Users, Wifi, WifiOff } from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import { whatsappHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText, formatDateTime } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  DetailList,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  Modal,
  Notice,
  SearchInput,
  SectionCard,
  Segmented,
  SelectInput,
  StatGrid,
  StatusBadge,
  StickyActions,
  SwitchField,
  TextInput,
  type Tone,
} from '@/components/admin/ui'
import api from '@/lib/api'
import type { WhatsAppAccount, WhatsAppChat, WhatsAppSettings } from '@/types'

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

const PENDING = ['qr', 'authenticated', 'loading', 'initializing']
const ATTENTION = ['error', 'auth_failure']

function statusInfo(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'ready':
      return { label: '已连接', tone: 'emerald' }
    case 'qr':
      return { label: '等待扫码', tone: 'amber' }
    case 'authenticated':
      return { label: '正在登录', tone: 'sky' }
    case 'initializing':
      return { label: '正在启动', tone: 'sky' }
    case 'loading':
      return { label: '正在同步', tone: 'sky' }
    case 'auth_failure':
      return { label: '认证失败', tone: 'rose' }
    case 'error':
      return { label: '连接错误', tone: 'rose' }
    case 'disabled':
      return { label: '服务未启用', tone: 'slate' }
    case 'unavailable':
      return { label: '服务不可用', tone: 'rose' }
    default:
      return { label: '未连接', tone: 'slate' }
  }
}

const fingerprintOf = (settings: WhatsAppSettings) => JSON.stringify(settings)

function useIsDesktop() {
  const [desktop, setDesktop] = useState(true)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const update = () => setDesktop(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return desktop
}

export default function WhatsAppAdminPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const desktop = useIsDesktop()
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings)
  const [savedFingerprint, setSavedFingerprint] = useState(fingerprintOf(defaultSettings))
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [accountSearch, setAccountSearch] = useState('')
  const [chatSearch, setChatSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadingChats, setLoadingChats] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [acting, setActing] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'pending' | 'attention'>('all')
  const chatRequestSequenceRef = useRef(0)

  const loadAccounts = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const response = await api.get<WhatsAppAccount[]>('/admin/whatsapp/accounts')
      ensureOk(response, '加载 WhatsApp 账号失败')
      const next = response.data || []
      setAccounts(next)
      setLoadError('')
      setSelectedUserId((current) => (current && next.some((account) => account.user_id === current) ? current : next[0]?.user_id || null))
    } catch (error) {
      if (!silent) setLoadError(errorText(error, '加载 WhatsApp 账号失败'))
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
      try {
        const response = await api.get<WhatsAppSettings>('/admin/whatsapp/settings')
        if (response.code === 0 && response.data) {
          const next = { ...response.data, proxy_password: '' }
          setSettings(next)
          setSavedFingerprint(fingerprintOf(next))
        }
      } catch {
        // surfaced through the accounts request below
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadChats, selectedAccount?.status, selectedAccount?.user_id])

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Skip while hidden: the status request fans out to the sidecar for every account.
      if (document.visibilityState === 'hidden') return
      void loadAccounts(true)
    }, 3000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadAccounts(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadAccounts])

  const counts = useMemo(() => {
    const result = { ready: 0, pending: 0, attention: 0 }
    accounts.forEach((account) => {
      if (account.status === 'ready') result.ready += 1
      else if (PENDING.includes(account.status)) result.pending += 1
      else if (ATTENTION.includes(account.status)) result.attention += 1
    })
    return result
  }, [accounts])

  const filteredAccounts = useMemo(() => {
    const keyword = accountSearch.trim().toLowerCase()
    return accounts
      .filter((account) => {
        if (statusFilter === 'ready') return account.status === 'ready'
        if (statusFilter === 'pending') return PENDING.includes(account.status)
        if (statusFilter === 'attention') return ATTENTION.includes(account.status)
        return true
      })
      .filter((account) => !keyword || [account.username, account.email, account.display_name, account.phone_number].some((value) => value?.toLowerCase().includes(keyword)))
      .sort((left, right) => {
        const weight = (status: string) => (ATTENTION.includes(status) ? 0 : PENDING.includes(status) ? 1 : status === 'ready' ? 2 : 3)
        return weight(left.status) - weight(right.status) || left.username.localeCompare(right.username, 'zh-CN')
      })
  }, [accountSearch, accounts, statusFilter])

  const filteredChats = useMemo(() => {
    const keyword = chatSearch.trim().toLowerCase()
    if (!keyword) return chats
    return chats.filter((chat) => [chat.name, chat.id, chat.lastMessage, chat.about, chat.description].some((value) => value?.toLowerCase().includes(keyword)))
  }, [chatSearch, chats])

  const settingsDirty = fingerprintOf(settings) !== savedFingerprint

  const saveSettings = async () => {
    if (settings.proxy_type !== 'none' && (!settings.proxy_host.trim() || !settings.proxy_port)) {
      setSettingsError('请填写代理主机和端口')
      return
    }
    setSaving(true)
    setSettingsError('')
    try {
      const response = await api.put<WhatsAppSettings>('/admin/whatsapp/settings', settings)
      ensureOk(response, '保存配置失败')
      const next = { ...response.data!, proxy_password: '' }
      setSettings(next)
      setSavedFingerprint(fingerprintOf(next))
      toast.success(counts.ready + counts.pending > 0 ? '配置已保存。正在运行的会话需要“重启”后才会使用新代理。' : '配置已保存')
    } catch (error) {
      setSettingsError(errorText(error, '保存配置失败'))
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (action: 'start' | 'restart' | 'logout') => {
    if (!selectedAccount) return
    if (action === 'logout') {
      const ok = await confirm({
        title: `退出「${selectedAccount.username}」的 WhatsApp 登录？`,
        consequences: ['注销该员工的 WhatsApp Web 登录，并清除服务器上保存的会话', '该账号会被标记为停用，员工需要重新扫码才能使用', '员工手机上的 WhatsApp 和聊天记录不受影响'],
        confirmText: '退出并清除',
      })
      if (!ok) return
    }
    setActing(action)
    try {
      ensureOk(await api.post(`/admin/whatsapp/accounts/${selectedAccount.user_id}/${action}`), '账号操作失败')
      const labels = { start: '已提交启动，稍后会显示二维码或连接状态', restart: '已提交重启', logout: '已退出登录并清除会话' }
      toast.success(`${selectedAccount.username}：${labels[action]}`)
      window.setTimeout(() => void loadAccounts(true), 700)
    } catch (error) {
      toast.error(errorText(error, '账号操作失败'))
    } finally {
      setActing('')
    }
  }

  const selectAccount = (userId: number) => {
    setSelectedUserId(userId)
    setChatSearch('')
    if (!desktop) setMobileDetailOpen(true)
  }

  const detail = selectedAccount ? (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-50 text-emerald-700">
          {selectedAccount.profile_pic_url ? <img src={selectedAccount.profile_pic_url} alt="" className="h-full w-full object-cover" /> : <Smartphone className="h-6 w-6" />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-900">{selectedAccount.display_name || selectedAccount.username}</div>
          <div className="truncate text-xs text-slate-500">员工：{selectedAccount.username}</div>
          <div className="mt-1">
            <StatusBadge tone={statusInfo(selectedAccount.status).tone} dot>
              {selectedAccount.status === 'ready' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {statusInfo(selectedAccount.status).label}
            </StatusBadge>
          </div>
        </div>
      </div>

      {selectedAccount.status === 'qr' && selectedAccount.qr_data_url && (
        <div className="rounded-lg border border-slate-200 p-3 text-center">
          <img src={selectedAccount.qr_data_url} alt="WhatsApp 登录二维码" className="mx-auto w-full max-w-56" />
          <p className="mt-2 text-xs leading-5 text-slate-500">请员工在手机 WhatsApp 中打开“已关联设备 → 关联设备”扫描此二维码；员工也可以在自己的 WhatsApp 页面扫码。</p>
        </div>
      )}
      {(selectedAccount.status === 'loading' || selectedAccount.status === 'initializing') && (
        <div>
          <div className="mb-1.5 flex justify-between text-xs text-slate-500">
            <span>{selectedAccount.loading_message || '正在加载'}</span>
            <span>{selectedAccount.loading_percent || 0}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${selectedAccount.loading_percent || 0}%` }} />
          </div>
        </div>
      )}
      {selectedAccount.last_error && <Notice tone="danger">{selectedAccount.last_error}</Notice>}
      {!settings.enabled && <Notice tone="warning">WhatsApp 服务未启用，无法启动或重启会话。请在下方“系统设置”中开启并保存。</Notice>}

      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="success"
          icon={Power}
          loading={acting === 'start'}
          disabled={!settings.enabled || Boolean(acting) || !['disconnected', 'error', 'auth_failure', 'disabled', 'unavailable'].includes(selectedAccount.status)}
          title="用于未连接或出错的账号"
          onClick={() => void runAction('start')}
        >
          启动
        </Button>
        <Button icon={RefreshCw} loading={acting === 'restart'} disabled={!settings.enabled || Boolean(acting)} title="会话卡住或修改代理后使用，无需重新扫码" onClick={() => void runAction('restart')}>
          重启
        </Button>
        <Button variant="danger-outline" icon={LogOut} loading={acting === 'logout'} disabled={Boolean(acting)} title="注销登录并清除会话，需要重新扫码" onClick={() => void runAction('logout')}>
          退出
        </Button>
      </div>

      <DetailList
        items={[
          { label: 'WhatsApp 号码', value: selectedAccount.phone_number ? `+${selectedAccount.phone_number}` : '未读取' },
          { label: '简介', value: selectedAccount.about || '未设置' },
          { label: '设备', value: selectedAccount.platform || 'WhatsApp Web' },
          { label: '自动连接', value: selectedAccount.auto_start ? '是（服务器重启后自动恢复）' : '否' },
          { label: '最近连接', value: formatDateTime(selectedAccount.last_connected_at) },
        ]}
      />

      <div>
        <div className="mb-2 flex items-center gap-2">
          <SearchInput value={chatSearch} onChange={setChatSearch} placeholder="搜索联系人和群组" className="flex-1" />
          <IconButton icon={RefreshCw} label="刷新会话" spin={loadingChats} disabled={selectedAccount.status !== 'ready'} onClick={() => void loadChats(selectedAccount.user_id)} />
        </div>
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200">
          {selectedAccount.status !== 'ready' ? (
            <EmptyState compact icon={MessageCircle} title="账号连接后显示会话" />
          ) : loadingChats && chats.length === 0 ? (
            <LoadingState compact label="正在读取会话…" />
          ) : filteredChats.length === 0 ? (
            <EmptyState compact icon={MessageCircle} title="没有匹配的会话" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {filteredChats.map((chat) => (
                <li key={chat.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-slate-500">
                    {chat.profilePicUrl ? <img src={chat.profilePicUrl} alt="" className="h-full w-full object-cover" /> : chat.isGroup ? <Users className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{chat.name}</div>
                    <div className="truncate text-xs text-slate-500">{chat.lastMessage || chat.description || chat.about || chat.id}</div>
                  </div>
                  {chat.unreadCount > 0 && <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-white">{chat.unreadCount}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="mt-1.5 text-xs text-slate-400">会话列表为只读，管理员不能代发消息。</p>
      </div>
    </div>
  ) : null

  return (
    <AdminShell title="WhatsApp" description="服务开关、代理与员工 WhatsApp 登录状态" help={whatsappHelp} actions={<IconButton icon={RefreshCw} label="刷新账号状态" spin={loading} onClick={() => void loadAccounts()} />}>
      <StatGrid
        items={[
          { label: 'WhatsApp 服务', value: settings.enabled ? '已启用' : '未启用', icon: Power, tone: settings.enabled ? 'emerald' : 'amber' },
          { label: '已连接', value: counts.ready, icon: Wifi, tone: 'emerald' },
          { label: '登录中 / 等待扫码', value: counts.pending, icon: Hourglass, tone: counts.pending ? 'amber' : 'slate' },
          { label: '异常', value: counts.attention, icon: AlertCircle, tone: counts.attention ? 'rose' : 'slate' },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadAccounts()}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      <div className="grid gap-3 lg:grid-cols-[340px_minmax(0,1fr)]">
        <SectionCard title="员工账号" description="全部员工 · 状态每 3 秒自动刷新" icon={Smartphone} flush className="lg:self-start">
          <div className="space-y-2 border-b border-slate-200 p-3">
            <SearchInput value={accountSearch} onChange={setAccountSearch} placeholder="搜索员工或号码" />
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all', label: '全部', count: accounts.length },
                { value: 'ready', label: '已连接', count: counts.ready },
                { value: 'pending', label: '进行中', count: counts.pending },
                { value: 'attention', label: '异常', count: counts.attention },
              ]}
            />
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {loading && accounts.length === 0 ? (
              <LoadingState compact />
            ) : filteredAccounts.length === 0 ? (
              <EmptyState
                compact
                icon={Smartphone}
                title={accounts.length === 0 ? '还没有员工账号' : '没有符合条件的账号'}
                description={accounts.length === 0 ? '先在「员工账号」中创建员工。' : '试试切换筛选条件或清空搜索。'}
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {filteredAccounts.map((account) => {
                  const info = statusInfo(account.status)
                  return (
                    <li key={account.id}>
                      <button
                        type="button"
                        onClick={() => selectAccount(account.user_id)}
                        className={`flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition ${selectedUserId === account.user_id && desktop ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                      >
                        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-100 text-slate-500">
                          {account.profile_pic_url ? <img src={account.profile_pic_url} alt="" className="h-full w-full object-cover" /> : <Smartphone className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-900">{account.username}</div>
                          <div className="truncate text-xs text-slate-500">{account.display_name || (account.phone_number ? `+${account.phone_number}` : account.email)}</div>
                        </div>
                        <StatusBadge tone={info.tone}>{info.label}</StatusBadge>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </SectionCard>

        {desktop && (
          <SectionCard title="账号详情" description="选择左侧员工查看登录状态和会话" icon={MessageCircle} iconTone="emerald">
            {detail || <EmptyState compact icon={Smartphone} title="请选择员工账号" />}
          </SectionCard>
        )}
      </div>

      <SectionCard title="系统设置" description="仅管理员可见，对所有员工的 WhatsApp 会话生效。" icon={Server} iconTone="violet">
        <div className="space-y-4">
          <div className="grid gap-2 md:grid-cols-2">
            <SwitchField
              label="启用 WhatsApp 服务"
              hint={settings.enabled ? '员工可以启动和使用 WhatsApp 会话。' : '关闭后任何人都不能启动或重启会话。'}
              checked={settings.enabled}
              onChange={(value) => setSettings((current) => ({ ...current, enabled: value }))}
            />
            <SwitchField
              label="系统启动时恢复员工会话"
              hint="服务器重启后，自动重连员工设置了“自动连接”的账号。"
              checked={settings.auto_start}
              onChange={(value) => setSettings((current) => ({ ...current, auto_start: value }))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="代理类型" hint="若 XTLS 代理开启了 WhatsApp 分流，以 XTLS 为准。" className="lg:col-span-1">
              <SelectInput value={settings.proxy_type} onChange={(event) => setSettings((current) => ({ ...current, proxy_type: event.target.value as WhatsAppSettings['proxy_type'] }))}>
                <option value="none">不使用代理</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </SelectInput>
            </Field>
            <Field label="代理主机" required={settings.proxy_type !== 'none'}>
              <TextInput disabled={settings.proxy_type === 'none'} value={settings.proxy_host} onChange={(event) => setSettings((current) => ({ ...current, proxy_host: event.target.value }))} placeholder="127.0.0.1" />
            </Field>
            <Field label="端口" required={settings.proxy_type !== 'none'}>
              <TextInput type="number" disabled={settings.proxy_type === 'none'} value={settings.proxy_port || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_port: Number(event.target.value || 0) }))} placeholder="7890" />
            </Field>
            <Field label="代理账号">
              <TextInput disabled={settings.proxy_type === 'none'} value={settings.proxy_username} onChange={(event) => setSettings((current) => ({ ...current, proxy_username: event.target.value }))} placeholder="可留空" />
            </Field>
            <Field label="代理密码" hint={settings.proxy_password_configured ? '已保存，留空不修改' : undefined}>
              <TextInput type="password" autoComplete="new-password" disabled={settings.proxy_type === 'none'} value={settings.proxy_password || ''} onChange={(event) => setSettings((current) => ({ ...current, proxy_password: event.target.value }))} placeholder={settings.proxy_password_configured ? '已保存' : '可留空'} />
            </Field>
          </div>
          {settingsError && <Notice tone="danger" onClose={() => setSettingsError('')}>{settingsError}</Notice>}
        </div>
      </SectionCard>
      <StickyActions pinned={settingsDirty} note={settingsDirty ? <span className="text-amber-700">系统设置有未保存的修改</span> : '保存代理后，正在运行的会话需要“重启”才会使用新代理'}>
        <Button variant="primary" icon={Save} loading={saving} disabled={!settingsDirty} onClick={() => void saveSettings()}>
          保存系统设置
        </Button>
      </StickyActions>

      {!desktop && (
        <Modal open={mobileDetailOpen && Boolean(selectedAccount)} onClose={() => setMobileDetailOpen(false)} title={selectedAccount?.username || '账号详情'} description="WhatsApp 登录状态与会话" icon={Smartphone} iconTone="emerald">
          {detail}
        </Modal>
      )}
    </AdminShell>
  )
}
