'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Languages, Save, Trash2 } from 'lucide-react'
import api from '@/lib/api'
import { ensureOk, errorText } from '@/components/admin/adminApi'
import { useToast } from '@/components/admin/feedback'
import { Button, Field, Notice, SectionCard, StatusBadge, TextInput } from '@/components/admin/ui'

interface TranslationEngineConfig {
  enabled: boolean
  endpoint?: string
  model?: string
}

interface TranslationEngineTestResult {
  model: string
  latency_ms: number
  sample: string
  translation: string
}

const normalize = (value: string) => value.trim().replace(/\/+$/, '')

export function TranslationEngineCard() {
  const toast = useToast()
  const [config, setConfig] = useState<TranslationEngineConfig>({ enabled: false })
  const [endpoint, setEndpoint] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TranslationEngineTestResult | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const res = await api.get<TranslationEngineConfig>('/admin/ai/translation-engine')
    if (res.code === 0 && res.data) {
      setConfig(res.data)
      setEndpoint(res.data.endpoint || '')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (value: string) => {
    setSaving(true)
    setError('')
    setTestResult(null)
    try {
      const res = await api.put<TranslationEngineConfig>('/admin/ai/translation-engine', { endpoint: value.trim() })
      ensureOk(res, '保存翻译接口失败')
      const next = res.data || { enabled: false }
      setConfig(next)
      setEndpoint(next.endpoint || '')
      toast.success(next.enabled ? `已连接翻译模型 ${next.model}` : '已停用翻译引擎，翻译将改用 AI 助手')
    } catch (err) {
      setError(errorText(err, '保存翻译接口失败，请检查地址'))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const res = await api.post<TranslationEngineTestResult>('/admin/ai/translation-engine/test')
      ensureOk(res, '翻译测试失败')
      setTestResult(res.data || null)
    } catch (err) {
      setError(errorText(err, '翻译测试失败'))
    } finally {
      setTesting(false)
    }
  }

  const dirty = normalize(endpoint) !== normalize(config.endpoint || '')
  const busy = saving || testing

  return (
    <SectionCard
      title="翻译引擎"
      description="填写 OpenAI 兼容的翻译接口地址，邮件和频道翻译默认使用它；留空则使用 AI 助手翻译"
      icon={Languages}
      iconTone="violet"
      actions={config.enabled ? <StatusBadge tone="emerald"><CheckCircle2 className="h-3 w-3" />{config.model}</StatusBadge> : <StatusBadge tone="slate">未启用</StatusBadge>}
    >
      <div className="space-y-3">
        {error && <Notice tone="danger" onClose={() => setError('')}>{error}</Notice>}
        <Field label="接口地址" hint="例如 https://index-translate.bilibili.com/v1 ，保存时会自动识别模型。">
          <TextInput value={endpoint} disabled={busy} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://your-translate.example/v1" className="font-mono" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={Save} loading={saving} disabled={busy || !dirty || !endpoint.trim()} onClick={() => void save(endpoint)}>
            保存
          </Button>
          <Button icon={Activity} loading={testing} disabled={busy || dirty || !config.enabled} onClick={() => void test()} title={dirty ? '请先保存地址' : '发送一段示例文本测试翻译'}>
            测试翻译
          </Button>
          {config.enabled && (
            <Button icon={Trash2} disabled={busy} onClick={() => void save('')}>
              停用
            </Button>
          )}
        </div>
        {testResult && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="mb-2 flex flex-wrap gap-2">
              <StatusBadge tone="emerald"><CheckCircle2 className="h-3 w-3" />翻译正常</StatusBadge>
              <StatusBadge tone="slate">延迟 {testResult.latency_ms.toLocaleString()} ms</StatusBadge>
            </div>
            <div className="whitespace-pre-wrap text-slate-500">{testResult.sample}</div>
            <div className="mt-1 whitespace-pre-wrap text-slate-900">{testResult.translation}</div>
          </div>
        )}
      </div>
    </SectionCard>
  )
}
