'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, AlertTriangle, Bot, CheckCircle2, KeyRound, Plus, RefreshCw, Save, Server, Star, Trash2, Wrench, XCircle } from 'lucide-react'
import api from '@/lib/api'
import { AdminShell } from '@/components/admin/AdminShell'
import { aiHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  CheckboxRow,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  Notice,
  SectionCard,
  Segmented,
  SelectInput,
  StatGrid,
  StatusBadge,
  StickyActions,
  SwitchField,
  TextArea,
  TextInput,
} from '@/components/admin/ui'
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

const OPENAI_ENDPOINT = 'https://api.openai.com/v1'

const emptyForm: AssistantForm = {
  name: '',
  description: '',
  provider: 'openai_compatible',
  api_protocol: 'chat_completions',
  endpoint: '',
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
    endpoint: provider === 'openai' ? OPENAI_ENDPOINT : assistant.endpoint || '',
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
  { value: 'auto', label: '自动适配（推荐）' },
  { value: 'none', label: '不启用推理' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '最高' },
]

const fingerprintOf = (form: AssistantForm) => JSON.stringify(form)
const normalizeEndpoint = (value: string) => value.trim().replace(/\/+$/, '')

export default function AdminAIPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [assistants, setAssistants] = useState<AIAssistant[]>([])
  const [selectedId, setSelectedId] = useState<number | 'new'>('new')
  const [form, setForm] = useState<AssistantForm>(emptyForm)
  const [savedFingerprint, setSavedFingerprint] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AssistantTestResult | null>(null)
  const [formError, setFormError] = useState('')
  const editorRef = useRef<HTMLDivElement>(null)

  const selectedAssistant = useMemo(() => assistants.find((assistant) => assistant.id === selectedId) || null, [assistants, selectedId])

  const loadAssistants = useCallback(async (preferredId?: number) => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await api.get<AIAssistant[]>('/admin/ai/assistants')
      ensureOk(res, '加载 AI 助手失败')
      const items = Array.isArray(res.data) ? res.data : []
      setAssistants(items)
      const next = preferredId ? items.find((assistant) => assistant.id === preferredId) : items.find((assistant) => assistant.is_default) || items[0]
      if (next) {
        const nextForm = assistantToForm(next)
        setSelectedId(next.id)
        setForm(nextForm)
        setSavedFingerprint(fingerprintOf(nextForm))
      } else {
        setSelectedId('new')
        setForm({ ...emptyForm, is_default: true })
        setSavedFingerprint('')
      }
    } catch (error) {
      setLoadError(errorText(error, '加载 AI 助手失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAssistants()
  }, [loadAssistants])

  const hasUnsavedChanges = selectedId === 'new' || fingerprintOf(form) !== savedFingerprint

  const confirmDiscard = async () => {
    if (!hasUnsavedChanges || (selectedId === 'new' && !form.name && !form.model)) return true
    return confirm({ title: '放弃未保存的修改？', message: '当前助手配置有修改尚未保存。', confirmText: '放弃修改' })
  }

  const scrollToEditor = () => {
    if (window.matchMedia('(max-width: 1023px)').matches) window.setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const chooseAssistant = async (assistant: AIAssistant) => {
    if (assistant.id === selectedId) return scrollToEditor()
    if (!(await confirmDiscard())) return
    const nextForm = assistantToForm(assistant)
    setSelectedId(assistant.id)
    setForm(nextForm)
    setSavedFingerprint(fingerprintOf(nextForm))
    setTestResult(null)
    setFormError('')
    scrollToEditor()
  }

  const startCreate = async () => {
    if (!(await confirmDiscard())) return
    setSelectedId('new')
    setForm({ ...emptyForm, is_default: assistants.length === 0 })
    setSavedFingerprint('')
    setTestResult(null)
    setFormError('')
    scrollToEditor()
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
        endpoint: provider === 'openai' ? OPENAI_ENDPOINT : selectedAssistant?.provider === 'openai_compatible' ? selectedAssistant.endpoint || '' : '',
        api_key: '',
        clear_api_key: false,
      }
    })
    setTestResult(null)
  }

  const requiresNewOpenAIKey = form.provider === 'openai' && (selectedId === 'new' || selectedAssistant?.provider !== 'openai' || !selectedAssistant?.has_api_key)
  const credentialBoundaryChanged =
    form.provider === 'openai_compatible' &&
    selectedId !== 'new' &&
    Boolean(selectedAssistant?.has_api_key) &&
    (selectedAssistant?.provider !== 'openai_compatible' || normalizeEndpoint(selectedAssistant.endpoint || '') !== normalizeEndpoint(form.endpoint))

  const keyHint =
    form.provider === 'openai' && !requiresNewOpenAIKey && selectedAssistant?.has_api_key
      ? '已保存密钥（不回显）。留空表示保持不变，输入新值则替换。'
      : requiresNewOpenAIKey
        ? '新建官方配置或从第三方切换到官方时，必须输入 OpenAI API 密钥。'
        : credentialBoundaryChanged
          ? '提供商或端点已变更：旧密钥不会沿用，留空保存将清除旧密钥。'
          : form.clear_api_key
            ? '保存时会删除当前已保存的密钥。'
            : selectedAssistant?.has_api_key
              ? '已保存密钥（不回显）。留空表示保持不变。'
              : '本地或内网端点可以不填密钥。'

  const saveAssistant = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || !form.model.trim()) {
      setFormError('请填写助手名称、API 端点和模型名称')
      return
    }
    if (requiresNewOpenAIKey && !form.api_key.trim()) {
      setFormError('OpenAI 官方接口必须填写 API 密钥')
      return
    }
    if (form.is_default && !form.enabled) {
      setFormError('默认助手不能停用，请先把其他助手设为默认')
      return
    }
    setSaving(true)
    setTestResult(null)
    setFormError('')
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
      const res = selectedId === 'new' ? await api.post<AIAssistant>('/admin/ai/assistants', payload) : await api.put<AIAssistant>(`/admin/ai/assistants/${selectedId}`, payload)
      ensureOk(res, '保存失败')
      toast.success(selectedId === 'new' ? '助手已创建，建议立即“测试连接”' : '配置已保存')
      await loadAssistants(res.data?.id)
    } catch (error) {
      setFormError(errorText(error, '保存失败，请检查端点配置'))
    } finally {
      setSaving(false)
    }
  }

  const testAssistant = async () => {
    if (selectedId === 'new' || hasUnsavedChanges) {
      toast.warning('请先保存当前配置，再测试连接')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.post<AssistantTestResult>(`/admin/ai/assistants/${selectedId}/test`)
      ensureOk(res, '连接测试失败')
      setTestResult(res.data || null)
      if (res.data?.text_ok) toast.success('模型连接正常')
      else toast.error('模型未返回有效文本，请检查模型名称')
    } catch (error) {
      toast.error(errorText(error, '连接测试失败，请检查密钥、端点和模型名称'))
    } finally {
      setTesting(false)
    }
  }

  const setDefault = async () => {
    if (selectedId === 'new') return
    setSaving(true)
    try {
      ensureOk(await api.post<AIAssistant>(`/admin/ai/assistants/${selectedId}/default`), '设置默认助手失败')
      toast.success('默认助手已更新')
      await loadAssistants(selectedId)
    } catch (error) {
      toast.error(errorText(error, '设置默认助手失败'))
    } finally {
      setSaving(false)
    }
  }

  const deleteAssistant = async () => {
    if (selectedId === 'new' || !selectedAssistant) return
    const otherEnabled = assistants.filter((item) => item.id !== selectedAssistant.id && item.enabled)
    const ok = await confirm({
      title: `删除 AI 助手「${selectedAssistant.name}」？`,
      consequences: [
        '员工将无法再选择这个助手，正在使用它的对话需要切换助手',
        '已保存的 API 密钥会一并删除',
        selectedAssistant.is_default
          ? otherEnabled.length
            ? `这是默认助手，删除后系统会自动把「${[...otherEnabled].sort((a, b) => a.id - b.id)[0].name}」设为默认`
            : '这是唯一启用的助手，删除后员工将无法使用 AI 功能'
          : '不影响默认助手',
      ],
      confirmText: '删除助手',
    })
    if (!ok) return
    setSaving(true)
    try {
      ensureOk(await api.delete(`/admin/ai/assistants/${selectedId}`), '删除失败')
      toast.success('助手已删除')
      await loadAssistants()
    } catch (error) {
      toast.error(errorText(error, '删除失败'))
    } finally {
      setSaving(false)
    }
  }

  const enabledCount = assistants.filter((item) => item.enabled).length
  const defaultAssistant = assistants.find((item) => item.is_default)
  const busy = saving || testing

  return (
    <AdminShell
      title="AI 助手"
      description="模型接口、密钥、默认助手与能力开关"
      help={aiHelp}
      actions={
        <Button variant="primary" icon={Plus} onClick={() => void startCreate()} disabled={busy}>
          <span className="hidden sm:inline">新增助手</span>
          <span className="sm:hidden">新增</span>
        </Button>
      }
    >
      <StatGrid
        items={[
          { label: '助手总数', value: assistants.length, icon: Bot },
          { label: '允许员工使用', value: enabledCount, icon: CheckCircle2, tone: 'emerald' },
          { label: '默认助手', value: defaultAssistant?.name || '未设置', icon: Star, tone: defaultAssistant ? 'amber' : 'rose' },
          { label: '支持工具调用', value: assistants.filter((item) => item.supports_tools).length, icon: Wrench, tone: 'violet' },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadAssistants()}>重试</Button>}>
          {loadError}
        </Notice>
      )}
      {!loading && assistants.length === 0 && !loadError && (
        <Notice tone="warning" title="还没有可用的 AI 助手">员工目前无法使用任何 AI 功能。在下方填写第一个助手的配置并保存，它会自动成为默认助手。</Notice>
      )}

      <div className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
        <SectionCard title="助手列表" description="★ 为默认助手；灰点表示已停用" icon={Bot} flush className="lg:sticky lg:top-[84px] lg:self-start">
          {loading && assistants.length === 0 ? (
            <LoadingState compact />
          ) : assistants.length === 0 ? (
            <EmptyState compact icon={Bot} title="暂无助手" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {assistants.map((assistant) => (
                <li key={assistant.id}>
                  <button
                    type="button"
                    onClick={() => void chooseAssistant(assistant)}
                    disabled={busy}
                    className={`flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition disabled:opacity-60 ${selectedId === assistant.id ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                      <Bot className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-slate-900">{assistant.name}</span>
                        {assistant.is_default && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {assistant.provider === 'openai' ? 'OpenAI 官方' : '第三方'} · {assistant.model}
                      </span>
                    </span>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${assistant.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} title={assistant.enabled ? '已启用' : '已停用'} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div ref={editorRef} className="min-w-0 scroll-mt-32 space-y-3">
          <SectionCard
            title={selectedId === 'new' ? '新增 AI 助手' : form.name || 'AI 助手配置'}
            description={form.provider === 'openai' ? 'OpenAI 官方 · Responses API' : `第三方兼容 · ${form.api_protocol === 'responses' ? 'Responses API' : 'Chat Completions'}`}
            icon={Bot}
            iconTone="violet"
            actions={
              selectedId !== 'new' && (
                <>
                  {form.is_default ? (
                    <StatusBadge tone="amber">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      默认助手
                    </StatusBadge>
                  ) : (
                    <Button size="sm" icon={Star} onClick={() => void setDefault()} disabled={busy || hasUnsavedChanges || !form.enabled} title={hasUnsavedChanges ? '请先保存当前配置' : !form.enabled ? '停用的助手不能设为默认' : '设为默认助手'}>
                      设为默认
                    </Button>
                  )}
                  <IconButton icon={Trash2} label="删除助手" variant="danger-outline" className="md:h-8 md:w-8" disabled={busy} onClick={() => void deleteAssistant()} />
                </>
              )
            }
          >
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              {formError && <Notice tone="danger" onClose={() => setFormError('')}>{formError}</Notice>}

              {testResult && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-slate-800">
                    <span className="inline-flex items-center gap-2">
                      <Activity className="h-4 w-4 text-slate-500" />
                      连接测试结果
                    </span>
                    <span className="text-xs font-normal text-slate-500">{testResult.model}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge tone={testResult.text_ok ? 'emerald' : 'rose'}>
                      {testResult.text_ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      文本响应{testResult.text_ok ? '正常' : '失败'}
                    </StatusBadge>
                    <StatusBadge tone={!form.supports_tools ? 'slate' : testResult.tool_call_ok ? 'emerald' : 'amber'}>
                      工具调用{!form.supports_tools ? '未启用' : testResult.tool_call_ok ? '正常' : '未通过'}
                    </StatusBadge>
                    <StatusBadge tone="slate">延迟 {testResult.latency_ms.toLocaleString()} ms</StatusBadge>
                  </div>
                  {form.supports_tools && !testResult.tool_call_ok && testResult.text_ok && (
                    <p className="mt-2 text-xs text-amber-700">模型能对话但没有正确调用工具，AI 将无法查询或修改业务数据。可换用支持函数调用的模型，或关闭“工具调用”。</p>
                  )}
                </div>
              )}

              <Field label="接口提供商" group hint="OpenAI 官方固定地址和协议；其他兼容 OpenAI 协议的服务（云模型、本地 Ollama / vLLM 等）选“第三方兼容接口”。">
                <Segmented
                  value={form.provider}
                  onChange={updateProvider}
                  options={[
                    { value: 'openai_compatible', label: '第三方兼容接口' },
                    { value: 'openai', label: 'OpenAI 官方' },
                  ]}
                />
              </Field>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="助手名称" required hint="员工在助手选择列表中看到的名字。">
                  <TextInput value={form.name} onChange={(event) => updateField('name', event.target.value)} placeholder="例如：财务分析助手" />
                </Field>
                <Field label="模型名称" required hint="与服务商文档中的模型 ID 完全一致。">
                  <TextInput value={form.model} onChange={(event) => updateField('model', event.target.value)} placeholder="例如：gpt-5 / deepseek-chat / qwen-max" className="font-mono" />
                </Field>
              </div>

              {form.provider === 'openai_compatible' && (
                <Field label="API 协议" group hint="按服务商实际支持的接口选择；不确定时选 Chat Completions。">
                  <Segmented
                    value={form.api_protocol}
                    onChange={(value) => updateField('api_protocol', value)}
                    options={[
                      { value: 'chat_completions', label: 'Chat Completions' },
                      { value: 'responses', label: 'Responses' },
                    ]}
                  />
                </Field>
              )}

              <Field
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <Server className="h-3.5 w-3.5" />
                    API 端点
                  </span>
                }
                required
                hint={form.provider === 'openai' ? '官方接口地址由系统固定。' : '填写 API 根地址（通常以 /v1 结尾），系统会按协议补全请求路径。'}
              >
                <TextInput value={form.endpoint} readOnly={form.provider === 'openai'} onChange={(event) => updateField('endpoint', event.target.value)} placeholder="https://your-provider.example/v1" className={`font-mono ${form.provider === 'openai' ? 'bg-slate-50 text-slate-500' : ''}`} />
              </Field>

              <Field
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5" />
                    API 密钥
                  </span>
                }
                required={requiresNewOpenAIKey}
                hint={keyHint}
                aside={
                  selectedId !== 'new' && selectedAssistant?.has_api_key && form.provider === 'openai_compatible' && !credentialBoundaryChanged ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault()
                        updateField('clear_api_key', !form.clear_api_key)
                      }}
                      className={`inline-flex h-7 items-center rounded-md px-1.5 text-xs font-medium ${form.clear_api_key ? 'text-slate-600 hover:bg-slate-100' : 'text-rose-600 hover:bg-rose-50'}`}
                    >
                      {form.clear_api_key ? '撤销清除' : '清除已保存密钥'}
                    </button>
                  ) : undefined
                }
              >
                <TextInput
                  type="password"
                  value={form.api_key}
                  disabled={form.clear_api_key}
                  autoComplete="new-password"
                  onChange={(event) => {
                    const value = event.target.value
                    setForm((current) => ({ ...current, api_key: value, clear_api_key: value.trim() ? false : current.clear_api_key }))
                    setTestResult(null)
                  }}
                  placeholder={form.clear_api_key ? '保存后将清除密钥' : requiresNewOpenAIKey ? 'sk-…（必填）' : selectedAssistant?.has_api_key && !credentialBoundaryChanged ? '已保存，留空保持不变' : '可留空'}
                />
              </Field>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="推理强度" hint="越高越慢、成本越高，适合复杂分析；不支持推理参数的模型请选“不启用推理”。">
                  <SelectInput value={form.reasoning_effort} onChange={(event) => updateField('reasoning_effort', event.target.value as AIAssistant['reasoning_effort'])}>
                    {reasoningOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <Field label="用途说明" hint="显示给员工，帮助他们选择合适的助手。">
                  <TextInput value={form.description} onChange={(event) => updateField('description', event.target.value)} placeholder="例如：擅长报价核算与毛利分析" />
                </Field>
              </div>

              <Field label="补充提示词" hint="追加在系统提示之后，用于规定口径、语气、业务术语；无法绕过系统的权限控制。">
                <TextArea rows={4} value={form.system_prompt} onChange={(event) => updateField('system_prompt', event.target.value)} placeholder="例如：金额统一使用人民币并保留两位小数；回答时注明数据来自哪张表。" />
              </Field>

              <Field label="模型能力" group hint="只勾选模型真正支持的能力，否则员工使用时会报错。">
                <div className="grid gap-2 md:grid-cols-3">
                  <CheckboxRow checked={form.supports_tools} onChange={(value) => updateField('supports_tools', value)} label="工具调用" hint="允许 AI 查询表格、执行已授权的修改。关闭后只能对话。" />
                  <CheckboxRow checked={form.supports_vision} onChange={(value) => updateField('supports_vision', value)} label="图片理解" hint="读取员工上传或图库中的图片。" />
                  <CheckboxRow checked={form.supports_files} onChange={(value) => updateField('supports_files', value)} label="文件读取" hint="读取文本、CSV、JSON、Excel 文件内容。" />
                </div>
              </Field>

              <SwitchField
                label="允许员工使用"
                hint={form.is_default ? '默认助手必须保持启用；如需停用，请先把其他助手设为默认。' : form.enabled ? '员工可以在助手列表中选择它。' : '已停用：不会出现在员工的助手列表中。'}
                checked={form.enabled}
                disabled={form.is_default}
                onChange={(value) => updateField('enabled', value)}
              />
              {form.provider === 'openai_compatible' && /localhost|127\.0\.0\.1/.test(form.endpoint) && (
                <Notice tone="warning">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  端点指向 localhost：这是指<strong>后端服务器</strong>本机（Docker 中为后端容器），不是你的电脑。
                </Notice>
              )}
            </fieldset>
          </SectionCard>

          <StickyActions pinned={hasUnsavedChanges && (selectedId !== 'new' || Boolean(form.name || form.model))} note={hasUnsavedChanges && selectedId !== 'new' ? <span className="text-amber-700">有未保存的修改；测试连接使用已保存的配置</span> : selectedId === 'new' ? '创建后可测试连接' : '测试会发送一条极短的请求，消耗少量 Token'}>
            <Button icon={Activity} loading={testing} disabled={selectedId === 'new' || hasUnsavedChanges || saving} onClick={() => void testAssistant()} title={selectedId === 'new' || hasUnsavedChanges ? '请先保存当前配置' : '测试文本响应、工具调用和延迟'}>
              测试连接
            </Button>
            <Button variant="primary" icon={Save} loading={saving} disabled={testing || !hasUnsavedChanges} onClick={() => void saveAssistant()}>
              {selectedId === 'new' ? '创建助手' : '保存配置'}
            </Button>
          </StickyActions>
        </div>
      </div>
    </AdminShell>
  )
}
