'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Globe2,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  Plug,
  Power,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { ProxyNode, ProxyNodeResult, ProxyStatus } from '@/types'

const EMPTY_STATUS: ProxyStatus = {
  core_available: false,
  core_version: '',
  core_endpoint: '',
  core_error: '',
  consumer_ok: false,
  consumer_error: '',
  enabled: false,
  subscription_url: '',
  subscription_name: '',
  source_type: 'none',
  selected_node: '',
  selected_group: '',
  proxy_ai: false,
  proxy_whatsapp: false,
  proxy_mail: false,
  node_count: 0,
  group_count: 0,
  proxy_endpoint: '',
  mixed_port: 0,
  controller_port: 0,
  config_persisted: false,
  last_error: '',
  updated_at: '',
}

function delayLabel(node: ProxyNode) {
  if (node.delay < 0) return '未测试'
  if (node.delay === 0) return '超时'
  return `${node.delay} ms`
}

function delayClass(node: ProxyNode) {
  if (node.delay <= 0) return 'text-slate-400'
  if (node.delay < 200) return 'text-emerald-600'
  if (node.delay < 500) return 'text-amber-600'
  return 'text-rose-600'
}

function sourceLabel(sourceType: string) {
  switch (sourceType) {
    case 'yaml': return 'Clash/Mihomo 配置'
    case 'links': return '节点链接'
    default: return '未导入'
  }
}

export default function ProxyPage() {
  const [status, setStatus] = useState<ProxyStatus>(EMPTY_STATUS)
  const [nodes, setNodes] = useState<ProxyNode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [testing, setTesting] = useState(false)
  const [nodeSearch, setNodeSearch] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [subscriptionURL, setSubscriptionURL] = useState('')
  const [subscriptionName, setSubscriptionName] = useState('')
  const [rawPayload, setRawPayload] = useState('')
  const [useRawPayload, setUseRawPayload] = useState(false)
  const [portDraft, setPortDraft] = useState('')

  const statusRequestRef = useRef(0)

  const applyStatus = useCallback((next: ProxyStatus) => {
    setStatus(next)
    if (next.nodes) setNodes(next.nodes)
  }, [])

  const loadStatus = useCallback(async (silent = false) => {
    const sequence = ++statusRequestRef.current
    if (!silent) setLoading(true)
    try {
      const response = await api.get<ProxyStatus>('/admin/proxy/status')
      if (sequence !== statusRequestRef.current) return
      if (response.code === 0 && response.data) {
        applyStatus(response.data)
        setSubscriptionURL((current) => current || response.data!.subscription_url || '')
        setSubscriptionName((current) => current || response.data!.subscription_name || '')
      }
    } catch {
      if (sequence === statusRequestRef.current && !silent) setError('无法读取代理状态')
    } finally {
      if (sequence === statusRequestRef.current && !silent) setLoading(false)
    }
  }, [applyStatus])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (testing) return
      void loadStatus(true)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [loadStatus, testing])

  const resetBanners = () => {
    setError('')
    setNotice('')
  }

  const run = async (key: string, action: () => Promise<{ code: number; message?: string; data?: ProxyStatus }>, successMessage: string) => {
    resetBanners()
    setBusy(key)
    try {
      const response = await action()
      if (response.code !== 0) {
        setError(response.message || '操作失败')
        return
      }
      if (response.data) applyStatus(response.data)
      setNotice(successMessage)
    } catch {
      setError('请求失败，请检查后端服务与代理内核')
    } finally {
      setBusy('')
    }
  }

  const importSubscription = () => run('import', async () => {
    const body = useRawPayload
      ? { url: '', payload: rawPayload, name: subscriptionName }
      : { url: subscriptionURL, payload: '', name: subscriptionName }
    return api.post<ProxyStatus>('/admin/proxy/subscription', body)
  }, '订阅导入成功，节点列表已更新。')

  const refreshSubscription = () => run('refresh', () => api.post<ProxyStatus>('/admin/proxy/subscription/refresh'), '订阅已刷新。')

  const deleteSubscription = () => {
    if (!window.confirm('删除订阅后需要重新导入，确认继续？')) return
    return run('delete', () => api.delete<ProxyStatus>('/admin/proxy/subscription'), '订阅已删除。')
  }

  const toggleConnection = () => status.enabled
    ? run('disconnect', () => api.post<ProxyStatus>('/admin/proxy/disconnect'), '已断开代理，AI、WhatsApp 与邮件将直连。')
    : run('connect', () => api.post<ProxyStatus>('/admin/proxy/connect'), '代理已连接。')

  const updateToggle = (key: 'proxy_ai' | 'proxy_whatsapp' | 'proxy_mail', value: boolean) =>
    run(key, () => api.put<ProxyStatus>('/admin/proxy/toggles', { [key]: value }), '分流设置已更新。')

  const savePort = () => {
    const port = Number(portDraft)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resetBanners()
      setError('代理端口必须是 1-65535 之间的整数')
      return
    }
    void run('port', () => api.put<ProxyStatus>('/admin/proxy/port', { mixed_port: port }), `代理端口已改为 ${port}，配置已重新下发。`)
      .then(() => setPortDraft(''))
  }

  const selectNode = (node: ProxyNode) => run(`node:${node.name}`, async () => {
    const response = await api.post<ProxyStatus>('/admin/proxy/nodes/select', { node: node.name })
    if (response.code === 0) setNodes((current) => current.map((item) => ({ ...item, selected: item.name === node.name })))
    return response
  }, `已切换到节点 ${node.name}。`)

  const testNodes = async () => {
    resetBanners()
    setTesting(true)
    try {
      const response = await api.post<{ results: ProxyNodeResult[] }>('/admin/proxy/nodes/test', { names: [] })
      if (response.code !== 0 || !response.data) {
        setError(response.message || '节点测速失败')
        return
      }
      const resultMap = new Map(response.data.results.map((item) => [item.name, item]))
      setNodes((current) => current.map((node) => {
        const result = resultMap.get(node.name)
        if (!result) return node
        return { ...node, delay: result.delay > 0 ? result.delay : 0 }
      }))
      const timeoutCount = response.data.results.filter((item) => item.error || item.delay <= 0).length
      setNotice(timeoutCount > 0 ? `测速完成，${timeoutCount} 个节点超时或失败。` : '测速完成，所有节点可用。')
    } catch {
      setError('节点测速失败')
    } finally {
      setTesting(false)
    }
  }

  const filteredNodes = useMemo(() => {
    const keyword = nodeSearch.trim().toLowerCase()
    if (!keyword) return nodes
    return nodes.filter((node) => node.name.toLowerCase().includes(keyword) || node.type.toLowerCase().includes(keyword))
  }, [nodeSearch, nodes])

  const availableCount = useMemo(() => nodes.filter((node) => node.delay > 0).length, [nodes])
  const coreOnline = status.core_available

  return (
    <AdminShell
      title="XTLS / 代理核心"
      description="导入 XTLS(Clash.Meta) 订阅，测速选点，并按业务分别决定 AI、WhatsApp、邮箱是否走代理"
    >
      <div className="space-y-3">
        {/* Status ---------------------------------------------------------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 inline-flex h-10 w-10 items-center justify-center rounded-lg ${status.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                {status.enabled ? <CheckCircle2 className="h-5 w-5" /> : <Power className="h-5 w-5" />}
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-slate-900">{status.enabled ? '代理已连接' : '代理未连接'}</h2>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${coreOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                    <Cpu className="h-3 w-3" />
                    {coreOnline ? `内核在线 ${status.core_version || ''}`.trim() : '内核离线'}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  代理入口 <span className="font-mono text-slate-700">{status.proxy_endpoint || '未配置'}</span>
                  {status.core_endpoint ? <> · 控制器 <span className="font-mono text-slate-700">{status.core_endpoint}</span></> : null}
                  {status.mixed_port ? <> · 端口 <span className="font-mono text-slate-700">{status.mixed_port}</span></> : null}
                  {status.selected_node ? <> · 当前节点 <span className="font-medium text-slate-700">{status.selected_node}</span></> : null}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void loadStatus()} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新状态
              </button>
              <button
                type="button"
                onClick={() => void toggleConnection()}
                disabled={busy !== '' || !coreOnline || (status.source_type === 'none' && !status.enabled)}
                className={`inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-40 ${status.enabled ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-800'}`}
              >
                {busy === 'connect' || busy === 'disconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                {status.enabled ? '断开代理' : '连接代理'}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-400">节点数量</div>
              <div className="mt-0.5 font-semibold text-slate-800">{status.node_count}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-400">可用节点（已测速）</div>
              <div className="mt-0.5 font-semibold text-slate-800">{availableCount}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-400">订阅来源</div>
              <div className="mt-0.5 truncate font-semibold text-slate-800">{sourceLabel(status.source_type)}</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-400">更新时间</div>
              <div className="mt-0.5 font-semibold text-slate-800">{status.updated_at ? new Date(status.updated_at).toLocaleString() : '—'}</div>
            </div>
          </div>

          {!coreOnline && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <div>代理内核（Mihomo 容器）当前不可用。</div>
                {status.core_error && (
                  <div className="font-mono text-xs break-all text-amber-900">{status.core_error}</div>
                )}
                <div className="text-xs text-amber-700">
                  后端已尝试所有候选控制器地址（当前显示 <code className="rounded bg-amber-100 px-1">{status.core_endpoint || '未配置'}</code>）。
                  请在服务器执行 <code className="rounded bg-amber-100 px-1">docker compose ps proxy</code> 确认容器为 <code className="rounded bg-amber-100 px-1">Up (healthy)</code>；
                  若刚刚修改过 <code className="rounded bg-amber-100 px-1">.env</code>，需执行 <code className="rounded bg-amber-100 px-1">docker compose up -d --build backend proxy</code> 重建容器。订阅仍可导入，节点要等内核启动后才能测速。
                </div>
              </div>
            </div>
          )}
          {coreOnline && !status.consumer_ok && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                内核在线，但后端无法连接代理入口 <code className="rounded bg-rose-100 px-1">{status.proxy_endpoint || '未配置'}</code>：{status.consumer_error}
                。请检查 <code className="rounded bg-rose-100 px-1">MIHOMO_MIXED_ADDR</code> 的主机名是否与后端所在环境一致（容器内为 <code className="rounded bg-rose-100 px-1">proxy</code>，宿主机为 <code className="rounded bg-rose-100 px-1">127.0.0.1</code>）；端口由上方「代理端口」控制，默认 7890。
              </span>
            </div>
          )}
          {status.last_error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{status.last_error}</span>
            </div>
          )}
          {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          {notice && <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
        </section>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* Subscription ------------------------------------------------- */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">订阅导入</h2>
              <div className="ml-auto flex rounded-lg border border-slate-200 p-0.5 text-xs">
                <button type="button" onClick={() => setUseRawPayload(false)} className={`rounded-md px-2.5 py-1 ${!useRawPayload ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>订阅链接</button>
                <button type="button" onClick={() => setUseRawPayload(true)} className={`rounded-md px-2.5 py-1 ${useRawPayload ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>粘贴内容</button>
              </div>
            </div>
            <p className="mt-1 text-sm text-slate-500">支持 XTLS/Clash.Meta 订阅、base64 节点列表（vless / vmess / trojan / ss / hysteria2 / tuic）。导入后会重建规则，全部流量走所选节点。</p>

            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">订阅名称（可选）</span>
                <input value={subscriptionName} onChange={(event) => setSubscriptionName(event.target.value)} placeholder="例如：机场 A" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" />
              </label>

              {useRawPayload ? (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">订阅内容</span>
                  <textarea
                    value={rawPayload}
                    onChange={(event) => setRawPayload(event.target.value)}
                    rows={8}
                    placeholder="粘贴 Clash/Mihomo YAML 配置，或 base64 编码的节点链接列表"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-slate-600">订阅链接</span>
                  <input
                    value={subscriptionURL}
                    onChange={(event) => setSubscriptionURL(event.target.value)}
                    placeholder="https://example.com/api/v1/client/subscribe?token=..."
                    className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-sm"
                  />
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void importSubscription()} disabled={busy !== ''} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">
                  {busy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {status.source_type === 'none' ? '导入订阅' : '替换订阅'}
                </button>
                <button type="button" onClick={() => void refreshSubscription()} disabled={busy !== '' || !status.subscription_url} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">
                  {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}刷新订阅
                </button>
                <button type="button" onClick={() => void deleteSubscription()} disabled={busy !== '' || status.source_type === 'none'} className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 px-3 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                  {busy === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}删除订阅
                </button>
              </div>

              {status.subscription_url && (
                <div className="truncate rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  当前订阅：<span className="font-mono text-slate-700">{status.subscription_url}</span>
                </div>
              )}
            </div>
          </section>

          {/* Routing ------------------------------------------------------ */}
          <div className="space-y-3">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">业务分流</h2>
            </div>
            <p className="mt-1 text-sm text-slate-500">仅在代理连接后生效，可分别为三类业务选择是否走代理。</p>

            <div className="mt-4 space-y-2">
              {([
                { key: 'proxy_ai' as const, label: 'AI 接口流量', hint: 'OpenAI / 兼容接口的对话与工具调用', icon: Sparkles, value: status.proxy_ai },
                { key: 'proxy_whatsapp' as const, label: 'WhatsApp 流量', hint: '保存后会自动重启已登录的会话以套用代理', icon: MessageCircle, value: status.proxy_whatsapp },
                { key: 'proxy_mail' as const, label: '邮箱流量', hint: 'IMAP / SMTP / 网页版邮箱请求（SOCKS5）', icon: Mail, value: status.proxy_mail },
              ]).map((item) => {
                const Icon = item.icon
                return (
                  <label key={item.key} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800">{item.label}</div>
                        <div className="mt-0.5 text-xs text-slate-400">{item.hint}</div>
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={item.value}
                      disabled={busy !== '' || !status.enabled}
                      onChange={(event) => void updateToggle(item.key, event.target.checked)}
                      className="h-4 w-4 shrink-0 accent-slate-900 disabled:opacity-40"
                    />
                  </label>
                )
              })}
            </div>
            {!status.enabled && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">代理未连接时所有业务都走直连，开关仅记录偏好。</p>}
          </section>

          {/* Port --------------------------------------------------------- */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">代理端口</h2>
            </div>
            <p className="mt-1 text-sm text-slate-500">内核监听的混合端口（HTTP + SOCKS5），AI、WhatsApp 与邮件均通过它出海。修改后会自动重写并下发配置，无需重建容器。</p>

            <div className="mt-4 flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">混合端口</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={portDraft !== '' ? portDraft : String(status.mixed_port || '')}
                  onChange={(event) => setPortDraft(event.target.value)}
                  placeholder="7890"
                  className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-sm"
                />
              </label>
              <button
                type="button"
                onClick={savePort}
                disabled={busy !== '' || !coreOnline || portDraft === '' || Number(portDraft) === status.mixed_port}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy === 'port' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存
              </button>
            </div>

            <dl className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-400">内核监听</dt>
                <dd className="font-mono text-slate-700">{status.mixed_port || '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-400">控制器端口</dt>
                <dd className="font-mono text-slate-700">{status.controller_port || '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-400">配置持久化</dt>
                <dd className={status.config_persisted ? 'text-emerald-600' : 'text-amber-600'}>
                  {status.config_persisted ? '已开启（重启自动恢复）' : '未开启'}
                </dd>
              </div>
            </dl>

            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              容器网络内（后端 / sidecar）会立即使用新端口。宿主机若需直连，要同步修改 <code className="rounded bg-white px-1">MIHOMO_MIXED_PORT</code> / <code className="rounded bg-white px-1">MIHOMO_PUBLISH_PORT</code> 并重建 proxy 容器。
            </p>
            {!status.config_persisted && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                未开启持久化时，proxy 容器重启会丢失已下发的配置；建议使用 docker compose（会共享 mihomo_config 卷）。
              </p>
            )}
          </section>
          </div>
        </div>

        {/* Nodes ---------------------------------------------------------- */}
        <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 p-4 md:flex-row md:items-center md:justify-between md:p-5">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">节点列表</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{nodes.length}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex h-9 min-w-48 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-500">
                <Search className="h-4 w-4" />
                <input value={nodeSearch} onChange={(event) => setNodeSearch(event.target.value)} placeholder="搜索节点名称或协议" className="min-w-0 flex-1 outline-none" />
              </label>
              <button type="button" onClick={() => void testNodes()} disabled={testing || !coreOnline || nodes.length === 0} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-40">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                {testing ? '测速中...' : '测试全部延迟'}
              </button>
            </div>
          </div>

          {loading && nodes.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-slate-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取节点...
            </div>
          ) : filteredNodes.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-slate-400">
              <Save className="h-6 w-6 text-slate-300" />
              {nodes.length === 0 ? '还没有节点，请先导入订阅' : '没有匹配的节点'}
            </div>
          ) : (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">节点</th>
                    <th className="px-4 py-2 font-medium">协议</th>
                    <th className="px-4 py-2 font-medium">延迟</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNodes.map((node) => (
                    <tr key={node.name} className={`border-t border-slate-100 ${node.selected ? 'bg-emerald-50/60' : 'hover:bg-slate-50'}`}>
                      <td className="max-w-0 px-4 py-2">
                        <div className="flex items-center gap-2">
                          {node.selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
                          <span className="truncate font-medium text-slate-800" title={node.name}>{node.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-xs uppercase text-slate-500">{node.type || '—'}</td>
                      <td className={`px-4 py-2 font-mono text-xs ${delayClass(node)}`}>{delayLabel(node)}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void selectNode(node)}
                          disabled={busy !== '' || node.selected || !coreOnline}
                          className="inline-flex h-7 items-center rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-white disabled:opacity-40"
                        >
                          {busy === `node:${node.name}` ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                          {node.selected ? '使用中' : '使用'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AdminShell>
  )
}
