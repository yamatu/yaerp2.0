'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  CircleOff,
  KeyRound,
  Plus,
  Save,
  Server,
  Star,
  Trash2,
} from 'lucide-react'
import api from '@/lib/api'
import { AdminShell } from '@/components/admin/AdminShell'
import type { AIAssistant } from '@/types'

interface AssistantForm {
  name: string
  description: string
  endpoint: string
  model: string
  api_key: string
  system_prompt: string
  enabled: boolean
  is_default: boolean
  supports_vision: boolean
  supports_files: boolean
}

const emptyForm: AssistantForm = {
  name: '',
  description: '',
  endpoint: '',
  model: '',
  api_key: '',
  system_prompt: '',
  enabled: true,
  is_default: false,
  supports_vision: false,
  supports_files: false,
}

function assistantToForm(assistant: AIAssistant): AssistantForm {
  return {
    name: assistant.name,
    description: assistant.description || '',
    endpoint: assistant.endpoint || '',
    model: assistant.model,
    api_key: '',
    system_prompt: assistant.system_prompt || '',
    enabled: assistant.enabled,
    is_default: assistant.is_default,
    supports_vision: assistant.supports_vision,
    supports_files: assistant.supports_files,
  }
}

export default function AdminAIPage() {
  const [assistants, setAssistants] = useState<AIAssistant[]>([])
  const [selectedId, setSelectedId] = useState<number | 'new'>('new')
  const [form, setForm] = useState<AssistantForm>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
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
        setSelectedId(next.id)
        setForm(assistantToForm(next))
      } else {
        setSelectedId('new')
        setForm(emptyForm)
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
    setSelectedId(assistant.id)
    setForm(assistantToForm(assistant))
    setMessage(null)
  }

  const startCreate = () => {
    setSelectedId('new')
    setForm({ ...emptyForm, is_default: assistants.length === 0 })
    setMessage(null)
  }

  const updateField = <K extends keyof AssistantForm>(key: K, value: AssistantForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const saveAssistant = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || !form.model.trim()) {
      setMessage({ type: 'error', text: '请填写助手名称、API 端点和模型名称' })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
        endpoint: form.endpoint.trim(),
        model: form.model.trim(),
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
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition ${selectedId === assistant.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white'}`}
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
                        {assistant.model}
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
              <div className="mt-0.5 truncate text-xs text-slate-500">OpenAI 兼容的 Chat Completions 接口</div>
            </div>
            <div className="flex items-center gap-2">
              {selectedId !== 'new' && !form.is_default && (
                <button type="button" onClick={() => void setDefault()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
                  <Star className="h-4 w-4" />
                  设为默认
                </button>
              )}
              {selectedId !== 'new' && (
                <button type="button" onClick={() => void deleteAssistant()} disabled={saving} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-600 transition hover:bg-rose-50 disabled:opacity-50" title="删除助手">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="space-y-6 p-4 md:p-5">
            {message && (
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
                {message.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <CircleOff className="h-4 w-4" />}
                {message.text}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">助手名称</span>
                <input value={form.name} onChange={(event) => updateField('name', event.target.value)} placeholder="例如：财务分析助手" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-medium text-slate-700">模型名称</span>
                <input value={form.model} onChange={(event) => updateField('model', event.target.value)} placeholder="gpt-4o-mini" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Server className="h-4 w-4 text-slate-400" />API 端点</span>
              <input value={form.endpoint} onChange={(event) => updateField('endpoint', event.target.value)} placeholder="https://api.openai.com/v1" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <label className="block space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><KeyRound className="h-4 w-4 text-slate-400" />API 密钥</span>
              <input type="password" value={form.api_key} onChange={(event) => updateField('api_key', event.target.value)} placeholder={selectedAssistant?.has_api_key ? '已保存，留空表示不修改' : '可选，私有本地端点可留空'} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">用途说明</span>
              <input value={form.description} onChange={(event) => updateField('description', event.target.value)} placeholder="说明该助手适合处理的业务" className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-700">助手补充提示词</span>
              <textarea value={form.system_prompt} onChange={(event) => updateField('system_prompt', event.target.value)} rows={5} placeholder="例如：优先使用会计口径分析收入、成本、现金流，并标记数据来源。权限规则始终由系统强制执行。" className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2.5 text-sm leading-6 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100" />
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${form.supports_vision ? 'border-sky-200 bg-sky-50' : 'border-slate-200'}`}>
                <input type="checkbox" checked={form.supports_vision} onChange={(event) => updateField('supports_vision', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-400" />
                <span><span className="block text-sm font-medium text-slate-800">支持图片理解</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">允许频道机器人读取上传图片和图库图片。</span></span>
              </label>
              <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${form.supports_files ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'}`}>
                <input type="checkbox" checked={form.supports_files} onChange={(event) => updateField('supports_files', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-400" />
                <span><span className="block text-sm font-medium text-slate-800">支持文件读取</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">允许读取文本、CSV、JSON 和 Excel 文件内容。</span></span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-4">
              <label className="inline-flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={form.enabled} disabled={form.is_default} onChange={(event) => updateField('enabled', event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-400" />
                <span>
                  <span className="block text-sm font-medium text-slate-800">允许员工使用</span>
                  <span className="block text-xs text-slate-500">停用后不会出现在聊天助手选择列表</span>
                </span>
              </label>
              <button type="button" onClick={() => void saveAssistant()} disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                <Save className="h-4 w-4" />
                {saving ? '保存中...' : selectedId === 'new' ? '创建助手' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </AdminShell>
  )
}
