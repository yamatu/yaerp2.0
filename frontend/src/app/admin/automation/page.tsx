'use client'

import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  CirclePlay,
  Clock3,
  FileSpreadsheet,
  GitBranch,
  Hourglass,
  Info,
  MessageSquare,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UserCheck,
  Workflow,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { automationHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText, formatDateTime } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  Chip,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  Modal,
  Notice,
  SearchInput,
  SectionCard,
  SelectInput,
  StatGrid,
  StatusBadge,
  StickyActions,
  SwitchField,
  TextArea,
  TextInput,
  type Tone,
} from '@/components/admin/ui'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type {
  AutomationAction,
  AutomationApprovalRange,
  AutomationApprovalStep,
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

const triggerOptions: Array<{ value: AutomationTriggerType; label: string; hint: string; icon: typeof Zap }> = [
  { value: 'cell_change', label: '单元格变化', hint: '有人修改表格后检查条件', icon: Zap },
  { value: 'schedule', label: '定时执行', hint: '按 Cron 计划定期运行', icon: Clock3 },
  { value: 'manual', label: '手动触发', hint: '在本页点击“立即运行”', icon: CirclePlay },
]
const triggerLabels: Record<AutomationTriggerType, string> = { cell_change: '单元格变化', schedule: '定时执行', manual: '手动触发' }

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

const actionMeta: Record<AutomationAction['type'], { label: string; icon: typeof BellRing; hint: string }> = {
  notify: { label: '站内通知', icon: BellRing, hint: '出现在接收人的「任务中心」' },
  channel_message: { label: '频道消息', icon: MessageSquare, hint: '以负责人身份发到频道' },
  update_cell: { label: '回写单元格', icon: PencilLine, hint: '以负责人身份写入触发行' },
}

const statusMeta: Record<string, { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'sky' },
  waiting_approval: { label: '等待审批', tone: 'amber' },
  completed: { label: '已完成', tone: 'emerald' },
  rejected: { label: '已拒绝', tone: 'rose' },
  failed: { label: '失败', tone: 'rose' },
  cancelled: { label: '已取消', tone: 'slate' },
}

// Final-state log entries are stored as `run.<status>` without a message.
const runEventLabels: Record<string, string> = {
  'run.completed': '运行完成',
  'run.failed': '运行失败',
  'run.rejected': '审批被拒绝，流程结束',
  'run.cancelled': '运行已取消',
  'run.waiting_approval': '等待审批',
  'run.running': '开始执行动作',
}

const assigneeStatus: Record<string, string> = { pending: '待处理', approved: '已同意', rejected: '已拒绝', cancelled: '已取消' }

const cronPresets = [
  { label: '工作日 9:00', value: '0 9 * * 1-5' },
  { label: '每天 9:00', value: '0 9 * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每周一 9:00', value: '0 9 * * 1' },
  { label: '每月 1 日 9:00', value: '0 9 1 * *' },
]

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
    approvalSteps: (rule.approval_steps || []).map((step) => ({ ...step, user_ids: step.user_ids || [], department_ids: step.department_ids || [] })),
    approvalRanges: (rule.approval_ranges || []).map((range) => ({ ...range, columns: range.columns || [] })),
    actions: (rule.actions || []).map((action) => ({ ...action, user_ids: action.user_ids || [], department_ids: action.department_ids || [] })),
    holdChanges: Boolean(rule.hold_changes),
    enabled: rule.enabled,
  }
}

const fingerprint = (draft: RuleDraft) => JSON.stringify(draft)

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
  const visibleUsers = users.filter((user) => !keyword || user.username.toLowerCase().includes(keyword) || (user.email || '').toLowerCase().includes(keyword))
  const visibleDepartments = departments.filter((department) => !keyword || department.name.toLowerCase().includes(keyword))
  const toggle = (values: number[], id: number) => (values.includes(id) ? values.filter((value) => value !== id) : [...values, id])
  const selectedCount = userIds.length + departmentIds.length

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="搜索员工或部门" className="flex-1" />
        <StatusBadge tone={selectedCount ? 'sky' : 'amber'}>已选 {selectedCount}</StatusBadge>
      </div>
      <div className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 px-1 text-[11px] font-semibold text-slate-400">员工</div>
          {visibleUsers.map((user) => (
            <label key={user.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-50">
              <input type="checkbox" checked={userIds.includes(user.id)} onChange={() => onUsersChange(toggle(userIds, user.id))} className="h-4 w-4 accent-slate-900" />
              <span className="truncate">{user.username}</span>
            </label>
          ))}
          {visibleUsers.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">没有匹配员工</div>}
        </div>
        <div>
          <div className="mb-1 px-1 text-[11px] font-semibold text-slate-400">部门（展开为当前成员）</div>
          {visibleDepartments.map((department) => (
            <label key={department.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-50">
              <input type="checkbox" checked={departmentIds.includes(department.id)} onChange={() => onDepartmentsChange(toggle(departmentIds, department.id))} className="h-4 w-4 accent-slate-900" />
              <span className="min-w-0 flex-1 truncate">{department.name}</span>
              <span className="text-[11px] text-slate-400">{department.member_count} 人</span>
            </label>
          ))}
          {visibleDepartments.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">没有匹配部门</div>}
        </div>
      </div>
    </div>
  )
}

/** Clickable template variables; appends `{{...}}` to the target field. */
function VariableChips({ columns, onInsert }: { columns: Array<{ key: string; name?: string }>; onInsert: (token: string) => void }) {
  const base = [
    { token: '{{rule.name}}', label: '规则名' },
    { token: '{{workbook.name}}', label: '工作簿' },
    { token: '{{sheet.name}}', label: '工作表' },
    { token: '{{row.number}}', label: '行号' },
    { token: '{{now}}', label: '当前时间' },
  ]
  const columnTokens = columns.slice(0, 30).map((column) => ({ token: `{{row.${column.key}}}`, label: column.name || column.key }))
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-[11px] text-slate-400">插入变量：</span>
      {[...base, ...columnTokens].map((item) => (
        <button
          key={item.token}
          type="button"
          onClick={() => onInsert(item.token)}
          title={item.token}
          className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:border-sky-300 hover:text-sky-700 md:h-7"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export default function AutomationAdminPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [profileId, setProfileId] = useState('')
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [workbookDetails, setWorkbookDetails] = useState<Record<number, Workbook>>({})
  const workbookDetailsRef = useRef<Record<number, Workbook>>({})
  const [draft, setDraft] = useState<RuleDraft>(() => emptyDraft())
  const [savedFingerprint, setSavedFingerprint] = useState(() => fingerprint(emptyDraft()))
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [triggerRow, setTriggerRow] = useState('2')
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = getStoredUser()?.id
    if (id) {
      setProfileId(String(id))
      setDraft((current) => (current.id || current.ownerId ? current : { ...current, ownerId: String(id) }))
      setSavedFingerprint(fingerprint({ ...emptyDraft(String(id)) }))
    }
  }, [])

  const loadWorkbookDetail = useCallback(async (workbookId: number) => {
    if (!workbookId || workbookDetailsRef.current[workbookId]) return workbookDetailsRef.current[workbookId]
    const response = await api.get<Workbook>(`/workbooks/${workbookId}`)
    if (response.code !== 0 || !response.data) return null
    workbookDetailsRef.current = { ...workbookDetailsRef.current, [workbookId]: response.data }
    setWorkbookDetails((current) => ({ ...current, [workbookId]: response.data! }))
    return response.data
  }, [])

  const loadRuns = useCallback(async () => {
    const response = await api.get<PageData<AutomationRun>>('/automation/runs?page=1&size=20')
    if (response.code === 0 && response.data) setRuns(response.data.list || [])
  }, [])

  const loadData = useCallback(
    async (preferredRuleId?: number) => {
      setLoading(true)
      setLoadError('')
      try {
        const [rulesResponse, runsResponse, usersResponse, departmentsResponse, channelsResponse, workbooksResponse] = await Promise.all([
          api.get<PageData<AutomationRule>>('/automation/rules?page=1&size=100'),
          api.get<PageData<AutomationRun>>('/automation/runs?page=1&size=20'),
          api.get<PageData<User>>('/users?page=1&size=1000'),
          api.get<Department[]>('/departments'),
          api.get<Channel[]>('/channels'),
          api.get<Workbook[]>('/workbooks'),
        ])
        ensureOk(rulesResponse, '加载自动化规则失败')
        const nextRules = rulesResponse.data?.list || []
        setRules(nextRules)
        setRuns(runsResponse.code === 0 && runsResponse.data ? runsResponse.data.list || [] : [])
        setUsers(usersResponse.code === 0 && usersResponse.data ? usersResponse.data.list.filter((user) => user.status === 1) : [])
        setDepartments(departmentsResponse.code === 0 && departmentsResponse.data ? departmentsResponse.data : [])
        setChannels(channelsResponse.code === 0 && channelsResponse.data ? channelsResponse.data : [])
        setWorkbooks(workbooksResponse.code === 0 && workbooksResponse.data ? workbooksResponse.data : [])
        const selected = nextRules.find((rule) => rule.id === preferredRuleId)
        if (selected) {
          const next = ruleToDraft(selected)
          setDraft(next)
          setSavedFingerprint(fingerprint(next))
          if (selected.workbook_id) void loadWorkbookDetail(selected.workbook_id)
        }
      } catch (error) {
        setLoadError(errorText(error, '加载自动化配置失败'))
      } finally {
        setLoading(false)
      }
    },
    [loadWorkbookDetail],
  )

  useEffect(() => {
    void loadData()
  }, [loadData])

  const dirty = fingerprint(draft) !== savedFingerprint
  const selectedRule = rules.find((rule) => rule.id === draft.id)
  const selectedWorkbook = draft.workbookId ? workbookDetails[Number(draft.workbookId)] : undefined
  const selectedSheet = selectedWorkbook?.sheets?.find((sheet) => sheet.id === Number(draft.sheetId))
  const columns = useMemo(() => (Array.isArray(selectedSheet?.columns) ? selectedSheet!.columns : []), [selectedSheet])
  const columnName = (key: string) => columns.find((column) => column.key === key)?.name || key

  const filteredRules = useMemo(() => {
    const keyword = ruleSearch.trim().toLowerCase()
    if (!keyword) return rules
    return rules.filter((rule) => [rule.name, rule.description, rule.workbook_name, rule.sheet_name, rule.owner_name].some((value) => (value || '').toLowerCase().includes(keyword)))
  }, [ruleSearch, rules])

  const confirmDiscard = async () => {
    if (!dirty) return true
    return confirm({ title: '放弃未保存的修改？', message: '当前规则有修改尚未保存，切换后这些修改会丢失。', confirmText: '放弃修改' })
  }

  const scrollToEditor = () => {
    if (window.matchMedia('(max-width: 1279px)').matches) {
      window.setTimeout(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    }
  }

  const startCreate = async () => {
    if (!(await confirmDiscard())) return
    const next = emptyDraft(profileId)
    setDraft(next)
    setSavedFingerprint(fingerprint(next))
    setFormError('')
    scrollToEditor()
  }

  const chooseRule = async (rule: AutomationRule) => {
    if (rule.id === draft.id) return scrollToEditor()
    if (!(await confirmDiscard())) return
    const next = ruleToDraft(rule)
    setDraft(next)
    setSavedFingerprint(fingerprint(next))
    setFormError('')
    if (rule.workbook_id) void loadWorkbookDetail(rule.workbook_id)
    scrollToEditor()
  }

  const chooseWorkbook = async (value: string) => {
    setDraft((current) => ({ ...current, workbookId: value, sheetId: '', watchedColumns: [], conditions: [], approvalRanges: [] }))
    if (value) await loadWorkbookDetail(Number(value))
  }

  const updateCondition = (index: number, next: Partial<AutomationCondition>) =>
    setDraft((current) => ({ ...current, conditions: current.conditions.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item)) }))
  const updateApproval = (index: number, next: Partial<AutomationApprovalStep>) =>
    setDraft((current) => ({ ...current, approvalSteps: current.approvalSteps.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item)) }))
  const updateAction = (index: number, next: Partial<AutomationAction>) =>
    setDraft((current) => ({ ...current, actions: current.actions.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item)) }))

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
    // Holding edits only makes sense for cell-change rules with an approval step.
    hold_changes: draft.triggerType === 'cell_change' && draft.approvalSteps.length > 0 && draft.holdChanges,
    enabled: draft.enabled,
  })

  const validateDraft = () => {
    if (!draft.name.trim()) return '请填写规则名称'
    if (!draft.ownerId) return '请选择规则负责人'
    if (draft.triggerType === 'cell_change' && !draft.sheetId) return '“单元格变化”规则必须选择工作表'
    if (draft.triggerType === 'schedule' && !draft.cronExpr.trim()) return '定时规则必须填写 Cron 表达式'
    if ((draft.conditions.length > 0 || draft.actions.some((action) => action.type === 'update_cell')) && !draft.sheetId) return '使用行条件或回写动作时必须选择工作表'
    if (draft.conditions.some((condition) => !condition.column)) return '请为每个条件选择列'
    if (draft.approvalSteps.some((step) => step.user_ids.length + step.department_ids.length === 0)) return '每个审批步骤至少选择一名员工或一个部门'
    if (draft.holdChanges && draft.triggerType === 'cell_change' && draft.approvalSteps.length === 0) return '开启“暂存修改待审批”时至少需要一个审批步骤'
    if (draft.actions.length === 0 && !(draft.holdChanges && draft.triggerType === 'cell_change')) return '至少添加一个执行动作'
    if (draft.actions.some((action) => action.type === 'notify' && action.recipient_type === 'users_departments' && (action.user_ids?.length || 0) + (action.department_ids?.length || 0) === 0)) return '通知动作选择了“指定员工或部门”，但没有选择接收人'
    if (draft.actions.some((action) => action.type === 'channel_message' && (!action.channel_id || !action.message_template?.trim()))) return '频道消息动作必须选择频道并填写消息内容'
    if (draft.actions.some((action) => action.type === 'update_cell' && !action.target_column)) return '回写动作必须选择目标列'
    return ''
  }

  const saveRule = async () => {
    const validationError = validateDraft()
    if (validationError) {
      setFormError(validationError)
      toast.error(validationError)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const response = draft.id ? await api.put<AutomationRule>(`/automation/rules/${draft.id}`, buildPayload()) : await api.post<AutomationRule>('/automation/rules', buildPayload())
      ensureOk(response, '保存规则失败')
      toast.success(draft.id ? '规则已更新' : '规则已创建')
      await loadData(response.data?.id)
    } catch (error) {
      const message = errorText(error, '保存规则失败')
      setFormError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = async () => {
    if (!draft.id) return
    const ok = await confirm({
      title: `删除自动化规则「${draft.name}」？`,
      consequences: ['规则立即停止触发，定时计划被移除', '历史运行记录会保留', '如只是暂时不用，可以关闭“启用此规则”'],
      confirmText: '删除规则',
    })
    if (!ok) return
    setSaving(true)
    try {
      ensureOk(await api.delete(`/automation/rules/${draft.id}`), '删除规则失败')
      toast.success('规则已删除')
      const next = emptyDraft(profileId)
      setDraft(next)
      setSavedFingerprint(fingerprint(next))
      await loadData()
    } catch (error) {
      toast.error(errorText(error, '删除规则失败'))
    } finally {
      setSaving(false)
    }
  }

  const needsRow = draft.conditions.length > 0 || draft.actions.some((action) => action.type === 'update_cell')

  const runRule = async () => {
    if (!draft.id) return
    let rowIndex: number | undefined
    if (needsRow) {
      const displayRow = Number(triggerRow)
      if (!Number.isInteger(displayRow) || displayRow < 2) {
        toast.error('行号必须是大于等于 2 的整数')
        return
      }
      rowIndex = displayRow - 2
    }
    setSaving(true)
    try {
      const response = await api.post<AutomationRun>(`/automation/rules/${draft.id}/trigger`, rowIndex === undefined ? {} : { row_index: rowIndex })
      ensureOk(response, '运行失败')
      setTriggerOpen(false)
      const status = response.data?.status
      if (status === 'failed') toast.error(`运行失败：${response.data?.error_message || '请查看运行详情'}`)
      else toast.success(status === 'waiting_approval' ? '已发起，正在等待审批' : '规则已执行')
      await loadRuns()
    } catch (error) {
      toast.error(errorText(error, '运行失败'))
    } finally {
      setSaving(false)
    }
  }

  const openRunDetail = async (runId: number) => {
    setDetailLoading(true)
    setDetail(null)
    try {
      const response = await api.get<AutomationRunDetail>(`/automation/runs/${runId}`)
      ensureOk(response, '加载运行详情失败')
      setDetail(response.data || null)
    } catch (error) {
      toast.error(errorText(error, '加载运行详情失败'))
      setDetailLoading(false)
      return
    }
    setDetailLoading(false)
  }

  const waitingRuns = runs.filter((run) => run.status === 'waiting_approval').length
  const failedRuns = runs.filter((run) => run.status === 'failed').length
  const isCellChange = draft.triggerType === 'cell_change'

  return (
    <AdminShell
      title="流程自动化"
      description="表格变化 / 定时 / 手动触发的审批、通知与回写"
      help={automationHelp}
      actions={
        <Button variant="primary" icon={Plus} onClick={() => void startCreate()}>
          <span className="hidden sm:inline">新建规则</span>
          <span className="sm:hidden">新建</span>
        </Button>
      }
    >
      <StatGrid
        items={[
          { label: '规则总数', value: rules.length, icon: Workflow },
          { label: '已启用', value: rules.filter((rule) => rule.enabled).length, icon: CheckCircle2, tone: 'emerald' },
          { label: '等待审批（近 20 次）', value: waitingRuns, icon: Hourglass, tone: waitingRuns ? 'amber' : 'slate' },
          { label: '失败（近 20 次）', value: failedRuns, icon: XCircle, tone: failedRuns ? 'rose' : 'slate' },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadData(draft.id)}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      <div className="grid gap-3 xl:grid-cols-[300px_minmax(0,1fr)]">
        <SectionCard title="自动化规则" description="点击规则进行编辑" icon={Workflow} flush className="xl:sticky xl:top-[84px] xl:self-start">
          <div className="border-b border-slate-200 p-3">
            <SearchInput value={ruleSearch} onChange={setRuleSearch} placeholder="搜索规则、工作表或负责人" />
          </div>
          <div className="max-h-[420px] overflow-y-auto xl:max-h-[calc(100vh-260px)]">
            {loading && rules.length === 0 ? (
              <LoadingState compact />
            ) : filteredRules.length === 0 ? (
              <EmptyState compact icon={Workflow} title={rules.length ? '没有匹配的规则' : '还没有规则'} description={rules.length ? undefined : '右侧表单已准备好，填写后保存即可创建第一条规则。'} />
            ) : (
              <ul className="divide-y divide-slate-100">
                {filteredRules.map((rule) => {
                  const last = rule.last_status ? statusMeta[rule.last_status] : null
                  return (
                    <li key={rule.id}>
                      <button
                        type="button"
                        onClick={() => void chooseRule(rule)}
                        className={`block min-h-14 w-full px-4 py-2.5 text-left transition ${draft.id === rule.id ? 'bg-sky-50' : 'hover:bg-slate-50'}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${rule.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} title={rule.enabled ? '已启用' : '已停用'} />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{rule.name}</span>
                          {last && <StatusBadge tone={last.tone}>{last.label}</StatusBadge>}
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 pl-4 text-xs text-slate-400">
                          <span>{triggerLabels[rule.trigger_type]}</span>
                          <span className="truncate">{rule.sheet_name || '未关联工作表'}</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </SectionCard>

        <div ref={editorRef} className="min-w-0 scroll-mt-32 space-y-3">
          <SectionCard
            title={draft.id ? `编辑规则：${selectedRule?.name || draft.name}` : '新建规则'}
            description="按“基本信息 → 触发与条件 → 审批 → 动作”的顺序配置。"
            icon={draft.id ? PencilLine : Plus}
            iconTone="sky"
            actions={
              draft.id ? (
                <>
                  {dirty ? <StatusBadge tone="amber">未保存</StatusBadge> : <StatusBadge tone={draft.enabled ? 'emerald' : 'slate'} dot>{draft.enabled ? '已启用' : '已停用'}</StatusBadge>}
                </>
              ) : undefined
            }
          >
            <div className="space-y-4">
              {formError && <Notice tone="danger" onClose={() => setFormError('')}>{formError}</Notice>}
              {selectedRule && (selectedRule.last_message || selectedRule.next_run_at || selectedRule.last_triggered_at) && (
                <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  {selectedRule.last_triggered_at && <span>上次触发：{formatDateTime(selectedRule.last_triggered_at)}</span>}
                  {selectedRule.last_message && <span>结果：{selectedRule.last_message}</span>}
                  {selectedRule.next_run_at && <span>下次运行：{formatDateTime(selectedRule.next_run_at)}</span>}
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="规则名称" required>
                  <TextInput value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} maxLength={160} placeholder="例如：采购金额超 5 万需审批" />
                </Field>
                <Field label="负责人" required hint="规则以负责人身份运行：回写、发频道消息都以此人名义，且此人需能管理所选工作簿。">
                  <SelectInput value={draft.ownerId} onChange={(event) => setDraft((current) => ({ ...current, ownerId: event.target.value }))}>
                    <option value="">请选择</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <Field label="说明" className="md:col-span-2">
                  <TextArea rows={2} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder="可选：这条规则解决什么问题" />
                </Field>
                <SwitchField
                  className="md:col-span-2"
                  label="启用此规则"
                  hint={draft.enabled ? '启用后按触发方式自动运行。' : '停用后不会触发，也不能手动运行；配置保留。'}
                  checked={draft.enabled}
                  onChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard title="1. 触发与条件" description="决定什么时候检查、检查哪一行。" icon={Zap} iconTone="sky">
            <div className="space-y-4">
              <Field label="触发方式" group>
                <div className="grid gap-2 sm:grid-cols-3">
                  {triggerOptions.map((option) => {
                    const Icon = option.icon
                    const active = draft.triggerType === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setDraft((current) => ({ ...current, triggerType: option.value }))}
                        aria-pressed={active}
                        className={`flex min-h-14 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${active ? 'border-sky-300 bg-sky-50' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-sky-700' : 'text-slate-400'}`} />
                        <span>
                          <span className="block text-sm font-medium text-slate-800">{option.label}</span>
                          <span className="block text-xs text-slate-500">{option.hint}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Field>

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="工作簿" hint={isCellChange ? '单元格变化规则必须关联工作表。' : '可选；使用条件或回写时必须关联。'}>
                  <SelectInput value={draft.workbookId} onChange={(event) => void chooseWorkbook(event.target.value)}>
                    <option value="">不关联工作簿</option>
                    {workbooks.map((workbook) => (
                      <option key={workbook.id} value={workbook.id}>
                        {workbook.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
                <Field label="工作表">
                  <SelectInput
                    value={draft.sheetId}
                    disabled={!draft.workbookId}
                    onChange={(event) => setDraft((current) => ({ ...current, sheetId: event.target.value, watchedColumns: [], conditions: [], approvalRanges: [] }))}
                  >
                    <option value="">{draft.workbookId ? '请选择工作表' : '先选择工作簿'}</option>
                    {selectedWorkbook?.sheets?.map((sheet) => (
                      <option key={sheet.id} value={sheet.id}>
                        {sheet.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </div>

              {draft.triggerType === 'schedule' && (
                <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Cron 表达式" required hint="分 时 日 月 周，例如 0 9 * * 1-5 = 工作日 9:00。">
                      <TextInput value={draft.cronExpr} onChange={(event) => setDraft((current) => ({ ...current, cronExpr: event.target.value }))} placeholder="0 9 * * 1-5" className="font-mono" />
                    </Field>
                    <Field label="时区" hint="按该时区计算执行时间。">
                      <TextInput list="automation-timezones" value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} placeholder="Asia/Shanghai" />
                      <datalist id="automation-timezones">
                        <option value="Asia/Shanghai" />
                        <option value="UTC" />
                        <option value="Europe/Rome" />
                        <option value="America/New_York" />
                      </datalist>
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {cronPresets.map((preset) => (
                      <Chip key={preset.value} active={draft.cronExpr.trim() === preset.value} onClick={() => setDraft((current) => ({ ...current, cronExpr: preset.value }))}>
                        {preset.label}
                      </Chip>
                    ))}
                  </div>
                  {draft.sheetId && needsRow && <p className="text-xs text-slate-500">已关联工作表并设置了条件 / 回写：每次运行会对所有满足条件的行各执行一次（最多扫描 10000 行）。</p>}
                </div>
              )}

              {isCellChange && draft.sheetId && (
                <Field label="监听列" group hint="只有这些列被修改时才检查；不选表示任意列变化都检查。">
                  {columns.length === 0 ? (
                    <p className="text-xs text-slate-400">该工作表没有列定义。</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {columns.map((column) => (
                        <Chip
                          key={column.key}
                          active={draft.watchedColumns.includes(column.key)}
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              watchedColumns: current.watchedColumns.includes(column.key) ? current.watchedColumns.filter((key) => key !== column.key) : [...current.watchedColumns, column.key],
                            }))
                          }
                        >
                          {column.name || column.key}
                        </Chip>
                      ))}
                    </div>
                  )}
                </Field>
              )}

              <div className="border-t border-slate-100 pt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">行数据条件</div>
                    <div className="text-xs text-slate-500">{draft.conditions.length === 0 ? '不设条件 = 每次触发都执行。' : '比较的是触发行当前的值。'}</div>
                  </div>
                  <div className="flex gap-2">
                    {draft.conditions.length > 1 && (
                      <SelectInput value={draft.conditionLogic} onChange={(event) => setDraft((current) => ({ ...current, conditionLogic: event.target.value as 'all' | 'any' }))} className="w-36!" aria-label="条件逻辑">
                        <option value="all">满足全部条件</option>
                        <option value="any">满足任一条件</option>
                      </SelectInput>
                    )}
                    <Button
                      size="sm"
                      icon={Plus}
                      disabled={!draft.sheetId}
                      title={draft.sheetId ? '添加条件' : '先选择工作表'}
                      onClick={() => setDraft((current) => ({ ...current, conditions: [...current.conditions, { column: columns[0]?.key || '', operator: 'eq', value: '' }] }))}
                    >
                      添加条件
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {draft.conditions.map((condition, index) => (
                    <div key={index} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-[minmax(130px,1fr)_140px_minmax(140px,1fr)_auto]">
                      <SelectInput value={condition.column} onChange={(event) => updateCondition(index, { column: event.target.value })} aria-label="条件列">
                        <option value="">选择列</option>
                        {columns.map((column) => (
                          <option key={column.key} value={column.key}>
                            {column.name || column.key}
                          </option>
                        ))}
                      </SelectInput>
                      <SelectInput value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as AutomationConditionOperator })} aria-label="比较方式">
                        {operatorOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </SelectInput>
                      <TextInput
                        value={condition.value === undefined || condition.value === null ? '' : String(condition.value)}
                        onChange={(event) => updateCondition(index, { value: event.target.value })}
                        disabled={condition.operator === 'is_empty' || condition.operator === 'not_empty'}
                        placeholder={condition.operator === 'in' ? '多个值用逗号分隔' : condition.operator === 'regex' ? '正则，如 ^PO-' : '比较值'}
                        aria-label="比较值"
                      />
                      <IconButton icon={X} label="删除条件" variant="ghost" onClick={() => setDraft((current) => ({ ...current, conditions: current.conditions.filter((_, itemIndex) => itemIndex !== index) }))} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="2. 审批"
            description="可选。审批人在「任务中心」处理；任一步拒绝则流程结束。"
            icon={UserCheck}
            iconTone="amber"
            actions={
              <Button
                size="sm"
                icon={Plus}
                onClick={() => setDraft((current) => ({ ...current, approvalSteps: [...current.approvalSteps, { name: `审批步骤 ${current.approvalSteps.length + 1}`, user_ids: [], department_ids: [], required_approvals: 1 }] }))}
              >
                添加审批步骤
              </Button>
            }
          >
            <div className="space-y-3">
              {draft.approvalSteps.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">无需审批：触发后直接执行下方动作。</div>
              ) : (
                draft.approvalSteps.map((step, index) => (
                  <div key={index} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-3 grid gap-2 sm:grid-cols-[36px_minmax(160px,1fr)_170px_auto] sm:items-center">
                      <span className="hidden h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white sm:flex">{index + 1}</span>
                      <TextInput value={step.name} onChange={(event) => updateApproval(index, { name: event.target.value })} placeholder={`审批步骤 ${index + 1}`} aria-label="步骤名称" />
                      <label className="flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 md:h-9">
                        需
                        <input
                          type="number"
                          min={1}
                          value={step.required_approvals}
                          onChange={(event) => updateApproval(index, { required_approvals: Math.max(1, Number(event.target.value) || 1) })}
                          className="w-12 min-w-0 flex-1 bg-transparent text-center outline-none"
                        />
                        人同意
                      </label>
                      <IconButton icon={Trash2} label="删除步骤" variant="ghost" onClick={() => setDraft((current) => ({ ...current, approvalSteps: current.approvalSteps.filter((_, itemIndex) => itemIndex !== index) }))} />
                    </div>
                    <MultiPicker
                      users={users}
                      departments={departments}
                      userIds={step.user_ids}
                      departmentIds={step.department_ids}
                      onUsersChange={(ids) => updateApproval(index, { user_ids: ids })}
                      onDepartmentsChange={(ids) => updateApproval(index, { department_ids: ids })}
                    />
                  </div>
                ))
              )}

              {isCellChange && (
                <SwitchField
                  tone="warning"
                  label="暂存修改待审批"
                  hint={
                    draft.approvalSteps.length === 0
                      ? '需要先添加至少一个审批步骤。开启后，员工对监听列的修改不会立即生效，审批通过才写入。'
                      : draft.holdChanges
                        ? '已开启：员工修改监听列（未选则为全部列）的单元格后，修改进入“待审批”，通过才写入，拒绝则丢弃。'
                        : '关闭：修改立即生效，审批只控制后续动作是否执行。'
                  }
                  checked={draft.holdChanges && draft.approvalSteps.length > 0}
                  disabled={draft.approvalSteps.length === 0}
                  onChange={(value) => setDraft((current) => ({ ...current, holdChanges: value }))}
                />
              )}
              {draft.approvalRanges.length > 0 && (
                <Notice tone="info">
                  该规则还限定了 {draft.approvalRanges.length} 个审批区域（通常由表格内的审批设置或 AI 助手创建），只有区域内的单元格会被暂存。保存时会保留这些区域。
                </Notice>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="3. 执行动作"
            description="审批通过（或无需审批）后按顺序执行；任一动作失败，后续动作不再执行。"
            icon={GitBranch}
            iconTone="emerald"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={BellRing} onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'notify', recipient_type: 'owner', title_template: '', message_template: '' }] }))}>
                  通知
                </Button>
                <Button size="sm" icon={MessageSquare} onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'channel_message', message_template: '', send_whatsapp: false }] }))}>
                  频道消息
                </Button>
                <Button
                  size="sm"
                  icon={PencilLine}
                  disabled={!draft.sheetId}
                  title={draft.sheetId ? '添加单元格回写' : '先选择工作表'}
                  onClick={() => setDraft((current) => ({ ...current, actions: [...current.actions, { type: 'update_cell', target_column: '', value_template: '' }] }))}
                >
                  回写
                </Button>
              </div>
            }
          >
            <div className="space-y-3">
              {draft.actions.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                  {draft.holdChanges && isCellChange ? '暂存审批规则可以不设动作：审批通过即写入修改。' : '至少添加一个动作。'}
                </div>
              )}
              {draft.actions.map((action, index) => {
                const meta = actionMeta[action.type]
                const Icon = meta.icon
                return (
                  <div key={index} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-800">
                          {index + 1}. {meta.label}
                        </div>
                        <div className="text-xs text-slate-500">{meta.hint}</div>
                      </div>
                      <IconButton icon={Trash2} label="删除动作" variant="ghost" onClick={() => setDraft((current) => ({ ...current, actions: current.actions.filter((_, itemIndex) => itemIndex !== index) }))} />
                    </div>

                    {action.type === 'notify' && (
                      <div className="space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Field label="接收人">
                            <SelectInput value={action.recipient_type || 'owner'} onChange={(event) => updateAction(index, { recipient_type: event.target.value as AutomationAction['recipient_type'] })}>
                              <option value="owner">规则负责人</option>
                              <option value="trigger_user">触发人（修改表格 / 点击运行的人）</option>
                              <option value="users_departments">指定员工或部门</option>
                            </SelectInput>
                          </Field>
                          <Field label="标题" hint="留空则为“自动化提醒：规则名”。">
                            <TextInput value={action.title_template || ''} onChange={(event) => updateAction(index, { title_template: event.target.value })} placeholder="例如：{{row.A}} 需要处理" />
                          </Field>
                        </div>
                        <Field label="内容">
                          <TextArea rows={2} value={action.message_template || ''} onChange={(event) => updateAction(index, { message_template: event.target.value })} placeholder="通知正文，可插入变量" />
                        </Field>
                        <VariableChips columns={columns} onInsert={(token) => updateAction(index, { message_template: `${action.message_template || ''}${token}` })} />
                        {action.recipient_type === 'users_departments' && (
                          <MultiPicker
                            users={users}
                            departments={departments}
                            userIds={action.user_ids || []}
                            departmentIds={action.department_ids || []}
                            onUsersChange={(ids) => updateAction(index, { user_ids: ids })}
                            onDepartmentsChange={(ids) => updateAction(index, { department_ids: ids })}
                          />
                        )}
                      </div>
                    )}

                    {action.type === 'channel_message' && (
                      <div className="space-y-3">
                        <Field label="频道" required hint="负责人必须是该频道成员。">
                          <SelectInput value={action.channel_id || ''} onChange={(event) => updateAction(index, { channel_id: event.target.value ? Number(event.target.value) : undefined })}>
                            <option value="">选择频道</option>
                            {channels.map((channel) => (
                              <option key={channel.id} value={channel.id}>
                                {channel.name}
                              </option>
                            ))}
                          </SelectInput>
                        </Field>
                        <Field label="消息内容" required>
                          <TextArea rows={2} value={action.message_template || ''} onChange={(event) => updateAction(index, { message_template: event.target.value })} placeholder="例如：{{sheet.name}} 第 {{row.number}} 行已审批" />
                        </Field>
                        <VariableChips columns={columns} onInsert={(token) => updateAction(index, { message_template: `${action.message_template || ''}${token}` })} />
                        <SwitchField label="同时转发到 WhatsApp" hint="转发到该频道关联的 WhatsApp 会话（需先在频道中关联）。" checked={Boolean(action.send_whatsapp)} onChange={(value) => updateAction(index, { send_whatsapp: value })} />
                      </div>
                    )}

                    {action.type === 'update_cell' && (
                      <div className="space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Field label="目标列" required>
                            <SelectInput value={action.target_column || ''} onChange={(event) => updateAction(index, { target_column: event.target.value })}>
                              <option value="">选择列</option>
                              {columns.map((column) => (
                                <option key={column.key} value={column.key}>
                                  {column.name || column.key}
                                </option>
                              ))}
                            </SelectInput>
                          </Field>
                          <Field label="写入值" hint="纯文本或变量；数字 / JSON 会按原类型写入。">
                            <TextInput value={action.value_template || ''} onChange={(event) => updateAction(index, { value_template: event.target.value })} placeholder="例如：已审批" />
                          </Field>
                        </div>
                        <VariableChips columns={columns} onInsert={(token) => updateAction(index, { value_template: `${action.value_template || ''}${token}` })} />
                        {action.target_column && <p className="text-xs text-slate-500">将写入触发行的「{columnName(action.target_column)}」列。</p>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </SectionCard>

          <StickyActions pinned={dirty} note={dirty ? <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />有未保存的修改</span> : draft.id ? '已保存' : '填写完成后点击“创建规则”'}>
            {draft.id && (
              <Button variant="danger-outline" icon={Trash2} disabled={saving} onClick={() => void deleteRule()}>
                删除
              </Button>
            )}
            {draft.id && draft.triggerType === 'manual' && (
              <Button
                icon={CirclePlay}
                disabled={saving || dirty || !draft.enabled}
                title={dirty ? '请先保存' : !draft.enabled ? '规则已停用' : '立即运行'}
                onClick={() => (needsRow ? setTriggerOpen(true) : void runRule())}
              >
                立即运行
              </Button>
            )}
            <Button variant="primary" icon={Save} loading={saving} disabled={!dirty && Boolean(draft.id)} onClick={() => void saveRule()}>
              {draft.id ? '保存规则' : '创建规则'}
            </Button>
          </StickyActions>
        </div>
      </div>

      <SectionCard
        title="最近运行"
        description="最近 20 次运行。点击查看审批进度、执行日志和错误原因。"
        icon={Clock3}
        flush
        actions={<IconButton icon={RefreshCw} label="刷新运行记录" spin={loading} onClick={() => void loadRuns()} />}
      >
        {runs.length === 0 ? (
          <EmptyState compact icon={Clock3} title="暂无运行记录" description="规则被触发后会出现在这里。" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {runs.map((run) => {
              const meta = statusMeta[run.status] || statusMeta.cancelled
              return (
                <li key={run.id}>
                  <button type="button" onClick={() => void openRunDetail(run.id)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-900">{run.rule_name || `规则 #${run.rule_id ?? '已删除'}`}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-400">
                        <span>{triggerLabels[run.trigger_type]}</span>
                        {run.workbook_name && (
                          <span className="inline-flex items-center gap-1">
                            <FileSpreadsheet className="h-3 w-3" />
                            {run.workbook_name} / {run.sheet_name}
                            {run.row_index !== undefined && run.row_index !== null && ` · 第 ${run.row_index + 2} 行`}
                          </span>
                        )}
                        <span>{formatDateTime(run.created_at)}</span>
                        {run.triggered_by_name && <span>触发人 {run.triggered_by_name}</span>}
                      </div>
                    </div>
                    <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      {/* Manual trigger */}
      <Modal
        open={triggerOpen}
        onClose={() => setTriggerOpen(false)}
        busy={saving}
        title="立即运行"
        description="该规则带有条件或回写动作，需要指定对哪一行运行。"
        icon={CirclePlay}
        size="sm"
        footer={
          <>
            <Button onClick={() => setTriggerOpen(false)} disabled={saving}>取消</Button>
            <Button variant="primary" icon={CirclePlay} loading={saving} onClick={() => void runRule()}>
              运行
            </Button>
          </>
        }
      >
        <Field label="数据行号" hint="与表格左侧行号一致；表头下第一行是第 2 行。若该行不满足条件，运行会被拒绝。">
          <TextInput type="number" min={2} value={triggerRow} onChange={(event) => setTriggerRow(event.target.value)} />
        </Field>
      </Modal>

      {/* Run detail */}
      <Modal
        open={Boolean(detail) || detailLoading}
        onClose={() => {
          setDetail(null)
          setDetailLoading(false)
        }}
        title={detail ? detail.run.rule_name || '运行详情' : '运行详情'}
        description={detail ? `运行 #${detail.run.id} · ${formatDateTime(detail.run.created_at)}` : undefined}
        icon={Workflow}
        size="lg"
      >
        {detailLoading && !detail ? (
          <LoadingState compact label="正在加载运行详情…" />
        ) : (
          detail && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={(statusMeta[detail.run.status] || statusMeta.cancelled).tone}>{(statusMeta[detail.run.status] || statusMeta.cancelled).label}</StatusBadge>
                {detail.run.triggered_by_name && <span className="text-xs text-slate-500">触发人：{detail.run.triggered_by_name}</span>}
              </div>
              {detail.run.error_message && <Notice tone="danger">{detail.run.error_message}</Notice>}
              {detail.approvals.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">审批进度</h4>
                  <div className="space-y-2">
                    {detail.approvals.map((approval) => (
                      <div key={approval.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-800">
                            {approval.step_index + 1}. {approval.name}
                          </span>
                          <span className="text-xs text-slate-500">
                            已同意 {approval.approved_count}/{approval.required_approvals}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {approval.assignees.map((assignee) => (
                            <StatusBadge key={assignee.user_id} tone={assignee.status === 'approved' ? 'emerald' : assignee.status === 'rejected' ? 'rose' : 'slate'}>
                              {assignee.username} · {assigneeStatus[assignee.status] || assignee.status}
                            </StatusBadge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h4 className="mb-2 text-sm font-semibold text-slate-800">执行日志</h4>
                {detail.logs.length === 0 ? (
                  <p className="text-xs text-slate-500">暂无日志。</p>
                ) : (
                  <div className="space-y-2">
                    {detail.logs.map((log) => {
                      const Icon = log.level === 'error' ? XCircle : log.level === 'warning' ? AlertTriangle : log.level === 'info' ? CheckCircle2 : Info
                      return (
                        <div key={log.id} className="flex gap-3 rounded-lg bg-slate-50 px-3 py-2">
                          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${log.level === 'error' ? 'text-rose-500' : log.level === 'warning' ? 'text-amber-500' : 'text-emerald-500'}`} />
                          <div className="min-w-0">
                            <div className="break-words text-sm text-slate-700">{log.message || runEventLabels[log.event] || log.event}</div>
                            <div className="mt-0.5 text-xs text-slate-400">{formatDateTime(log.created_at)}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </Modal>
    </AdminShell>
  )
}
