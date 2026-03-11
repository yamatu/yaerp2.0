'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  RefreshCw,
  Save,
  Sparkles,
  Wand2,
  XCircle,
} from 'lucide-react'
import api from '@/lib/api'
import { AuthGuard } from '@/components/auth/AuthGuard'
import type { AIConfigStatus, AISpreadsheetOperation, AISpreadsheetPlanResponse, Workbook } from '@/types'

function getOperationTitle(operation: AISpreadsheetOperation) {
  switch (operation.kind) {
    case 'insert_row':
      return `新增第 ${(operation.row ?? 0) + 1} 行`
    case 'delete_row':
      return `删除第 ${(operation.row ?? 0) + 1} 行`
    case 'insert_column':
      return `新增列 ${operation.column_name || operation.column_key || '未命名列'}`
    case 'fill_formula':
      return `公式填充 ${operation.column_name || operation.column_key || '目标列'}`
    default:
      return `修改第 ${(operation.row ?? 0) + 1} 行 / ${operation.column_name || operation.column_key || '单元格'}`
  }
}

function getOperationDetail(operation: AISpreadsheetOperation) {
  switch (operation.kind) {
    case 'insert_row':
      return `新行内容：${JSON.stringify(operation.row_values || {}, null, 0)}`
    case 'delete_row':
      return '删除指定数据行'
    case 'insert_column':
      return `列 key：${operation.column_key || '-'} / 类型：${operation.column_type || 'text'} / 插入位置：${operation.insert_after_column_key ? `在 ${operation.insert_after_column_key} 后` : '追加到末尾'}`
    case 'fill_formula':
      return `范围：第 ${(operation.start_row ?? 0) + 1} 行到第 ${(operation.end_row ?? operation.start_row ?? 0) + 1} 行 / 模板：${operation.formula_template || ''}`
    default:
      return `当前值：${String(operation.current_value ?? '空')} / 新值：${String(operation.value ?? '空')}`
  }
}

export default function AdminAIPage() {
  const router = useRouter()
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [configured, setConfigured] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [selectedWorkbookId, setSelectedWorkbookId] = useState<number | null>(null)
  const [selectedWorkbookDetail, setSelectedWorkbookDetail] = useState<Workbook | null>(null)
  const [selectedSheetIds, setSelectedSheetIds] = useState<number[]>([])
  const [loadingWorkbooks, setLoadingWorkbooks] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [planError, setPlanError] = useState('')
  const [planResult, setPlanResult] = useState<AISpreadsheetPlanResponse | null>(null)

  const selectedWorkbook = useMemo(
    () => workbooks.find((workbook) => workbook.id === selectedWorkbookId) || null,
    [selectedWorkbookId, workbooks]
  )

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await api.get<AIConfigStatus>('/admin/ai/config')
        const data = res.data
        setEndpoint(data?.endpoint || '')
        setModel(data?.model || '')
        setConfigured(Boolean(data?.configured))
      } catch {
        setConfigured(false)
      } finally {
        setLoading(false)
      }
    }

    const loadWorkbooks = async () => {
      setLoadingWorkbooks(true)
      try {
        const res = await api.get<Workbook[]>('/workbooks')
        const data = Array.isArray(res.data) ? res.data : []
        setWorkbooks(data)
        if (data.length > 0) {
          setSelectedWorkbookId((current) => current ?? data[0].id)
        }
      } catch (err) {
        console.error('Failed to load workbooks for AI scope:', err)
      } finally {
        setLoadingWorkbooks(false)
      }
    }

    void loadConfig()
    void loadWorkbooks()
  }, [])

  useEffect(() => {
    if (!selectedWorkbookId) {
      setSelectedWorkbookDetail(null)
      setSelectedSheetIds([])
      return
    }

    let active = true
    ;(async () => {
      try {
        const res = await api.get<Workbook>(`/workbooks/${selectedWorkbookId}`)
        if (!active) return
        if (res.code === 0 && res.data) {
          setSelectedWorkbookDetail(res.data)
          setSelectedSheetIds(res.data.sheets?.map((sheet) => sheet.id) || [])
        }
      } catch (err) {
        console.error('Failed to load workbook sheets for AI scope:', err)
        if (active) {
          setSelectedWorkbookDetail(null)
          setSelectedSheetIds([])
        }
      }
    })()

    return () => {
      active = false
    }
  }, [selectedWorkbookId])

  useEffect(() => {
    if (!selectedWorkbookDetail) {
      setSelectedSheetIds([])
      return
    }
    setSelectedSheetIds(selectedWorkbookDetail.sheets?.map((sheet) => sheet.id) || [])
  }, [selectedWorkbookDetail])

  const handleSave = async () => {
    setSaving(true)
    setSaveMessage(null)
    try {
      const res = await api.put('/admin/ai/config', { endpoint, api_key: apiKey, model })
      if (res.code === 0) {
        setConfigured(Boolean(endpoint && model))
        setApiKey('')
        setSaveMessage({ type: 'success', text: '配置已保存' })
      } else {
        setSaveMessage({ type: 'error', text: res.message || '保存失败' })
      }
    } catch {
      setSaveMessage({ type: 'error', text: '网络错误，保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const handleToggleSheet = (sheetId: number) => {
    setSelectedSheetIds((current) =>
      current.includes(sheetId)
        ? current.filter((id) => id !== sheetId)
        : [...current, sheetId]
    )
  }

  const handleGeneratePlan = async () => {
    if (!selectedWorkbookId || selectedSheetIds.length === 0 || !prompt.trim()) {
      setPlanError('请选择工作簿、勾选至少一张工作表，并输入 AI 指令。')
      return
    }

    setPlanning(true)
    setPlanError('')
    setPlanResult(null)

    try {
      const res = await api.post<AISpreadsheetPlanResponse>('/admin/ai/spreadsheet/preview', {
        workbook_id: selectedWorkbookId,
        sheet_ids: selectedSheetIds,
        prompt: prompt.trim(),
      })

      if (res.code !== 0 || !res.data) {
        setPlanError(res.message || '生成 AI 方案失败，请稍后重试。')
        return
      }

      setPlanResult(res.data)
    } catch (err) {
      console.error('Failed to preview AI spreadsheet plan:', err)
      setPlanError('生成 AI 方案失败，请稍后重试。')
    } finally {
      setPlanning(false)
    }
  }

  const handleApplyPlan = async () => {
    if (!planResult || planResult.operations.length === 0) {
      setPlanError('当前没有可写回的 AI 变更。')
      return
    }

    if (!window.confirm(`将写入 ${planResult.operations.length} 条 AI 变更到已选工作表，确定继续吗？`)) {
      return
    }

    setApplying(true)
    setPlanError('')

    try {
      const res = await api.post('/admin/ai/spreadsheet/apply', {
        operations: planResult.operations,
      })

      if (res.code !== 0) {
        setPlanError(res.message || 'AI 变更写回失败，请稍后重试。')
        return
      }

      setPlanResult((current) =>
        current
          ? {
              ...current,
              reply: `${current.reply}\n\n已成功写回 ${current.operations.length} 条表格变更。`,
              operations: [],
            }
          : current
      )
    } catch (err) {
      console.error('Failed to apply AI spreadsheet plan:', err)
      setPlanError('AI 变更写回失败，请稍后重试。')
    } finally {
      setApplying(false)
    }
  }

  const groupedOperations = useMemo(() => {
    if (!planResult) return []
    const groups = new Map<string, AISpreadsheetOperation[]>()
    planResult.operations.forEach((operation) => {
      const key = `${operation.sheet_id}:${operation.sheet_name}`
      groups.set(key, [...(groups.get(key) || []), operation])
    })
    return Array.from(groups.entries()).map(([key, operations]) => ({ key, operations }))
  }, [planResult])

  return (
    <AuthGuard requireRole="admin">
      <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(251,191,36,0.18),_transparent_24%),linear-gradient(180deg,#f8fafc_0%,#eff6ff_100%)] p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <button
            onClick={() => router.push('/')}
            className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
            返回首页
          </button>

          <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <section className="rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mb-8 flex items-center gap-3">
                <div className="rounded-2xl bg-slate-900 p-3 text-white">
                  <Bot className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-slate-900">AI 助手配置</h1>
                  <p className="mt-0.5 text-sm text-slate-500">配置 AI 模型连接参数</p>
                </div>
              </div>

              <div className="mb-8">
                {loading ? (
                  <div className="text-sm text-slate-400">加载中...</div>
                ) : configured ? (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" />
                    AI 助手已配置
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600">
                    <XCircle className="h-4 w-4" />
                    AI 助手未配置
                  </div>
                )}
              </div>

              <div className="space-y-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">API 端点</label>
                  <input
                    type="text"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">API 密钥</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  />
                  <p className="mt-1 text-xs text-slate-400">密钥不会回显，留空表示不修改</p>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">模型名称</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="gpt-4o-mini"
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                  />
                </div>
              </div>

              <div className="mt-8 flex items-center gap-4">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? '保存中...' : '保存配置'}
                </button>
                {saveMessage && (
                  <span className={`text-sm ${saveMessage.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                    {saveMessage.text}
                  </span>
                )}
              </div>
            </section>

            <section className="rounded-[28px] border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    AI Spreadsheet Batch
                  </div>
                  <h2 className="mt-4 text-2xl font-semibold text-slate-950">批量读取与写回工作表</h2>
                  <p className="mt-2 text-sm leading-7 text-slate-500">
                    先勾选 AI 可读取的工作表范围，再生成批处理方案。确认预览后，系统才会把 AI 提议的修改写回表格。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                >
                  <RefreshCw className="h-4 w-4" />
                  刷新
                </button>
              </div>

              <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
                <div className="space-y-4 rounded-[24px] border border-slate-200 bg-slate-50/70 p-4">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">工作簿范围</label>
                    <select
                      value={selectedWorkbookId ?? ''}
                      onChange={(event) => setSelectedWorkbookId(Number(event.target.value) || null)}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    >
                      {workbooks.map((workbook) => (
                        <option key={workbook.id} value={workbook.id}>
                          {workbook.name} {workbook.owner_name ? `- ${workbook.owner_name}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <label className="block text-sm font-semibold text-slate-700">允许 AI 读取的工作表</label>
                      {selectedWorkbookDetail?.sheets && selectedWorkbookDetail.sheets.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSelectedSheetIds(selectedWorkbookDetail.sheets?.map((sheet) => sheet.id) || [])}
                          className="text-xs font-semibold text-sky-700 transition hover:text-sky-900"
                        >
                          全选
                        </button>
                      )}
                    </div>
                    <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                      {loadingWorkbooks ? (
                        <div className="text-sm text-slate-400">正在加载工作簿...</div>
                      ) : selectedWorkbookDetail?.sheets?.length ? (
                        selectedWorkbookDetail.sheets.map((sheet) => {
                          const checked = selectedSheetIds.includes(sheet.id)
                          return (
                            <label
                              key={sheet.id}
                              className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                                checked ? 'border-sky-200 bg-sky-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => handleToggleSheet(sheet.id)}
                                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium text-slate-900">{sheet.name}</div>
                                <div className="text-xs text-slate-400">更新时间 {new Date(sheet.updated_at).toLocaleString('zh-CN')}</div>
                              </div>
                            </label>
                          )
                        })
                      ) : (
                        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
                          当前工作簿没有可选工作表。
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-5">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">给 AI 的指令</label>
                      <textarea
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder="例如：读取已勾选工作表，新增‘完成率’列并用公式填充；如果发现缺少待办项，就插入新行并补齐状态。"
                      rows={6}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7 text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleGeneratePlan}
                      disabled={planning}
                      className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Wand2 className="h-4 w-4" />
                      {planning ? '生成方案中...' : '生成 AI 批处理方案'}
                    </button>
                    <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                      <Database className="h-4 w-4 text-sky-600" />
                      当前已选 {selectedSheetIds.length} 张工作表
                    </div>
                  </div>

                  {planError && (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                      {planError}
                    </div>
                  )}

                  {planResult && (
                    <div className="space-y-5 rounded-[24px] border border-slate-200 bg-slate-50/60 p-4">
                      <div className="rounded-2xl border border-sky-200 bg-white px-4 py-4">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-sky-700">
                          <Sparkles className="h-4 w-4" />
                          AI 回复
                        </div>
                        <div className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{planResult.reply}</div>
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">批处理预览</div>
                            <div className="text-xs text-slate-400">共 {planResult.operations.length} 条待写回操作</div>
                          </div>
                          <button
                            type="button"
                            onClick={handleApplyPlan}
                            disabled={applying || planResult.operations.length === 0}
                            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <FileSpreadsheet className="h-4 w-4" />
                            {applying ? '写回中...' : '确认写回表格'}
                          </button>
                        </div>

                        {planResult.operations.length === 0 ? (
                          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">
                            AI 本次只给出了文本答案，没有生成表格写回操作。
                          </div>
                        ) : (
                          <div className="space-y-4">
                            {groupedOperations.map((group) => (
                              <div key={group.key} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
                                <div className="mb-3 text-sm font-semibold text-slate-800">{group.operations[0]?.sheet_name}</div>
                                <div className="space-y-2">
                                  {group.operations.map((operation, index) => (
                                    <div key={`${group.key}-${index}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                                      <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                                        <span>{getOperationTitle(operation)}</span>
                                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                                          {operation.kind || 'update_cell'}
                                        </span>
                                      </div>
                                      <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
                                        {getOperationDetail(operation)}
                                      </div>
                                      {operation.reason && (
                                        <div className="mt-2 text-xs text-slate-500">原因：{operation.reason}</div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
