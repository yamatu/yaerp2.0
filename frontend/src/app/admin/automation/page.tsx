'use client'

import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CirclePlay,
  Clock3,
  FileSpreadsheet,
  GitBranch,
  Loader2,
  MessageSquare,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2,
  UserCheck,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type {
  AutomationAction,
  AutomationApprovalStep,
  AutomationApprovalRange,
  AutomationCondition,
  AutomationConditionOperator,
  AutomationRule,
  AutomationRun,
  AutomationRunDetail,
  AutomationTriggerType,
  Channel,
  Department,
  PageData,
  User,
  Workbook,
} from '@/types'

interface RuleDraft {
  id?: number
  name: string
  description: string
  ownerId: string
  workbookId: string
  sheetId: string
  triggerType: AutomationTriggerType
  watchedColumns: string[]
  cronExpr: string
  timezone: string
  conditionLogic: 'all' | 'any'
  conditions: AutomationCondition[]
  approvalSteps: AutomationApprovalStep[]
  approvalRanges: AutomationApprovalRange[]
  actions: AutomationAction[]
  holdChanges: boolean
  enabled: boolean
}

const triggerLabels: Record<AutomationTriggerType, string> = {
  cell_change: '单元格变化',
  schedule: '定时执行',
  manual: '手动触发',
}

const operatorOptions: Array<{ value: AutomationConditionOperator; label: string }> = [
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
  { value: 'in', label: '属于列表' },
  { value: 'regex', label: '正则匹配' },
  { value: 'is_empty', label: '为空' },
  { value: 'not_empty', label: '不为空' },
]

const actionLabels: Record<AutomationAction['type'], string> = {
  notify: '站内通知',
  channel_message: '频道消息',
  update_cell: '回写单元格',
}

const statusLabels: Record<string, string> = {
  running: '执行中',
  waiting_approval: '等待审批',
  completed: '已完成',
  rejected: '已拒绝',
  failed: '失败',
  cancelled: '已取消',
}

const statusStyles: Record<string, string> = {
  running: 'bg-sky-50 text-sky-700',
  waiting_approval: 'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-rose-50 text-rose-700',
  failed: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-600',
}

function emptyDraft(ownerId = ''): RuleDraft {
  return {
    name: '',
    description: '',
    ownerId,
    workbookId: '',
    sheetId: '',
    triggerType: 'cell_change',
    watchedColumns: [],
    cronExpr: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    conditionLogic: 'all',
    conditions: [],
    approvalSteps: [],
    approvalRanges: [],
    actions: [{ type: 'notify', recipient_type: 'owner', title_template: '', message_template: '' }],
    holdChanges: false,
    enabled: true,
  }
}

function ruleToDraft(rule: AutomationRule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description || '',
    ownerId: String(rule.owner_id),
    workbookId: rule.workbook_id ? String(rule.workbook_id) : '',
    sheetId: rule.sheet_id ? String(rule.sheet_id) : '',
    triggerType: rule.trigger_type,
    watchedColumns: rule.watched_columns || [],
    cronExpr: rule.cron_expr || '0 9 * * 1-5',
    timezone: rule.timezone || 'Asia/Shanghai',
    conditionLogic: rule.condition_logic || 'all',
    conditions: (rule.conditions || []).map((condition) => ({ ...condition })),
    approvalSteps: (rule.approval_steps || []).map((step) => ({
      ...step,
      user_ids: step.user_ids || [],
      department_ids: step.department_ids || [],
    })),
    approvalRanges: (rule.approval_ranges || []).map((range) => ({ ...range, columns: range.columns || [] })),
    actions: (rule.actions || []).map((action) => ({
      ...action,
      user_ids: action.user_ids || [],
      department_ids: action.department_ids || [],
    })),
    holdChanges: Boolean(rule.hold_changes),
    enabled: rule.enabled,
  }
}

function formatTime(value?: string) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function MultiPicker({
  users,
  departments,
  userIds,
  departmentIds,
  onUsersChange,
  onDepartmentsChange,
}: {
  users: User[]
  departments: Department[]
  userIds: number[]
  departmentIds: number[]
  onUsersChange: (ids: number[]) => void
  onDepartmentsChange: (ids: number[]) => void
}) {
  const [search, setSearch] = useState('')
  const keyword = search.trim().toLowerCase()
  const visibleUsers = users.filter((user) => !keyword || user.username.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword))
  const visibleDepartments = departments.filter((department) => !keyword || department.name.toLowerCase().includes(keyword))
  const toggle = (values: number[], id: number) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]

  return (
    <div className="space-y-2">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索员工或部门" className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-3 text-xs outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
      </label>
      <div className="grid max-h-40 gap-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 px-1 text-[11px] font-semibold text-slate-400">员工</div>
          {visibleUsers.map((user) => (
            <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
              <input type="checkbox" checked={userIds.includes(user.id)} onChange={() => onUsersChange(toggle(userIds, user.id))} className="h-3.5 w-3.5 accent-slate-900" />
              <span className="truncate">{user.username}</span>
            </label>
          ))}
          {visibleUsers.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">没有匹配员工</div>}
        </div>
        <div>
          <div className="mb-1 px-1 text-[11px] font-semibold text-slate-400">部门</div>
          {visibleDepartments.map((department) => (
            <label key={department.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
              <input type="checkbox" checked={departmentIds.includes(department.id)} onChange={() => onDepartmentsChange(toggle(departmentIds, department.id))} className="h-3.5 w-3.5 accent-slate-900" />
              <span className="min-w-0 flex-1 truncate">{department.name}</span>
              <span className="text-[10px] text-slate-400">{department.member_count}</span>
            </label>
          ))}
          {visibleDepartments.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">没有匹配部门</div>}
        </div>
      </div>
    </div>
  )
}

export default function AutomationAdminPage() {
  const profile = getStoredUser()
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [workbookDetails, setWorkbookDetails] = useState<Record<number, Workbook>>({})
  const workbookDetailsRef = useRef<Record<number, Workbook>>({})
  const [draft, setDraft] = useState<RuleDraft>(() => emptyDraft(profile ? String(profile.id) : ''))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [ruleSearch, setRuleSearch] = useState('')
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadWorkbookDetail = useCallback(async (workbookId: number) => {
    if (!workbookId || workbookDetailsRef.current[workbookId]) return workbookDetailsRef.current[workbookId]
    const response = await api.get<Workbook>(`/workbooks/${workbookId}`)
    if (response.code !== 0 || !response.data) return null
    workbookDetailsRef.current = { ...workbookDetailsRef.current, [workbookId]: response.data }
    setWorkbookDetails((current) => ({ ...current, [workbookId]: response.data! }))
    return response.data
  }, [])

  const loadData = useCallback(async (preferredRuleId?: number) => {
    setLoading(true)
    try {
      const [rulesResponse, runsResponse, usersResponse, departmentsResponse, channelsResponse, workbooksResponse] = await Promise.all([
        api.get<PageData<AutomationRule>>('/automation/rules?page=1&size=100'),
        api.get<PageData<AutomationRun>>('/automation/runs?page=1&size=12'),
        api.get<PageData<User>>('/users?page=1&size=1000'),
        api.get<Department[]>('/departments'),
        api.get<Channel[]>('/channels'),
        api.get<Workbook[]>('/workbooks'),
      ])
      const nextRules = rulesResponse.code === 0 && rulesResponse.data ? rulesResponse.data.list : []
      setRules(nextRules)
      setRuns(runsResponse.code === 0 && runsResponse.data ? runsResponse.data.list : [])
      setUsers(usersResponse.code === 0 && usersResponse.data ? usersResponse.data.list.filter((user) => user.status === 1) : [])
      setDepartments(departmentsResponse.code === 0 && departmentsResponse.data ? departmentsResponse.data : [])
      setChannels(channelsResponse.code === 0 && channelsResponse.data ? channelsResponse.data : [])
      setWorkbooks(workbooksResponse.code === 0 && workbooksResponse.data ? workbooksResponse.data : [])
      const selected = nextRules.find((rule) => rule.id === preferredRuleId)
      if (selected) {
        setDraft(ruleToDraft(selected))
        if (selected.workbook_id) void loadWorkbookDetail(selected.workbook_id)
      }
    } catch {
      setMessage({ type: 'error', text: '加载自动化配置失败' })
    } finally {
      setLoading(false)
    }
  }, [loadWorkbookDetail])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const selectedWorkbook = draft.workbookId ? workbookDetails[Number(draft.workbookId)] : undefined
  const selectedSheet = selectedWorkbook?.sheets?.find((sheet) => sheet.id === Number(draft.sheetId))
  const columns = Array.isArray(selectedSheet?.columns) ? selectedSheet.columns : []

  const filteredRules = useMemo(() => {
    const keyword = ruleSearch.trim().toLowerCase()
    if (!keyword) return rules
    return rules.filter((rule) => [rule.name, rule.description, rule.workbook_name, rule.sheet_name, rule.owner_name].some((value) => (value || '').toLowerCase().includes(keyword)))
  }, [ruleSearch, rules])

  const startCreate = () => {
    setDraft(emptyDraft(profile ? String(profile.id) : ''))
    setMessage(null)
  }

  const chooseRule = (rule: AutomationRule) => {
    setDraft(ruleToDraft(rule))
    setMessage(null)
    if (rule.workbook_id) void loadWorkbookDetail(rule.workbook_id)
  }

  const chooseWorkbook = async (value: string) => {
    setDraft((current) => ({ ...current, workbookId: value, sheetId: '', watchedColumns: [], conditions: [] }))
    if (value) await loadWorkbookDetail(Number(value))
  }

  const updateCondition = (index: number, next: Partial<AutomationCondition>) => {
    setDraft((current) => ({ ...current, conditions: current.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item) }))
  }

  const updateApproval = (index: number, next: Partial<AutomationApprovalStep>) => {
    setDraft((current) => ({ ...current, approvalSteps: current.approvalSteps.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item) }))
  }

  const updateAction = (index: number, next: Partial<AutomationAction>) => {
    setDraft((current) => ({ ...current, actions: current.actions.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item) }))
  }

  const buildPayload = () => ({
    name: draft.name.trim(),
    description: draft.description.trim(),
    owner_id: Number(draft.ownerId),
    sheet_id: draft.sheetId ? Number(draft.sheetId) : undefined,
    trigger_type: draft.triggerType,
    watched_columns: draft.watchedColumns,
    cron_expr: draft.triggerType === 'schedule' ? draft.cronExpr.trim() : '',
    timezone: draft.timezone,
    condition_logic: draft.conditionLogic,
    conditions: draft.conditions.map((condition) => ({
      ...condition,
      value: condition.operator === 'is_empty' || condition.operator === 'not_empty' ? undefined : condition.value,
    })),
    approval_steps: draft.approvalSteps,
    approval_ranges: draft.approvalRanges,
    actions: draft.actions,
    hold_changes: draft.holdChanges,
    enabled: draft.enabled,
  })

  const validateDraft = () => {
    if (!draft.name.trim()) return '请填写规则名称'
    if (!draft.ownerId) return '请选择规则负责人'
    if (draft.triggerType === 'cell_change' && !draft.sheetId) return '单元格变化规则必须选择工作表'
    if (draft.triggerType === 'schedule' && !draft.cronExpr.trim()) return '定时规则必须填写 Cron 表达式'
    if ((draft.conditions.length > 0 || draft.actions.some((action) => action.type === 'update_cell')) && !draft.sheetId) return '条件判断或回写动作必须选择工作表'
    if (draft.conditions.some((condition) => !condition.column)) return '请补全条件字段'
    if (draft.approvalSteps.some((step) => step.user_ids.length + step.department_ids.length === 0)) return '每个审批步骤至少选择一名员工或一个部门'
    if (draft.actions.length === 0 && !draft.holdChanges) return '至少添加一个执行动作'
    if (draft.actions.some((action) => action.type === 'channel_message' && (!action.channel_id || !action.message_template?.trim()))) return '频道动作必须选择频道并填写消息内容'
    if (draft.actions.some((action) => action.type === 'update_cell' && !action.target_column)) return '回写动作必须选择目标列'
    return ''
  }

  const saveRule = async () => {
    const validationError = validateDraft()
    if (validationError) {
      setMessage({ type: 'error', text: validationError })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const response = draft.id
        ? await api.put<AutomationRule>(`/automation/rules/${draft.id}`, buildPayload())
        : await api.post<AutomationRule>('/automation/rules', buildPayload())
      if (response.code !== 0 || !response.data) {
        setMessage({ type: 'error', text: response.message || '保存规则失败' })
        return
      }
      setMessage({ type: 'success', text: draft.id ? '规则已更新' : '规则已创建' })
      await loadData(response.data.id)
    } catch {
      setMessage({ type: 'error', text: '保存规则失败，请稍后重试' })
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = async () => {
    if (!draft.id || !window.confirm(`确定删除自动化规则“${draft.name}”吗？`)) return
    setSaving(true)
    const response = await api.delete(`/automation/rules/${draft.id}`)
    setSaving(false)
    if (response.code !== 0) {
      setMessage({ type: 'error', text: response.message || '删除失败' })
      return
    }
    setMessage({ type: 'success', text: '规则已删除' })
    setDraft(emptyDraft(profile ? String(profile.id) : ''))
    await loadData()
  }

  const triggerRule = async () => {
    if (!draft.id || draft.triggerType !== 'manual') return
    let rowIndex: number | undefined
    if (draft.conditions.length > 0 || draft.actions.some((action) => action.type === 'update_cell')) {
      const value = window.prompt('请输入数据行号（表头下第一行是第 2 行）', '2')
      if (value === null) return
      const displayRow = Number(value)
      if (!Number.isInteger(displayRow) || displayRow < 2) {
        setMessage({ type: 'error', text: '数据行号必须是大于等于 2 的整数' })
        return
      }
      rowIndex = displayRow - 2
    }
    setSaving(true)
    const response = await api.post<AutomationRun>(`/automation/rules/${draft.id}/trigger`, rowIndex === undefined ? {} : { row_index: rowIndex })
    setSaving(false)
    if (response.code !== 0 || !response.data) {
      setMessage({ type: 'error', text: response.message || '触发失败' })
      return
    }
    setMessage({ type: 'success', text: response.data.status === 'waiting_approval' ? '已发起，正在等待审批' : '规则已执行' })
    await loadData(draft.id)
  }

  const openRunDetail = async (runId: number) => {
    setDetailLoading(true)
    const response = await api.get<AutomationRunDetail>(`/automation/runs/${runId}`)
    setDetailLoading(false)
    if (response.code === 0 && response.data) setDetail(response.data)
  }

  return (
    <AdminShell
      title="流程自动化"
      description="通过表格变化、定时计划和审批流驱动业务动作"
      summary={(
        <div className="grid grid-cols-3 gap-3">
          <div><div className="text-xs text-slate-400">规则总数</div><div className="mt-1 text-2xl font-semibold text-slate-950">{rules.length}</div></div>
          <div><div className="text-xs text-slate-400">已启用</div><div className="mt-1 text-2xl font-semibold text-emerald-700">{rules.filter((rule) => rule.enabled).length}</div></div>
          <div><div className="text-xs text-slate-400">等待审批</div><div className="mt-1 text-2xl font-semibold text-amber-700">{runs.filter((run) => run.status === 'waiting_approval').length}</div></div>
        </div>
      )}
    >
      {message && <div className={`rounded-lg border px-4 py-3 text-sm ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>{message.text}</div>}

      <div className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 p-3">
            <div className="text-sm font-semibold text-slate-900">自动化规则</div>
            <button type="button" onClick={startCreate} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white hover:bg-slate-800" title="新建规则"><Plus className="h-4 w-4" /></button>
          </div>
          <label className="relative m-3 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={ruleSearch} onChange={(event) => setRuleSearch(event.target.value)} placeholder="搜索规则" className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-sky-300" />
          </label>
          <div className="max-h-[720px] overflow-y-auto border-t border-slate-100">
            {loading ? <div className="flex h-32 items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中</div> : filteredRules.length === 0 ? <div className="p-6 text-center text-sm text-slate-400">暂无规则</div> : filteredRules.map((rule) => (
              <button key={rule.id} type="button" onClick={() => chooseRule(rule)} className={`block w-full border-b border-slate-100 px-4 py-3 text-left transition ${draft.id === rule.id ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${rule.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{rule.name}</span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-400">
                  <span>{triggerLabels[rule.trigger_type]}</span>
                  <span className="truncate">{rule.sheet_name || '无工作表'}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="space-y-3">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-5 flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">{draft.id ? '编辑规则' : '新建规则'}</h2>
                <p className="mt-1 text-sm text-slate-500">按触发、审批、动作的顺序配置执行链路。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {draft.id && draft.triggerType === 'manual' && <button type="button" onClick={() => void triggerRule()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><CirclePlay className="h-4 w-4" />立即运行</button>}
                {draft.id && <button type="button" onClick={() => void deleteRule()} disabled={saving} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50" title="删除规则"><Trash2 className="h-4 w-4" /></button>}
                <button type="button" onClick={() => void saveRule()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存规则</button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">规则名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={160} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" /></label>
              <label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">负责人</span><select value={draft.ownerId} onChange={(event) => setDraft((current) => ({ ...current, ownerId: event.target.value }))} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300">{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label>
              <label className="space-y-1.5 md:col-span-2"><span className="text-xs font-medium text-slate-600">说明</span><textarea value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} rows={2} className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" /></label>
              <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 md:col-span-2"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} className="h-4 w-4 accent-slate-900" />启用此规则</label>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-4 flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-50 text-sky-700"><Zap className="h-4 w-4" /></div><div><h3 className="text-sm font-semibold text-slate-900">1. 触发与条件</h3><p className="text-xs text-slate-400">定义何时检查并发起流程。</p></div></div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">触发方式</span><select value={draft.triggerType} onChange={(event) => setDraft((current) => ({ ...current, triggerType: event.target.value as AutomationTriggerType }))} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">{Object.entries(triggerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">工作簿</span><select value={draft.workbookId} onChange={(event) => void chooseWorkbook(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"><option value="">不关联工作簿</option>{workbooks.map((workbook) => <option key={workbook.id} value={workbook.id}>{workbook.name}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">工作表</span><select value={draft.sheetId} onChange={(event) => setDraft((current) => ({ ...current, sheetId: event.target.value, watchedColumns: [], conditions: [] }))} disabled={!draft.workbookId} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm disabled:bg-slate-50"><option value="">不关联工作表</option>{selectedWorkbook?.sheets?.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</select></label>
            </div>

            {draft.triggerType === 'schedule' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">Cron 表达式</span><input value={draft.cronExpr} onChange={(event) => setDraft((current) => ({ ...current, cronExpr: event.target.value }))} placeholder="0 9 * * 1-5" className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-sm" /></label><label className="space-y-1.5"><span className="text-xs font-medium text-slate-600">时区</span><input list="automation-timezones" value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} placeholder="Asia/Shanghai" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm" /><datalist id="automation-timezones"><option value="Asia/Shanghai" /><option value="UTC" /><option value="Europe/Rome" /><option value="America/New_York" /></datalist></label></div>}

            {draft.triggerType === 'cell_change' && columns.length > 0 && <div className="mt-3"><div className="mb-2 text-xs font-medium text-slate-600">监听列（不选表示监听全部列）</div><div className="flex flex-wrap gap-2">{columns.map((column) => <label key={column.key} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${draft.watchedColumns.includes(column.key) ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-600'}`}><input type="checkbox" checked={draft.watchedColumns.includes(column.key)} onChange={() => setDraft((current) => ({ ...current, watchedColumns: current.watchedColumns.includes(column.key) ? current.watchedColumns.filter((key) => key !== column.key) : [...current.watchedColumns, column.key] }))} className="sr-only" />{column.name || column.key}</label>)}</div></div>}

            <div className="mt-5 border-t border-slate-100 pt-4">
              <div className="mb-3 flex items-center justify-between"><div><span className="text-sm font-semibold text-slate-800">行数据条件</span><span className="ml-2 text-xs text-slate-400">{draft.conditionLogic === 'all' ? '全部满足' : '任一满足'}</span></div><div className="flex gap-2"><select value={draft.conditionLogic} onChange={(event) => setDraft((current) => ({ ...current, conditionLogic: event.target.value as 'all' | 'any' }))} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="all">全部条件</option><option value="any">任一条件</option></select><button type="button" onClick={() => setDraft((current) => ({ ...current, conditions: [...current.conditions, { column: columns[0]?.key || '', operator: 'eq', value: '' }] }))} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" />条件</button></div></div>
              <div className="space-y-2">{draft.conditions.map((condition, index) => <div key={index} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-[minmax(130px,1fr)_150px_minmax(140px,1fr)_36px]"><select value={condition.column} onChange={(event) => updateCondition(index, { column: event.target.value })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="">选择列</option>{columns.map((column) => <option key={column.key} value={column.key}>{column.name || column.key}</option>)}</select><select value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as AutomationConditionOperator })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm">{operatorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><input value={condition.value === undefined ? '' : String(condition.value)} onChange={(event) => updateCondition(index, { value: event.target.value })} disabled={condition.operator === 'is_empty' || condition.operator === 'not_empty'} placeholder={condition.operator === 'in' ? '多个值用逗号分隔' : '比较值'} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm disabled:bg-slate-100" /><button type="button" onClick={() => setDraft((current) => ({ ...current, conditions: current.conditions.filter((_, itemIndex) => itemIndex !== index) }))} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="删除条件"><X className="h-4 w-4" /></button></div>)}</div>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><UserCheck className="h-4 w-4" /></div><div><h3 className="text-sm font-semibold text-slate-900">2. 审批步骤</h3><p className="text-xs text-slate-400">留空可直接执行动作。</p></div></div><button type="button" onClick={() => setDraft((current) => ({ ...current, approvalSteps: [...current.approvalSteps, { name: `审批步骤 ${current.approvalSteps.length + 1}`, user_ids: [], department_ids: [], required_approvals: 1 }] }))} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" />步骤</button></div>
            <div className="space-y-3">{draft.approvalSteps.length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">当前规则无需审批</div> : draft.approvalSteps.map((step, index) => <div key={index} className="rounded-lg border border-slate-200 p-3"><div className="mb-3 grid gap-2 sm:grid-cols-[42px_minmax(160px,1fr)_150px_36px]"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white">{index + 1}</div><input value={step.name} onChange={(event) => updateApproval(index, { name: event.target.value })} placeholder="步骤名称" className="h-9 rounded-lg border border-slate-200 px-3 text-sm" /><label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-2 text-xs text-slate-600">需通过<input type="number" min={1} value={step.required_approvals} onChange={(event) => updateApproval(index, { required_approvals: Math.max(1, Number(event.target.value)) })} className="min-w-0 flex-1 text-center outline-none" />人</label><button type="button" onClick={() => setDraft((current) => ({ ...current, approvalSteps: current.approvalSteps.filter((_, itemIndex) => itemIndex !== index) }))} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="删除步骤"><Trash2 className="h-4 w-4" /></button></div><MultiPicker users={users} departments={departments} userIds={step.user_ids} departmentIds={step.department_ids} onUsersChange={(ids) => updateApproval(index, { user_ids: ids })} onDepartmentsChange={(ids) => updateApproval(index, { department_ids: ids })} /></div>)}</div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700"><GitBranch className="h-4 w-4" /></div><div><h3 className="text-sm font-semibold text-slate-900">3. 执行动作</h3><p className="text-xs text-slate-400">审批完成后按顺序执行。</p></div></div><div className="flex gap-1"><button type="button" onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'notify', recipient_type: 'owner', title_template: '', message_template: '' }] }))} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="添加站内通知"><BellRing className="h-3.5 w-3.5" /></button><button type="button" onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'channel_message', message_template: '', send_whatsapp: false }] }))} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="添加频道消息"><MessageSquare className="h-3.5 w-3.5" /></button><button type="button" onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'update_cell', target_column: '', value_template: '' }] }))} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="添加单元格回写"><PencilLine className="h-3.5 w-3.5" /></button></div></div>
            <div className="space-y-3">{draft.actions.map((action, index) => <div key={index} className="rounded-lg border border-slate-200 p-3"><div className="mb-3 flex items-center gap-2"><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{index + 1}. {actionLabels[action.type]}</span><div className="flex-1" /><button type="button" onClick={() => setDraft((current) => ({ ...current, actions: current.actions.filter((_, itemIndex) => itemIndex !== index) }))} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="删除动作"><Trash2 className="h-4 w-4" /></button></div>{action.type === 'notify' && <div className="space-y-3"><div className="grid gap-2 sm:grid-cols-2"><select value={action.recipient_type || 'owner'} onChange={(event) => updateAction(index, { recipient_type: event.target.value as AutomationAction['recipient_type'] })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="owner">通知规则负责人</option><option value="trigger_user">通知触发人</option><option value="users_departments">指定员工或部门</option></select><input value={action.title_template || ''} onChange={(event) => updateAction(index, { title_template: event.target.value })} placeholder="通知标题，可使用 {{row.列名}}" className="h-9 rounded-lg border border-slate-200 px-3 text-sm" /></div><textarea value={action.message_template || ''} onChange={(event) => updateAction(index, { message_template: event.target.value })} rows={2} placeholder="通知内容" className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm" />{action.recipient_type === 'users_departments' && <MultiPicker users={users} departments={departments} userIds={action.user_ids || []} departmentIds={action.department_ids || []} onUsersChange={(ids) => updateAction(index, { user_ids: ids })} onDepartmentsChange={(ids) => updateAction(index, { department_ids: ids })} />}</div>}{action.type === 'channel_message' && <div className="grid gap-2 sm:grid-cols-[minmax(160px,240px)_1fr]"><select value={action.channel_id || ''} onChange={(event) => updateAction(index, { channel_id: event.target.value ? Number(event.target.value) : undefined })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="">选择频道</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select><textarea value={action.message_template || ''} onChange={(event) => updateAction(index, { message_template: event.target.value })} rows={2} placeholder="发送内容，可使用 {{workbook.name}}、{{sheet.name}}、{{row.列名}}" className="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm" /><label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs text-slate-600 sm:col-span-2"><input type="checkbox" checked={Boolean(action.send_whatsapp)} onChange={(event) => updateAction(index, { send_whatsapp: event.target.checked })} className="h-4 w-4 accent-emerald-600" />同时转发到频道关联的 WhatsApp 会话</label></div>}{action.type === 'update_cell' && <div className="grid gap-2 sm:grid-cols-2"><select value={action.target_column || ''} onChange={(event) => updateAction(index, { target_column: event.target.value })} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"><option value="">目标列</option>{columns.map((column) => <option key={column.key} value={column.key}>{column.name || column.key}</option>)}</select><input value={action.value_template || ''} onChange={(event) => updateAction(index, { value_template: event.target.value })} placeholder={'写入值，如 已审批 或 {{row.total}}'} className="h-9 rounded-lg border border-slate-200 px-3 text-sm" /></div>}</div>)}</div>
          </section>
        </main>
      </div>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-900">最近运行</h2><p className="mt-0.5 text-xs text-slate-400">查看审批状态、执行日志和错误信息。</p></div><button type="button" onClick={() => void loadData(draft.id)} disabled={loading} className="ui-tooltip inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="刷新运行记录"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div>
        <div className="divide-y divide-slate-100">{runs.length === 0 ? <div className="py-12 text-center text-sm text-slate-400">暂无运行记录</div> : runs.map((run) => <button key={run.id} type="button" onClick={() => void openRunDetail(run.id)} className="flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-slate-50 sm:flex-row sm:items-center"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Workflow className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-900">{run.rule_name}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400"><span>{triggerLabels[run.trigger_type]}</span>{run.workbook_name && <span><FileSpreadsheet className="mr-1 inline h-3 w-3" />{run.workbook_name} / {run.sheet_name}</span>}<span><Clock3 className="mr-1 inline h-3 w-3" />{formatTime(run.created_at)}</span></div></div><span className={`self-start rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[run.status] || statusStyles.cancelled}`}>{statusLabels[run.status] || run.status}</span></button>)}</div>
      </section>

      {(detail || detailLoading) && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null) }}><div className="max-h-[92vh] w-full overflow-y-auto rounded-t-lg bg-white shadow-2xl sm:max-w-2xl sm:rounded-lg">{detailLoading && !detail ? <div className="flex h-56 items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载运行详情</div> : detail && <><header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-200 bg-white px-4 py-4"><div><h3 className="text-base font-semibold text-slate-950">{detail.run.rule_name}</h3><p className="mt-1 text-xs text-slate-400">运行 #{detail.run.id} · {formatTime(detail.run.created_at)}</p></div><button type="button" onClick={() => setDetail(null)} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button></header><div className="space-y-5 p-4"><div className="flex flex-wrap gap-2"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[detail.run.status]}`}>{statusLabels[detail.run.status]}</span>{detail.run.error_message && <span className="text-sm text-rose-600">{detail.run.error_message}</span>}</div>{detail.approvals.length > 0 && <div><h4 className="mb-2 text-sm font-semibold text-slate-800">审批链路</h4><div className="space-y-2">{detail.approvals.map((approval) => <div key={approval.id} className="rounded-lg border border-slate-200 p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-800">{approval.step_index + 1}. {approval.name}</span><span className="text-xs text-slate-500">{approval.approved_count}/{approval.required_approvals}</span></div><div className="mt-2 flex flex-wrap gap-2">{approval.assignees.map((assignee) => <span key={assignee.user_id} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{assignee.username} · {assignee.status}</span>)}</div></div>)}</div></div>}<div><h4 className="mb-2 text-sm font-semibold text-slate-800">执行日志</h4><div className="space-y-2">{detail.logs.map((log) => <div key={log.id} className="flex gap-3 rounded-lg bg-slate-50 px-3 py-2"><CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${log.level === 'error' ? 'text-rose-500' : log.level === 'warning' ? 'text-amber-500' : 'text-emerald-500'}`} /><div><div className="text-sm text-slate-700">{log.message || log.event}</div><div className="mt-0.5 text-xs text-slate-400">{formatTime(log.created_at)}</div></div></div>)}</div></div></div></>}</div></div>}
    </AdminShell>
  )
}
