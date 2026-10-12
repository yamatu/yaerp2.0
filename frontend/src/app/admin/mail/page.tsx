'use client'

import { AlertCircle, Inbox, Mail, MailCheck, Network, RefreshCw, Save, Send, Server, ShieldCheck, Users, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { mailHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText, formatDateTime } from '@/components/admin/adminApi'
import { useToast } from '@/components/admin/feedback'
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  Notice,
  SectionCard,
  SelectInput,
  StatGrid,
  StatusBadge,
  StickyActions,
  SwitchField,
  TextInput,
  Toolbar,
  type DataColumn,
} from '@/components/admin/ui'
import api from '@/lib/api'

interface MailServerSettings {
  enabled: boolean
  imap_host: string
  imap_port: number
  imap_security: 'tls' | 'starttls'
  smtp_host: string
  smtp_port: number
  smtp_security: 'tls' | 'starttls'
  default_domain: string
  allow_insecure_tls: boolean
  max_attachment_mb: number
  proxy_type: 'none' | 'socks5'
  proxy_host: string
  proxy_port: number
  proxy_username: string
  proxy_password?: string
  proxy_password_configured: boolean
  configured: boolean
  updated_at?: string
}

interface MailAccount {
  id: number
  user_id: number
  username: string
  user_email: string
  provider: 'imap' | 'alimail'
  provider_label: string
  email_address: string
  display_name: string
  enabled: boolean
  password_configured: boolean
  client_secret_configured: boolean
  is_default: boolean
  last_verified_at?: string
  last_sync_at?: string
  last_error?: string
  auto_forward_enabled: boolean
  auto_forward_to: string[]
}

const defaults: MailServerSettings = {
  enabled: false,
  imap_host: '',
  imap_port: 993,
  imap_security: 'tls',
  smtp_host: '',
  smtp_port: 465,
  smtp_security: 'tls',
  default_domain: '',
  allow_insecure_tls: false,
  max_attachment_mb: 25,
  proxy_type: 'none',
  proxy_host: '',
  proxy_port: 1080,
  proxy_username: '',
  proxy_password: '',
  proxy_password_configured: false,
  configured: false,
}

const fingerprintOf = (settings: MailServerSettings) => JSON.stringify({ ...settings, updated_at: undefined })

export default function AdminMailPage() {
  const toast = useToast()
  const [settings, setSettings] = useState<MailServerSettings>(defaults)
  const [savedFingerprint, setSavedFingerprint] = useState(fingerprintOf(defaults))
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [settingsRes, accountsRes] = await Promise.all([api.get<MailServerSettings>('/admin/mail/settings'), api.get<MailAccount[]>('/admin/mail/accounts')])
      ensureOk(settingsRes, '无法读取邮件配置')
      const next = { ...defaults, ...settingsRes.data!, proxy_password: '' }
      setSettings(next)
      setSavedFingerprint(fingerprintOf(next))
      setAccounts(accountsRes.code === 0 && accountsRes.data ? accountsRes.data : [])
    } catch (error) {
      setLoadError(errorText(error, '无法读取邮件配置'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof MailServerSettings>(key: K, value: MailServerSettings[K]) => setSettings((current) => ({ ...current, [key]: value }))
  const dirty = fingerprintOf(settings) !== savedFingerprint

  const validate = () => {
    if (!settings.imap_host.trim() || !settings.smtp_host.trim()) return 'IMAP 和 SMTP 服务器地址不能为空（只用阿里邮箱时可填 imap.qiye.aliyun.com / smtp.qiye.aliyun.com）'
    const ports = [settings.imap_port, settings.smtp_port]
    if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) return '端口必须在 1–65535 之间'
    if (settings.max_attachment_mb < 1 || settings.max_attachment_mb > 50) return '附件上限必须在 1–50 MB 之间'
    if (settings.proxy_type === 'socks5' && (!settings.proxy_host.trim() || settings.proxy_port < 1 || settings.proxy_port > 65535)) return '请填写 SOCKS5 代理主机和有效端口'
    return ''
  }

  const save = async () => {
    const validation = validate()
    if (validation) {
      setFormError(validation)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const res = await api.put<MailServerSettings>('/admin/mail/settings', settings)
      ensureOk(res, '保存失败')
      const next = { ...defaults, ...res.data!, proxy_password: '' }
      setSettings(next)
      setSavedFingerprint(fingerprintOf(next))
      toast.success(next.enabled ? '邮件服务配置已保存并启用' : '配置已保存（邮件服务当前为关闭状态）')
    } catch (error) {
      setFormError(errorText(error, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const applyPosteDefaults = () => {
    const domain = settings.default_domain.trim()
    if (!domain && !settings.imap_host && !settings.smtp_host) {
      toast.warning('请先填写邮箱域名，例如 example.com')
      return
    }
    const host = domain ? `mail.${domain.replace(/^mail\./, '')}` : settings.imap_host || settings.smtp_host
    setSettings((current) => ({ ...current, imap_host: host, imap_port: 993, imap_security: 'tls', smtp_host: host, smtp_port: 465, smtp_security: 'tls' }))
    toast.info(`已填入 ${host}：IMAP 993 / SMTP 465（TLS）。检查无误后点击保存。`)
  }

  const filteredAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return keyword ? accounts.filter((account) => `${account.username} ${account.email_address} ${account.display_name}`.toLowerCase().includes(keyword)) : accounts
  }, [accounts, search])

  const errorAccounts = accounts.filter((account) => account.last_error).length

  const columns: Array<DataColumn<MailAccount>> = [
    {
      key: 'user',
      header: '员工',
      mobile: 'title',
      render: (account) => (
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-900">{account.username}</div>
          <div className="truncate text-xs text-slate-500">{account.email_address}</div>
        </div>
      ),
    },
    {
      key: 'provider',
      header: '类型',
      render: (account) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge tone={account.provider === 'alimail' ? 'amber' : 'sky'}>{account.provider_label || (account.provider === 'alimail' ? '阿里邮箱' : 'IMAP')}</StatusBadge>
          {account.is_default && <StatusBadge>当前使用</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'sender',
      header: '发件人名称',
      render: (account) => <span className="text-slate-600">{account.display_name || <span className="text-slate-400">未设置</span>}</span>,
    },
    {
      key: 'sync',
      header: '最近验证 / 同步',
      render: (account) => (
        <div className="text-xs text-slate-500">
          <div>验证 {formatDateTime(account.last_verified_at, '尚未连接')}</div>
          <div>同步 {formatDateTime(account.last_sync_at, '尚未同步')}</div>
          {account.auto_forward_enabled && <div className="text-sky-600">自动转发至 {account.auto_forward_to.join('、')}</div>}
          {account.last_error && <div className="mt-1 break-words text-rose-600">{account.last_error}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      mobile: 'badge',
      render: (account) =>
        account.last_error ? (
          <StatusBadge tone="rose" dot>连接异常</StatusBadge>
        ) : account.enabled ? (
          <StatusBadge tone="emerald" dot>已启用</StatusBadge>
        ) : (
          <StatusBadge dot>已停用</StatusBadge>
        ),
    },
  ]

  const proxyDisabled = settings.proxy_type === 'none'

  return (
    <AdminShell title="邮件服务" description="IMAP / SMTP 服务器、邮件代理与员工邮箱绑定状态" help={mailHelp} actions={<IconButton icon={RefreshCw} label="刷新配置与账号状态" spin={loading} onClick={() => void load()} />}>
      <StatGrid
        items={[
          { label: '邮件服务', value: settings.enabled ? '已启用' : '未启用', icon: MailCheck, tone: settings.enabled ? 'emerald' : 'amber' },
          { label: '服务器', value: settings.imap_host || '未配置', icon: Server, tone: settings.imap_host ? 'sky' : 'slate' },
          { label: '已绑定邮箱', value: accounts.length, icon: Users, tone: 'violet' },
          { label: '连接异常', value: errorAccounts, icon: AlertCircle, tone: errorAccounts ? 'rose' : 'slate' },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void load()}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      {loading && !settings.imap_host && !loadError ? (
        <SectionCard>
          <LoadingState label="正在读取邮件配置…" />
        </SectionCard>
      ) : (
        <>
          <SectionCard title="服务开关" icon={MailCheck} iconTone="emerald">
            <SwitchField
              label="启用邮件服务"
              hint={settings.enabled ? '员工可以在「邮件」页面绑定邮箱并收发邮件。' : '已关闭：员工无法收发邮件（含阿里邮箱），配置和员工绑定会保留。'}
              checked={settings.enabled}
              onChange={(value) => set('enabled', value)}
            />
          </SectionCard>

          <SectionCard
            title="服务器连接"
            description="员工的 IMAP 邮箱统一使用这里的服务器；员工只需填写自己的邮箱地址和密码。"
            icon={Server}
            iconTone="sky"
            actions={
              <Button size="sm" variant="accent" icon={Wand2} onClick={applyPosteDefaults}>
                按 Poste.io 推荐填充
              </Button>
            }
          >
            <div className="space-y-4">
              <Field label="邮箱域名" hint="公司邮箱 @ 后面的部分，用于自动填充服务器地址和员工绑定时补全邮箱。">
                <TextInput value={settings.default_domain} onChange={(event) => set('default_domain', event.target.value)} placeholder="example.com" />
              </Field>
              <div className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[minmax(0,2fr)_180px_150px]">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 md:col-span-3">
                  <Inbox className="h-4 w-4 text-slate-400" />
                  收件（IMAP）
                </div>
                <Field label="主机" required>
                  <TextInput value={settings.imap_host} onChange={(event) => set('imap_host', event.target.value)} placeholder="mail.example.com" className="font-mono" />
                </Field>
                <Field label="端口" hint="TLS 993 / STARTTLS 143">
                  <TextInput type="number" min={1} max={65535} value={settings.imap_port || ''} onChange={(event) => set('imap_port', Number(event.target.value) || 0)} placeholder="993" />
                </Field>
                <Field label="加密">
                  <SelectInput value={settings.imap_security} onChange={(event) => set('imap_security', event.target.value as MailServerSettings['imap_security'])}>
                    <option value="tls">TLS / SSL</option>
                    <option value="starttls">STARTTLS</option>
                  </SelectInput>
                </Field>
              </div>
              <div className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[minmax(0,2fr)_180px_150px]">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 md:col-span-3">
                  <Send className="h-4 w-4 text-slate-400" />
                  发件（SMTP）
                </div>
                <Field label="主机" required>
                  <TextInput value={settings.smtp_host} onChange={(event) => set('smtp_host', event.target.value)} placeholder="mail.example.com" className="font-mono" />
                </Field>
                <Field label="端口" hint="TLS 465 / STARTTLS 587">
                  <TextInput type="number" min={1} max={65535} value={settings.smtp_port || ''} onChange={(event) => set('smtp_port', Number(event.target.value) || 0)} placeholder="465" />
                </Field>
                <Field label="加密">
                  <SelectInput value={settings.smtp_security} onChange={(event) => set('smtp_security', event.target.value as MailServerSettings['smtp_security'])}>
                    <option value="tls">TLS / SSL</option>
                    <option value="starttls">STARTTLS</option>
                  </SelectInput>
                </Field>
              </div>
              <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)] md:items-start">
                <Field label="单封附件上限（MB）" hint="1–50 MB">
                  <TextInput type="number" min={1} max={50} value={settings.max_attachment_mb || ''} onChange={(event) => set('max_attachment_mb', Number(event.target.value) || 0)} />
                </Field>
                <div className="md:pt-5">
                  <SwitchField
                    tone="warning"
                    label="允许不受信任的 TLS 证书"
                    hint="仅在内网自签名证书时开启；公网环境开启有被中间人攻击的风险。"
                    checked={settings.allow_insecure_tls}
                    onChange={(value) => set('allow_insecure_tls', value)}
                  />
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="邮件网络代理" description="IMAP、SMTP 和阿里邮箱 OpenAPI 统一经过该代理；员工无需单独配置。若「XTLS 代理」开启了邮件分流，以 XTLS 为准。" icon={Network} iconTone="violet">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="代理方式">
                <SelectInput value={settings.proxy_type} onChange={(event) => set('proxy_type', event.target.value as MailServerSettings['proxy_type'])}>
                  <option value="none">不使用代理</option>
                  <option value="socks5">SOCKS5</option>
                </SelectInput>
              </Field>
              <Field label="代理主机" required={!proxyDisabled}>
                <TextInput disabled={proxyDisabled} value={settings.proxy_host} onChange={(event) => set('proxy_host', event.target.value)} placeholder="127.0.0.1" />
              </Field>
              <Field label="代理端口" required={!proxyDisabled}>
                <TextInput type="number" min={1} max={65535} disabled={proxyDisabled} value={settings.proxy_port || ''} onChange={(event) => set('proxy_port', Number(event.target.value) || 0)} placeholder="1080" />
              </Field>
              <Field label="代理账号">
                <TextInput disabled={proxyDisabled} value={settings.proxy_username} onChange={(event) => set('proxy_username', event.target.value)} placeholder="可留空" />
              </Field>
              <Field
                label="代理密码"
                className="sm:col-span-2"
                hint={settings.proxy_password_configured ? '已保存密码（不回显），留空表示保持不变。' : '无密码可留空。'}
                aside={
                  settings.proxy_password_configured && !proxyDisabled ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault()
                        setSettings((current) => ({ ...current, proxy_password_configured: false, proxy_password: '' }))
                      }}
                      className="inline-flex h-7 items-center rounded-md px-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                    >
                      清除已保存密码
                    </button>
                  ) : undefined
                }
              >
                <TextInput type="password" autoComplete="new-password" disabled={proxyDisabled} value={settings.proxy_password || ''} onChange={(event) => set('proxy_password', event.target.value)} placeholder={settings.proxy_password_configured ? '已保存，留空不修改' : '可留空'} />
              </Field>
            </div>
          </SectionCard>

          {formError && <Notice tone="danger" onClose={() => setFormError('')}>{formError}</Notice>}
          <StickyActions pinned={dirty} note={dirty ? <span className="text-amber-700">有未保存的修改</span> : settings.updated_at ? `上次保存：${formatDateTime(settings.updated_at)}` : 'Poste.io 推荐：IMAP 993 TLS；SMTP 465 TLS 或 587 STARTTLS'}>
            <Button variant="primary" icon={Save} loading={saving} disabled={loading || !dirty} onClick={() => void save()}>
              保存配置
            </Button>
          </StickyActions>
        </>
      )}

      <SectionCard title="员工邮箱绑定" description="员工在「邮件」页面自行绑定。管理员只能查看连接状态，看不到密码和邮件内容。" icon={ShieldCheck} flush>
        <Toolbar search={search} onSearch={setSearch} placeholder="搜索员工或邮箱地址" />
        <DataTable
          rows={filteredAccounts}
          columns={columns}
          rowKey={(account) => account.id}
          loading={loading}
          empty={<EmptyState icon={Mail} title={accounts.length ? '没有匹配的邮箱' : '还没有员工绑定邮箱'} description={accounts.length ? undefined : '启用邮件服务后，通知员工到「邮件」页面绑定自己的邮箱。'} />}
        />
      </SectionCard>
    </AdminShell>
  )
}
