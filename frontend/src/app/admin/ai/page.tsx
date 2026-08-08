'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleOff,
  Gauge,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Server,
  Star,
  Trash2,
  Wrench,
} from 'lucide-react'
import api from '@/lib/api'
import { AdminShell } from '@/components/admin/AdminShell'
import type { AIAssistant } from '@/types'

interface AssistantForm {
  name: string
  description: string
  provider: AIAssistant['provider']
  api_protocol: AIAssistant['api_protocol']
  endpoint: string
  model: string
  reasoning_effort: AIAssistant['reasoning_effort']
  api_key: string
  clear_api_key: boolean
  system_prompt: string
  enabled: boolean
  is_default: boolean
  supports_vision: boolean
  supports_files: boolean
  supports_tools: boolean
}

interface AssistantTestResult {
  provider: AIAssistant['provider']
  protocol: AIAssistant['api_protocol']
  model: string
  latency_ms: number
  text_ok: boolean
  tool_call_ok: boolean
}

const emptyForm: AssistantForm = {
  name: '',
  description: '',
  provider: 'openai',
  api_protocol: 'responses',
  endpoint: 'https://api.openai.com/v1',
  model: '',
  reasoning_effort: 'auto',
  api_key: '',
  clear_api_key: false,
  system_prompt: '',
  enabled: true,
  is_default: false,
  supports_vision: false,
  supports_files: false,
  supports_tools: true,
}

function assistantToForm(assistant: AIAssistant): AssistantForm {
  const provider = assistant.provider || 'openai_compatible'
  return {
    name: assistant.name,
    description: assistant.description || '',
    provider,
    api_protocol: provider === 'openai' ? 'responses' : assistant.api_protocol || 'chat_completions',
    endpoint: provider === 'openai' ? 'https://api.openai.com/v1' : assistant.endpoint || '',
    model: assistant.model,
    reasoning_effort: assistant.reasoning_effort || 'auto',
    api_key: '',
    clear_api_key: false,
    system_prompt: assistant.system_prompt || '',
    enabled: assistant.enabled,
    is_default: assistant.is_default,
    supports_vision: assistant.supports_vision,
    supports_files: assistant.supports_files,
    supports_tools: assistant.supports_tools ?? true,
  }
}

const reasoningOptions: Array<{ value: AIAssistant['reasoning_effort']; label: string }> = [
  { value: 'auto', label: '自动适配' },
  { value: 'none', label: '不启用推理' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最高' },
]

function formFingerprint(form: AssistantForm) {
  return JSON.stringify(form)
}

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, '')
}

export default function AdminAIPage() {
  const [assistants, setAssistants] = useState<AIAssistant[]>([])
  const [selectedId, setSelectedId] = useState<number | 'new'>('new')
  const [form, setForm] = useState<AssistantForm>(emptyForm)
  const [savedFingerprint, setSavedFingerprint] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AssistantTestResult | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const selectedAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === selectedId) || null,
    [assistants, selectedId]
  )

  const loadAssistants = useCallback(async (preferredId?: number) => {
    setLoading(true)
    try {
      const res = await api.get<AIAssistant[]>('/admin/ai/assistants')
      const items = res.code === 0 && Array.isArray(res.data) ? res.data : []
      setAssistants(items)
      const next = preferredId
        ? items.find((assistant) => assistant.id === preferredId)
        : items.find((assistant) => assistant.is_default) || items[0]
      if (next) {
        const nextForm = assistantToForm(next)
        setSelectedId(next.id)
        setForm(nextForm)
        setSavedFingerprint(formFingerprint(nextForm))
      } else {
        setSelectedId('new')
        setForm({ ...emptyForm })
        setSavedFingerprint('')
      }
    } catch {
      setMessage({ type: 'error', text: '加载 AI 助手失败' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAssistants()
  }, [loadAssistants])

  const chooseAssistant = (assistant: AIAssistant) => {
    const nextForm = assistantToForm(assistant)
    setSelectedId(assistant.id)
    setForm(nextForm)
    setSavedFingerprint(formFingerprint(nextForm))
    setTestResult(null)
    setMessage(null)
  }

  const startCreate = () => {
    const nextForm = { ...emptyForm, is_default: assistants.length === 0 }
    setSelectedId('new')
    setForm(nextForm)
    setSavedFingerprint('')
    setTestResult(null)
    setMessage(null)
  }

  const updateField = <K extends keyof AssistantForm>(key: K, value: AssistantForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setTestResult(null)
  }

  const updateProvider = (provider: AIAssistant['provider']) => {
    setForm((current) => {
      if (current.provider === provider) return current
      return {
        ...current,
        provider,
        api_protocol: provider === 'openai' ? 'responses' : 'chat_completions',
        endpoint: provider === 'openai'
          ? 'https://api.openai.com/v1'
          : selectedAssistant?.provider === 'openai_compatible'
            ? selectedAssistant.endpoint || ''
            : '',
        api_key: '',
        clear_api_key: false,
      }
    })
    setTestResult(null)
  }

  const updateAPIKey = (value: string) => {
    setForm((current) => ({
      ...current,
      api_key: value,
      clear_api_key: value.trim() ? false : current.clear_api_key,
    }))
    setTestResult(null)
  }

  const hasUnsavedChanges = selectedId === 'new' || formFingerprint(form) !== savedFingerprint
  const requiresNewOpenAIKey = form.provider === 'openai' && (
    selectedId === 'new' ||
    selectedAssistant?.provider !== 'openai' ||
    !selectedAssistant?.has_api_key
  )
  const thirdPartyCredentialBoundaryChanged = form.provider === 'openai_compatible' &&
    selectedId !== 'new' &&
    Boolean(selectedAssistant?.has_api_key) && (
      selectedAssistant?.provider !== 'openai_compatible' ||
      normalizeEndpoint(selectedAssistant.endpoint || '') !== normalizeEndpoint(form.endpoint)
    )

  const saveAssistant = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || !form.model.trim()) {
      setMessage({ type: 'error', text: '请填写助手名称、API 端点和模型名称' })
      return
    }
    if (requiresNewOpenAIKey && !form.api_key.trim()) {
      setMessage({ type: 'error', text: 'OpenAI 官方接口必须填写 API 密钥' })
      return
    }
    setSaving(true)
    setTestResult(null)
    setMessage(null)
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
        endpoint: form.endpoint.trim(),
        model: form.model.trim(),
        api_key: form.api_key.trim(),
        clear_api_key: form.provider === 'openai' ? false : form.clear_api_key,
        system_prompt: form.system_prompt.trim(),
      }
      const res = selectedId === 'new'
        ? await api.post<AIAssistant>('/admin/ai/assistants', payload)
        : await api.put<AIAssistant>(`/admin/ai/assistants/${selectedId}`, payload)
      if (res.code !== 0 || !res.data) {
        setMessage({ type: 'error', text: res.message || '保存失败' })
        return
      }
      setMessage({ type: 'success', text: selectedId === 'new' ? '助手已创建' : '配置已保存' })
      await loadAssistants(res.data.id)
    } catch {
      setMessage({ type: 'error', text: '保存失败，请检查端点配置' })
    } finally {
      setSaving(false)
    }
  }

  const testAssistant = async () => {
    if (selectedId === 'new' || hasUnsavedChanges) {
      setMessage({ type: 'error', text: '请先保存当前配置，再测试连接' })
      return
    }
    setTesting(true)
    setTestResult(null)
    setMessage(null)
    try {
      const res = await api.post<AssistantTestResult>(`/admin/ai/assistants/${selectedId}/test`)
      if (res.code !== 0 || !res.data) {
        setMessage({ type: 'error', text: res.message || '连接测试失败' })
        return
      }
      setTestResult(res.data)
      setMessage({
        type: res.data.text_ok ? 'success' : 'error',
        text: res.data.text_ok ? '模型连接测试完成' : '模型未返回有效文本',
      })
    } catch {
      setMessage({ type: 'error', text: '连接测试失败，请检查密钥、端点和模型名称' })
    } finally {
      setTesting(false)
    }
  }

  const setDefault = async () => {
    if (selectedId === 'new') return
    setSaving(true)
    setMessage(null)
    try {
      const res = await api.post<AIAssistant>(`/admin/ai/assistants/${selectedId}/default`)
      if (res.code !== 0 || !res.data) {
        setMessage({ type: 'error', text: res.message || '设置默认助手失败' })
        return
      }
      setMessage({ type: 'success', text: '默认助手已更新' })
      await loadAssistants(selectedId)
    } catch {
      setMessage({ type: 'error', text: '设置默认助手失败' })
    } finally {
      setSaving(false)
    }
  }

  const deleteAssistant = async () => {
    if (selectedId === 'new' || !selectedAssistant) return
    if (!window.confirm(`确定删除 AI 助手“${selectedAssistant.name}”吗？`)) return
    setSaving(true)
    try {
      const res = await api.delete(`/admin/ai/assistants/${selectedId}`)
      if (res.code !== 0) {
        setMessage({ type: 'error', text: res.message || '删除失败' })
        return
      }
      setMessage({ type: 'success', text: '助手已删除' })
      await loadAssistants()
    } catch {
      setMessage({ type: 'error', text: '删除失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <AdminShell title="AI 助手管理" description="维护多个模型端点、助手角色和默认调用配置">
      <section className="grid min-h-[620px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-slate-50 lg:border-b-0 lg:border-r">
          <div className="flex h-16 items-center justify-between border-b border-slate-200 px-4">
            <div>
              <div className="text-sm font-semibold text-slate-900">助手列表</div>
              <div className="mt-0.5 text-xs text-slate-500">{assistants.length} 个模型配置</div>
            </div>
            <button
              type="button"
              onClick={startCreate}
              disabled={saving || testing}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-950"
              title="新增 AI 助手"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[360px] overflow-y-auto p-2 lg:max-h-[554px]">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-slate-400">加载中...</div>
            ) : assistants.length === 0 ? (
              <button type="button" onClick={startCreate} className="w-full rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-sm text-slate-500">
                暂无助手，点击开始配置
              </button>
            ) : (
              <div className="space-y-1">
                {assistants.map((assistant) => (
                  <button
                    key={assistant.id}
                    type="button"
                    onClick={() => chooseAssistant(assistant)}
                    disabled={saving || testing}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${selectedId === assistant.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white'}`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selectedId === assistant.id ? 'bg-white/10' : 'bg-slate-100 text-slate-600'}`}>
                      <Bot className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{assistant.name}</span>
                        {assistant.is_default && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                      </span>
                      <span className={`mt-0.5 block truncate text-xs ${selectedId === assistant.id ? 'text-slate-300' : 'text-slate-500'}`}>
                        {assistant.provider === 'openai' ? 'OpenAI' : '第三方'} · {assistant.model}
                      </span>
                    </span>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${assistant.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div className="min-w-0">
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 md:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                {selectedId === 'new' ? '新增 AI 助手' : form.name || 'AI 助手配置'}
                {form.is_default && <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">默认</span>}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {form.provider === 'openai' ? 'OpenAI 官方 · Responses API' : `第三方兼容 · ${form.api_protocol === 'responses' ? 'Responses API' : 'Chat Completions'}`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {selectedId !== 'new' && !form.is_default && (
                <button type="button" onClick={() => void setDefault()} disabled={saving || testing || hasUnsavedChanges} title={hasUnsavedChanges ? '请先保存当前配置' : '设为默认助手'} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                  <Star className="h-4 w-4" />
                  设为默认
                </button>
              )}
              {selectedId !== 'new' && (
                <button type="button" onClick={() => void deleteAssistant()} disabled={saving || testing} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:opacity-50" title="删除助手">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <fieldset disabled={saving || testing} className="min-w-0 space-y-6 p-4 md:p-5">
            {message && (
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
                {message.type === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <CircleOff className="h-4 w-4 shrink-0" />}
                {message.text}
              </div>
            )}

            {testResult && (
              <div className="border-y border-slate-200 bg-slate-50 px-3 py-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Activity className="h-4 w-4 text-slate-500" />连接测试结果
                  </span>
                  <span className="text-xs text-slate-500">{testResult.provider === 'openai' ? 'OpenAI' : '第三方'} · {testResult.model} · {testResult.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-3 sm:divide-x sm:divide-slate-200">
                  <div className="flex items-center justify-between gap-3 sm:block sm:px-3 sm:first:pl-0">
                    <span className="text-xs text-slate-500">文本响应</span>
                    <span className={`text-sm font-semibold ${testResult.text_ok ? 'text-emerald-700' : 'text-rose-600'}`}>{testResult.text_ok ? '正常' : '失败'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:block sm:px-3">
                    <span className="text-xs text-slate-500">工具调用</span>
                    <span className={`text-sm font-semibold ${!form.supports_tools ? 'text-slate-500' : testResult.tool_call_ok ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {!form.supports_tools ? '未启用' : testResult.tool_call_ok ? '正常' : '未通过'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 sm:block sm:px-3">
                    <span className="text-xs text-slate-500">请求延迟</span>
                    <span className="text-sm font-semibold text-slate-800">{testResult.latency_ms.toLocaleString()} ms</span>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div>
                <div className="text-sm font-medium text-slate-700">接口提供商</div>
                <div className="mt-0.5 text-xs text-slate-500">官方模式固定使用 OpenAI Responses API；第三方模式可自定义协议和地址。</div>
              </div>
              <div className="grid max-w-xl grid-cols-2 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => updateProvider('openai')}
                  aria-pressed={form.provider === 'openai'}
                  className={`min-h-9 rounded-md px-3 text-sm font-medium transition ${form.provider === 'openai' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  OpenAI 官方
                </button>
                <button
                  type="button"
                  onClick={() => updateProvider('openai_compatible')}
                  aria-pressed={form.provider === 'openai_compatible'}
                  className={`min-h-9 rounded-md px-3 text-sm font-medium transition ${form.provider === 'openai_compatible' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  第三方兼容接口
                </button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">助手名称</span>
                <input value={form.name} onChange={(event) => updateField('name', event.target.value)} placeholder="例如：财务分析助手" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">模型名称</span>
                <input value={form.model} onChange={(event) => updateField('model', event.target.value)} placeholder="例如：gpt-5 或自定义模型名" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
              </label>
              <label className="space-y-1.5">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Gauge className="h-4 w-4 text-slate-400" />模型能力等级</span>
                <select value={form.reasoning_effort} onChange={(event) => updateField('reasoning_effort', event.target.value as AIAssistant['reasoning_effort'])} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100">
                  {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>

            {form.provider === 'openai_compatible' && (
              <div className="space-y-2">
                <div>
                  <div className="text-sm font-medium text-slate-700">API 协议</div>
                  <div className="mt-0.5 text-xs text-slate-500">按第三方服务商实际兼容的接口选择。</div>
                </div>
                <div className="grid max-w-xl grid-cols-2 rounded-lg bg-slate-100 p-1">
                  <button type="button" onClick={() => updateField('api_protocol', 'responses')} aria-pressed={form.api_protocol === 'responses'} className={`min-h-9 rounded-md px-3 text-sm font-medium transition ${form.api_protocol === 'responses' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>Responses</button>
                  <button type="button" onClick={() => updateField('api_protocol', 'chat_completions')} aria-pressed={form.api_protocol === 'chat_completions'} className={`min-h-9 rounded-md px-3 text-sm font-medium transition ${form.api_protocol === 'chat_completions' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>Chat Completions</button>
                </div>
              </div>
            )}

            <label className="block space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Server className="h-4 w-4 text-slate-400" />API 端点</span>
              <input
                value={form.endpoint}
                readOnly={form.provider === 'openai'}
                onChange={(event) => updateField('endpoint', event.target.value)}
                placeholder="https://your-provider.example/v1"
                className={`h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 ${form.provider === 'openai' ? 'cursor-not-allowed bg-slate-50 text-slate-500' : 'bg-white'}`}
              />
              <span className="block text-xs text-slate-500">{form.provider === 'openai' ? '官方接口地址由系统固定管理。' : '填写 API 根地址，系统会按所选协议补全请求路径。'}</span>
            </label>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><KeyRound className="h-4 w-4 text-slate-400" />API 密钥</span>
                {selectedId !== 'new' && selectedAssistant?.has_api_key && form.provider === 'openai_compatible' && !thirdPartyCredentialBoundaryChanged && (
                  <button
                    type="button"
                    onClick={() => updateField('clear_api_key', !form.clear_api_key)}
                    className={`text-xs font-medium transition ${form.clear_api_key ? 'text-slate-600 hover:text-slate-950' : 'text-rose-600 hover:text-rose-700'}`}
                  >
                    {form.clear_api_key ? '撤销清除' : '清除已保存密钥'}
                  </button>
                )}
              </div>
              <input
                type="password"
                value={form.api_key}
                disabled={form.clear_api_key}
                onChange={(event) => updateAPIKey(event.target.value)}
                placeholder={form.clear_api_key ? '保存后将清除密钥' : requiresNewOpenAIKey ? 'OpenAI API Key（必填）' : thirdPartyCredentialBoundaryChanged ? '新端点密钥（可留空）' : selectedAssistant?.has_api_key ? '已保存，留空表示保持不变' : '私有或本地端点可留空'}
                className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:bg-rose-50 disabled:text-rose-600"
              />
              <span className="block text-xs text-slate-500">
                {form.provider === 'openai' && !requiresNewOpenAIKey && selectedAssistant?.has_api_key
                  ? '官方配置必须保留密钥；留空保持原密钥，输入新值可替换。'
                  : requiresNewOpenAIKey
                    ? '新建官方配置或从第三方接口切换时，必须输入对应的 OpenAI API 密钥。'
                  : thirdPartyCredentialBoundaryChanged
                    ? '提供商或端点已变更，旧密钥不会沿用；留空保存将清除旧密钥。'
                  : form.clear_api_key
                    ? '保存配置时会显式移除当前密钥。'
                    : '已有密钥不会回显，留空保存不会覆盖。'}
              </span>
            </div>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">用途说明</span>
              <input value={form.description} onChange={(event) => updateField('description', event.target.value)} placeholder="说明该助手适合处理的业务" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">助手补充提示词</span>
              <textarea value={form.system_prompt} onChange={(event) => updateField('system_prompt', event.target.value)} rows={5} placeholder="例如：优先使用会计口径分析收入、成本、现金流，并标记数据来源。权限规则始终由系统强制执行。" className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700"><Wrench className="h-4 w-4 text-slate-400" />模型能力</div>
              <div className="grid gap-3 md:grid-cols-3">
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${form.supports_vision ? 'border-sky-200 bg-sky-50' : 'border-slate-200'}`}>
                  <input type="checkbox" checked={form.supports_vision} onChange={(event) => updateField('supports_vision', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-400" />
                  <span><span className="block text-sm font-medium text-slate-800">支持图片理解</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">允许频道机器人读取上传图片和图库图片。</span></span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${form.supports_files ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'}`}>
                  <input type="checkbox" checked={form.supports_files} onChange={(event) => updateField('supports_files', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-400" />
                  <span><span className="block text-sm font-medium text-slate-800">支持文件读取</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">允许读取文本、CSV、JSON 和 Excel 文件内容。</span></span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${form.supports_tools ? 'border-violet-200 bg-violet-50' : 'border-slate-200'}`}>
                  <input type="checkbox" checked={form.supports_tools} onChange={(event) => updateField('supports_tools', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-400" />
                  <span><span className="block text-sm font-medium text-slate-800">支持工具调用</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">允许 AI Agent 查询业务数据并执行已授权操作。</span></span>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-4">
              <label className="inline-flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.enabled} disabled={form.is_default} onChange={(event) => updateField('enabled', event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400" />
                <span>
                  <span className="block text-sm font-medium text-slate-800">允许员工使用</span>
                  <span className="block text-xs text-slate-500">停用后不会出现在聊天助手选择列表</span>
                </span>
              </label>
              <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
                <button
                  type="button"
                  onClick={() => void testAssistant()}
                  disabled={selectedId === 'new' || hasUnsavedChanges || saving || testing}
                  title={selectedId === 'new' || hasUnsavedChanges ? '请先保存当前配置' : '测试文本响应、工具调用和请求延迟'}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                  {testing ? '测试中...' : '测试连接'}
                </button>
                <button type="button" onClick={() => void saveAssistant()} disabled={saving || testing} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {saving ? '保存中...' : selectedId === 'new' ? '创建助手' : '保存配置'}
                </button>
              </div>
            </div>
          </fieldset>
        </div>
      </section>
    </AdminShell>
  )
}
