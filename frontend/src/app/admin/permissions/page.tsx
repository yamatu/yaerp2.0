'use client'

import {
  Building2,
  Columns3,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  PencilLine,
  Plus,
  RefreshCw,
  Rows3,
  Save,
  ScanSearch,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { permissionsHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  CheckboxRow,
  DataTable,
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
  SwitchField,
  TextArea,
  TextInput,
  type DataColumn,
} from '@/components/admin/ui'
import api from '@/lib/api'
import { resolveCellPermissionDetail } from '@/hooks/usePermission'
import type { ColumnDef, Department, PageData, PermissionMatrix, User, Workbook } from '@/types'

type PrincipalType = 'department' | 'user'
type RangePermission = 'none' | 'read' | 'write'
type ScopeType = 'column' | 'row' | 'cell'
type SheetPermissionKey = 'can_view' | 'can_edit' | 'can_delete' | 'can_export'

interface SheetOption {
  id: number
  name: string
  workbookId: number
  workbookName: string
  columns: Array<Pick<ColumnDef, 'key' | 'name'>>
}

interface SheetPermission {
  id?: number
  can_view: boolean
  can_edit: boolean
  can_delete: boolean
  can_export: boolean
}

interface RangeRule {
  id: number
  sheet_id: number
  principal_type: PrincipalType
  principal_id: number
  column_key: string
  row_index?: number
  permission: RangePermission
}

interface PermissionConfig {
  sheet: SheetPermission
  rows: RangeRule[]
  columns: RangeRule[]
  cells: RangeRule[]
}

const emptySheetPermission: SheetPermission = { can_view: false, can_edit: false, can_delete: false, can_export: false }

const sheetPermissionOptions: Array<{ key: SheetPermissionKey; label: string; hint: string }> = [
  { key: 'can_view', label: '查看', hint: '打开工作表并读取未被遮盖的内容' },
  { key: 'can_edit', label: '编辑', hint: '修改单元格（区域规则可再收紧）' },
  { key: 'can_delete', label: '删除', hint: '删除行等删除类操作' },
  { key: 'can_export', label: '导出', hint: '下载 Excel / PDF' },
]

const permissionOptions: Array<{ value: RangePermission; label: string; description: string; tone: 'rose' | 'sky' | 'emerald' }> = [
  { value: 'none', label: '不可见', description: '服务器端遮盖内容，界面、导出和 AI 都拿不到原值', tone: 'rose' },
  { value: 'read', label: '只读', description: '可以查看但不能修改', tone: 'sky' },
  { value: 'write', label: '可编辑', description: '可以查看并修改', tone: 'emerald' },
]

const displayRowToDataRow = (value: number) => Math.max(0, value - 2)
const dataRowToDisplayRow = (value?: number) => (value ?? 0) + 2

interface DepartmentDraft {
  id?: number
  name: string
  description: string
  memberIds: number[]
}

export default function PermissionsPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [departments, setDepartments] = useState<Department[]>([])
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [sheets, setSheets] = useState<SheetOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Department editor
  const [deptDraft, setDeptDraft] = useState<DepartmentDraft | null>(null)
  const [deptError, setDeptError] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [deptSaving, setDeptSaving] = useState(false)

  // Sheet permission editor
  const [selectedSheetId, setSelectedSheetId] = useState<number | null>(null)
  const [principalType, setPrincipalType] = useState<PrincipalType>('department')
  const [principalId, setPrincipalId] = useState<number | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [sheetPermission, setSheetPermission] = useState<SheetPermission>(emptySheetPermission)
  const [savedSheetPermission, setSavedSheetPermission] = useState<SheetPermission>(emptySheetPermission)
  const [inheritSheetPermission, setInheritSheetPermission] = useState(true)
  const [savedInherit, setSavedInherit] = useState(true)
  const [rangeRules, setRangeRules] = useState<RangeRule[]>([])
  const [savedRulePermissions, setSavedRulePermissions] = useState<Record<number, RangePermission>>({})
  const [scopeType, setScopeType] = useState<ScopeType>('column')
  const [draftColumn, setDraftColumn] = useState('')
  const [draftDisplayRow, setDraftDisplayRow] = useState(2)
  const [draftPermission, setDraftPermission] = useState<RangePermission>('none')
  const [busy, setBusy] = useState('')

  // Effective permission preview
  const [previewUserId, setPreviewUserId] = useState<number | null>(null)
  const [previewColumn, setPreviewColumn] = useState('')
  const [previewDisplayRow, setPreviewDisplayRow] = useState(2)
  const [effectiveMatrix, setEffectiveMatrix] = useState<PermissionMatrix | null>(null)

  /** Active, non-admin employees: the only accounts permissions apply to. */
  const users = useMemo(() => allUsers.filter((user) => user.status === 1 && !user.roles?.some((role) => role.code === 'admin')), [allUsers])
  const activeUserIds = useMemo(() => new Set(allUsers.filter((user) => user.status === 1).map((user) => user.id)), [allUsers])

  const loadDepartments = useCallback(async () => {
    const response = await api.get<Department[]>('/departments')
    ensureOk(response, '加载部门失败')
    const items = Array.isArray(response.data) ? response.data : []
    setDepartments(items)
    return items
  }, [])

  const loadInitialData = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [departmentItems, userResponse, workbookResponse] = await Promise.all([
        loadDepartments(),
        api.get<PageData<User>>('/users?page=1&size=1000'),
        api.get<Workbook[]>('/workbooks'),
      ])
      ensureOk(userResponse, '加载员工失败')
      ensureOk(workbookResponse, '加载工作簿失败')
      const userItems = userResponse.data?.list || []
      setAllUsers(userItems)

      const workbookItems = workbookResponse.data || []
      const details = await Promise.all(workbookItems.map((workbook) => api.get<Workbook>(`/workbooks/${workbook.id}`).catch(() => null)))
      const sheetItems = details.flatMap((response, index) =>
        response && response.code === 0 && response.data?.sheets
          ? response.data.sheets.map((sheet) => ({
              id: sheet.id,
              name: sheet.name,
              workbookId: workbookItems[index].id,
              workbookName: workbookItems[index].name,
              columns: Array.isArray(sheet.columns) ? sheet.columns.map((column) => ({ key: column.key, name: column.name || column.key })) : [],
            }))
          : [],
      )
      setSheets(sheetItems)
      setSelectedSheetId((current) => (current && sheetItems.some((item) => item.id === current) ? current : sheetItems[0]?.id ?? null))
      const eligibleUsers = userItems.filter((user) => user.status === 1 && !user.roles?.some((role) => role.code === 'admin'))
      if (departmentItems.length === 0 && eligibleUsers.length > 0) setPrincipalType('user')
    } catch (error) {
      setLoadError(errorText(error, '权限数据加载失败，请刷新后重试'))
    } finally {
      setLoading(false)
    }
  }, [loadDepartments])

  useEffect(() => {
    void loadInitialData()
  }, [loadInitialData])

  const principalOptions = useMemo(
    () =>
      principalType === 'department'
        ? departments.map((department) => ({ id: department.id, label: `${department.name}（${department.member_count} 人）` }))
        : users.map((user) => ({ id: user.id, label: user.username })),
    [departments, principalType, users],
  )

  useEffect(() => {
    if (principalOptions.length === 0) {
      if (principalId !== null) setPrincipalId(null)
      return
    }
    if (!principalId || !principalOptions.some((item) => item.id === principalId)) setPrincipalId(principalOptions[0].id)
  }, [principalId, principalOptions])

  const selectedSheet = sheets.find((item) => item.id === selectedSheetId) || null

  useEffect(() => {
    const first = selectedSheet?.columns[0]?.key || ''
    if (!selectedSheet?.columns.some((column) => column.key === draftColumn)) setDraftColumn(first)
    if (!selectedSheet?.columns.some((column) => column.key === previewColumn)) setPreviewColumn(first)
  }, [draftColumn, previewColumn, selectedSheet])

  useEffect(() => {
    if (users.length === 0) {
      if (previewUserId !== null) setPreviewUserId(null)
      return
    }
    if (!previewUserId || !users.some((user) => user.id === previewUserId)) setPreviewUserId(users[0].id)
  }, [previewUserId, users])

  const applyConfig = (config: PermissionConfig | null) => {
    const sheet = config?.sheet
      ? { id: config.sheet.id, can_view: !!config.sheet.can_view, can_edit: !!config.sheet.can_edit, can_delete: !!config.sheet.can_delete, can_export: !!config.sheet.can_export }
      : emptySheetPermission
    const inherit = !config?.sheet?.id
    setSheetPermission(sheet)
    setSavedSheetPermission(sheet)
    setInheritSheetPermission(inherit)
    setSavedInherit(inherit)
    const rules = config ? [...(config.columns || []), ...(config.rows || []), ...(config.cells || [])] : []
    setRangeRules(rules)
    setSavedRulePermissions(Object.fromEntries(rules.map((rule) => [rule.id, rule.permission])))
  }

  const loadPermissionConfig = useCallback(async () => {
    if (!selectedSheetId || !principalId) {
      applyConfig(null)
      return
    }
    setConfigLoading(true)
    try {
      const response = await api.get<PermissionConfig>(`/permissions/sheets/${selectedSheetId}/principals/${principalType}/${principalId}`)
      ensureOk(response, '读取权限配置失败')
      applyConfig(response.data || null)
    } catch (error) {
      applyConfig(null)
      toast.error(errorText(error, '读取权限配置失败'))
    } finally {
      setConfigLoading(false)
    }
    // toast is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principalId, principalType, selectedSheetId])

  useEffect(() => {
    void loadPermissionConfig()
  }, [loadPermissionConfig])

  const loadEffectiveMatrix = useCallback(async () => {
    if (!selectedSheetId || !previewUserId) {
      setEffectiveMatrix(null)
      return
    }
    try {
      const response = await api.get<PermissionMatrix>(`/permissions/sheets/${selectedSheetId}/users/${previewUserId}/effective`)
      setEffectiveMatrix(response.code === 0 && response.data ? response.data : null)
    } catch {
      setEffectiveMatrix(null)
    }
  }, [previewUserId, selectedSheetId])

  useEffect(() => {
    void loadEffectiveMatrix()
  }, [loadEffectiveMatrix])

  /* ---------------- departments ---------------- */

  const filteredMembers = useMemo(() => {
    const keyword = memberSearch.trim().toLowerCase()
    return keyword ? users.filter((user) => `${user.username} ${user.email}`.toLowerCase().includes(keyword)) : users
  }, [memberSearch, users])

  const openDepartment = (department?: Department) => {
    setDeptDraft(
      department
        ? { id: department.id, name: department.name, description: department.description || '', memberIds: department.member_ids || [] }
        : { name: '', description: '', memberIds: [] },
    )
    setDeptError('')
    setMemberSearch('')
  }

  const saveDepartment = async () => {
    if (!deptDraft) return
    const name = deptDraft.name.trim()
    if (!name) {
      setDeptError('请填写部门名称')
      return
    }
    // The API rejects disabled members; drop them instead of failing the save.
    const memberIds = deptDraft.memberIds.filter((id) => activeUserIds.has(id))
    const dropped = deptDraft.memberIds.length - memberIds.length
    setDeptSaving(true)
    setDeptError('')
    try {
      if (deptDraft.id) {
        ensureOk(await api.put(`/departments/${deptDraft.id}`, { name, description: deptDraft.description.trim() }), '保存部门失败')
        ensureOk(await api.put(`/departments/${deptDraft.id}/members`, { user_ids: memberIds }), '保存部门成员失败')
      } else {
        ensureOk(await api.post<Department>('/departments', { name, description: deptDraft.description.trim(), member_ids: memberIds }), '创建部门失败')
      }
      await loadDepartments()
      void loadEffectiveMatrix()
      setDeptDraft(null)
      toast.success(`部门「${name}」已保存${dropped > 0 ? `，并移除了 ${dropped} 名已停用的成员` : ''}`)
    } catch (error) {
      setDeptError(errorText(error, '保存部门失败'))
    } finally {
      setDeptSaving(false)
    }
  }

  const deleteDepartment = async (department: Department) => {
    const ok = await confirm({
      title: `删除部门「${department.name}」？`,
      consequences: [
        `${department.member_count} 名成员会被移出该部门（员工账号不受影响）`,
        '该部门在所有工作表上的整表权限和区域规则会一并删除',
        '成员通过该部门获得的表格访问会立即消失',
      ],
      confirmText: '删除部门',
    })
    if (!ok) return
    setBusy(`department-delete-${department.id}`)
    try {
      ensureOk(await api.delete(`/departments/${department.id}`), '删除部门失败')
      await loadDepartments()
      setDeptDraft(null)
      void loadPermissionConfig()
      void loadEffectiveMatrix()
      toast.success(`部门「${department.name}」已删除`)
    } catch (error) {
      toast.error(errorText(error, '删除部门失败'))
    } finally {
      setBusy('')
    }
  }

  /* ---------------- sheet permissions ---------------- */

  const sheetDirty =
    inheritSheetPermission !== savedInherit ||
    (!inheritSheetPermission && sheetPermissionOptions.some(({ key }) => sheetPermission[key] !== savedSheetPermission[key]))

  const saveSheetPermission = async () => {
    if (!selectedSheetId || !principalId) return
    setBusy('sheet')
    try {
      const response = inheritSheetPermission
        ? await api.delete(`/permissions/sheets/${selectedSheetId}/principals/${principalType}/${principalId}/sheet`)
        : await api.post('/permissions/principal-sheet', {
            sheet_id: selectedSheetId,
            principal_type: principalType,
            principal_id: principalId,
            ...sheetPermission,
          })
      ensureOk(response, '保存整表权限失败')
      await loadPermissionConfig()
      await loadEffectiveMatrix()
      toast.success(inheritSheetPermission ? '已改为继承，不再单独设置整表权限' : '整表权限已保存')
    } catch (error) {
      toast.error(errorText(error, '保存整表权限失败'))
    } finally {
      setBusy('')
    }
  }

  const updateSheetFlag = (key: SheetPermissionKey, value: boolean) => {
    setSheetPermission((current) => {
      const next = { ...current, [key]: value }
      // Editing, deleting or exporting a sheet you cannot see makes no sense.
      if (value && key !== 'can_view') next.can_view = true
      if (!value && key === 'can_view') return { ...emptySheetPermission, id: current.id }
      return next
    })
  }

  const addRangeRule = async () => {
    if (!selectedSheetId || !principalId) return
    const columnKey = scopeType === 'row' ? '' : draftColumn
    const rowIndex = scopeType === 'column' ? undefined : displayRowToDataRow(draftDisplayRow)
    if (scopeType !== 'row' && !columnKey) {
      toast.error('请选择列')
      return
    }
    setBusy('rule-new')
    try {
      ensureOk(
        await api.post('/permissions/principal-cell', {
          sheet_id: selectedSheetId,
          principal_type: principalType,
          principal_id: principalId,
          column_key: columnKey,
          ...(rowIndex === undefined ? {} : { row_index: rowIndex }),
          permission: draftPermission,
        }),
        '添加区域规则失败',
      )
      await loadPermissionConfig()
      void loadEffectiveMatrix()
      toast.success('区域规则已添加')
    } catch (error) {
      toast.error(errorText(error, '添加区域规则失败'))
    } finally {
      setBusy('')
    }
  }

  const saveRangeRule = async (rule: RangeRule) => {
    if (!selectedSheetId || !principalId) return
    setBusy(`rule-${rule.id}`)
    try {
      ensureOk(
        await api.post('/permissions/principal-cell', {
          sheet_id: selectedSheetId,
          principal_type: principalType,
          principal_id: principalId,
          column_key: rule.column_key,
          ...(rule.row_index === undefined || rule.row_index === null ? {} : { row_index: rule.row_index }),
          permission: rule.permission,
        }),
        '保存区域规则失败',
      )
      await loadPermissionConfig()
      void loadEffectiveMatrix()
      toast.success('区域规则已更新')
    } catch (error) {
      toast.error(errorText(error, '保存区域规则失败'))
    } finally {
      setBusy('')
    }
  }

  const describeRule = useCallback(
    (rule: RangeRule) => {
      const columnName = selectedSheet?.columns.find((column) => column.key === rule.column_key)?.name || rule.column_key
      const hasRow = rule.row_index !== undefined && rule.row_index !== null
      if (hasRow && rule.column_key) return `单元格 ${columnName} · 第 ${dataRowToDisplayRow(rule.row_index)} 行`
      if (hasRow) return `第 ${dataRowToDisplayRow(rule.row_index)} 行（整行）`
      return `列「${columnName}」（整列）`
    },
    [selectedSheet],
  )

  const deleteRangeRule = async (rule: RangeRule) => {
    const ok = await confirm({
      title: '删除这条区域规则？',
      message: `${describeRule(rule)} 将不再单独设置，改为继承部门规则或整表权限。`,
      confirmText: '删除规则',
    })
    if (!ok) return
    setBusy(`rule-delete-${rule.id}`)
    try {
      ensureOk(await api.delete(`/permissions/principal-cell/${rule.id}`), '删除区域规则失败')
      await loadPermissionConfig()
      void loadEffectiveMatrix()
      toast.success('区域规则已删除')
    } catch (error) {
      toast.error(errorText(error, '删除区域规则失败'))
    } finally {
      setBusy('')
    }
  }

  const principalLabel = principalOptions.find((item) => item.id === principalId)?.label || ''
  const sheetsByWorkbook = useMemo(() => {
    const groups = new Map<number, { name: string; items: SheetOption[] }>()
    sheets.forEach((sheet) => {
      const group = groups.get(sheet.workbookId) || { name: sheet.workbookName, items: [] }
      group.items.push(sheet)
      groups.set(sheet.workbookId, group)
    })
    return Array.from(groups.values())
  }, [sheets])

  const ruleColumns: Array<DataColumn<RangeRule>> = [
    {
      key: 'scope',
      header: '范围',
      mobile: 'title',
      render: (rule) => {
        const hasRow = rule.row_index !== undefined && rule.row_index !== null
        const Icon = hasRow && rule.column_key ? Square : hasRow ? Rows3 : Columns3
        return (
          <span className="inline-flex items-center gap-2 font-medium text-slate-800">
            <Icon className="h-4 w-4 shrink-0 text-sky-600" />
            {describeRule(rule)}
          </span>
        )
      },
    },
    {
      key: 'permission',
      header: '权限',
      render: (rule) => (
        <SelectInput
          value={rule.permission}
          onChange={(event) => setRangeRules((current) => current.map((item) => (item.id === rule.id ? { ...item, permission: event.target.value as RangePermission } : item)))}
          className="w-32!"
          aria-label="规则权限"
        >
          {permissionOptions.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </SelectInput>
      ),
    },
    {
      key: 'effect',
      header: '效果',
      mobile: 'hidden',
      render: (rule) => <span className="text-xs text-slate-500">{permissionOptions.find((item) => item.value === rule.permission)?.description}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      mobile: 'actions',
      render: (rule) => {
        const dirty = savedRulePermissions[rule.id] !== rule.permission
        return (
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button size="sm" variant="primary" icon={Save} loading={busy === `rule-${rule.id}`} onClick={() => void saveRangeRule(rule)}>
                保存
              </Button>
            )}
            <IconButton icon={Trash2} label="删除规则" variant="danger-outline" className="md:h-8 md:w-8" loading={busy === `rule-delete-${rule.id}`} onClick={() => void deleteRangeRule(rule)} />
          </div>
        )
      },
    },
  ]

  const preview = (() => {
    if (!effectiveMatrix || !previewUserId) return null
    const detail = resolveCellPermissionDetail(effectiveMatrix, previewColumn, displayRowToDataRow(previewDisplayRow))
    const permission = effectiveMatrix.sheet.canView ? detail.permission : 'none'
    const sourceLabels: Record<string, string> = { user: '个人区域规则', department: '部门区域规则', role: '旧版角色规则', default: '整表权限' }
    return {
      permission,
      label: permission === 'write' ? '可编辑' : permission === 'read' ? '只读' : '不可见',
      tone: (permission === 'write' ? 'emerald' : permission === 'read' ? 'sky' : 'rose') as 'emerald' | 'sky' | 'rose',
      source: effectiveMatrix.sheet.canView ? sourceLabels[detail.source] || detail.source : '没有任何查看权限',
      departments: departments.filter((department) => department.member_ids?.includes(previewUserId)).map((department) => department.name),
      sheetFlags: effectiveMatrix.sheet,
    }
  })()

  return (
    <AdminShell
      title="部门与表格权限"
      description="部门成员，以及工作表 / 行 / 列 / 单元格的可见与可编辑范围"
      help={permissionsHelp}
      actions={<IconButton icon={RefreshCw} label="重新加载" spin={loading} onClick={() => void loadInitialData()} />}
    >
      <StatGrid
        items={[
          { label: '部门', value: departments.length, icon: Building2 },
          { label: '受权限控制的员工', value: users.length, icon: Users, tone: 'sky', hint: '不含管理员与停用账号' },
          { label: '工作表', value: sheets.length, icon: FileSpreadsheet, tone: 'emerald' },
          { label: '当前对象的区域规则', value: rangeRules.length, icon: ShieldCheck, tone: 'violet' },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadInitialData()}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      <div className="grid gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
        {/* Departments */}
        <SectionCard
          title="部门与成员"
          description="一个员工可以属于多个部门。"
          icon={Building2}
          flush
          className="xl:self-start"
          actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => openDepartment()}>新建部门</Button>}
        >
          {loading && departments.length === 0 ? (
            <LoadingState compact />
          ) : departments.length === 0 ? (
            <EmptyState compact icon={Building2} title="还没有部门" description="先建一个部门（如“销售部”），再给部门授权，比逐个员工授权更省事。" />
          ) : (
            <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
              {departments.map((department) => (
                <li key={department.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-900">{department.name}</div>
                    <div className="truncate text-xs text-slate-500">
                      {department.member_count} 名成员{department.description ? ` · ${department.description}` : ''}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={principalType === 'department' && principalId === department.id ? 'accent' : 'ghost'}
                    onClick={() => {
                      setPrincipalType('department')
                      setPrincipalId(department.id)
                    }}
                    title="在右侧为该部门配置权限"
                  >
                    授权
                  </Button>
                  <IconButton icon={PencilLine} label="编辑部门与成员" variant="ghost" className="md:h-8 md:w-8" onClick={() => openDepartment(department)} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="min-w-0 space-y-3">
          {/* Step 1 */}
          <SectionCard title="① 选择工作表和授权对象" description="推荐按部门授权；单个员工用于处理例外。" icon={FileSpreadsheet} iconTone="sky">
            {sheets.length === 0 && !loading ? (
              <EmptyState compact icon={FileSpreadsheet} title="没有可配置的工作表" description="先在业务工作台创建工作簿。" />
            ) : (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)] md:items-end">
                <Field label="工作表">
                  <SelectInput value={selectedSheetId ?? ''} onChange={(event) => setSelectedSheetId(Number(event.target.value) || null)}>
                    {sheetsByWorkbook.map((group) => (
                      <optgroup key={group.name + group.items[0]?.workbookId} label={group.name}>
                        {group.items.map((sheet) => (
                          <option key={sheet.id} value={sheet.id}>
                            {group.name} / {sheet.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </SelectInput>
                </Field>
                <Field label="授权对象类型" group>
                  <Segmented
                    value={principalType}
                    onChange={setPrincipalType}
                    options={[
                      { value: 'department', label: '部门' },
                      { value: 'user', label: '单个员工' },
                    ]}
                  />
                </Field>
                <Field label={principalType === 'department' ? '部门' : '员工'}>
                  <SelectInput value={principalId ?? ''} onChange={(event) => setPrincipalId(Number(event.target.value) || null)} disabled={principalOptions.length === 0}>
                    {principalOptions.length === 0 && <option value="">{principalType === 'department' ? '请先新建部门' : '没有可授权的员工'}</option>}
                    {principalOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </div>
            )}
          </SectionCard>

          {/* Step 2 */}
          <SectionCard
            title="② 整张工作表的权限"
            description={principalLabel && selectedSheet ? `${principalType === 'department' ? '部门' : '员工'}「${principalLabel}」在「${selectedSheet.workbookName} / ${selectedSheet.name}」上的权限` : '选择工作表和授权对象后配置'}
            icon={ShieldCheck}
            iconTone="emerald"
            actions={
              <Button variant="primary" icon={Save} loading={busy === 'sheet'} disabled={!principalId || !selectedSheetId || !sheetDirty || configLoading} onClick={() => void saveSheetPermission()}>
                保存整表权限
              </Button>
            }
          >
            {configLoading ? (
              <LoadingState compact label="正在读取权限…" />
            ) : (
              <div className="space-y-3">
                <SwitchField
                  label={principalType === 'user' ? '为该员工单独设置整表权限' : '为该部门设置整表权限'}
                  hint={
                    inheritSheetPermission
                      ? principalType === 'user'
                        ? '当前：继承（按所在部门等来源计算）。适合“只给某个员工加一条区域例外”的场景。'
                        : '当前：未设置。该部门不会因为整表规则获得访问。'
                      : principalType === 'user'
                        ? '已开启：下方勾选结果将完全替代该员工从部门等来源得到的整表权限。'
                        : '已开启：部门成员获得下方勾选的权限（多个部门取并集）。'
                  }
                  checked={!inheritSheetPermission}
                  onChange={(value) => setInheritSheetPermission(!value)}
                  disabled={!principalId}
                />
                <div className={`grid gap-2 sm:grid-cols-2 xl:grid-cols-4 ${inheritSheetPermission ? 'pointer-events-none opacity-40' : ''}`}>
                  {sheetPermissionOptions.map((option) => (
                    <CheckboxRow key={option.key} checked={sheetPermission[option.key]} onChange={(value) => updateSheetFlag(option.key, value)} label={option.label} hint={option.hint} disabled={inheritSheetPermission} />
                  ))}
                </div>
                {sheetDirty && <Notice tone="warning">有未保存的修改。</Notice>}
              </div>
            )}
          </SectionCard>

          {/* Step 3 */}
          <SectionCard
            title="③ 区域例外规则"
            description="隐藏某些列（如成本价）或只开放部分行。优先级：个人规则 > 部门规则 > 整表权限。"
            icon={Columns3}
            iconTone="violet"
            flush
            actions={
              selectedSheet && (
                <Link href={`/sheets/${selectedSheet.workbookId}/${selectedSheet.id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-medium text-sky-700 hover:bg-sky-100 md:h-9">
                  <ExternalLink className="h-4 w-4" />在表格中框选配置
                </Link>
              )
            }
          >
            <div className="grid gap-3 border-b border-slate-200 bg-slate-50 p-3 md:grid-cols-[auto_minmax(0,1fr)_110px_140px_auto] md:items-end">
              <Field label="范围类型" group>
                <Segmented
                  value={scopeType}
                  onChange={setScopeType}
                  options={[
                    { value: 'column', label: '整列' },
                    { value: 'row', label: '整行' },
                    { value: 'cell', label: '单元格' },
                  ]}
                />
              </Field>
              <Field label="列">
                <SelectInput value={draftColumn} disabled={scopeType === 'row' || !selectedSheet?.columns.length} onChange={(event) => setDraftColumn(event.target.value)}>
                  {!selectedSheet?.columns.length && <option value="">该表没有列定义</option>}
                  {selectedSheet?.columns.map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.name}（{column.key}）
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="行号">
                <TextInput type="number" min={2} disabled={scopeType === 'column'} value={draftDisplayRow} onChange={(event) => setDraftDisplayRow(Math.max(2, Number(event.target.value) || 2))} />
              </Field>
              <Field label="权限">
                <SelectInput value={draftPermission} onChange={(event) => setDraftPermission(event.target.value as RangePermission)}>
                  {permissionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Button variant="primary" icon={Plus} loading={busy === 'rule-new'} disabled={!principalId || !selectedSheetId} onClick={() => void addRangeRule()}>
                添加规则
              </Button>
              <p className="text-xs leading-5 text-slate-500 md:col-span-5">
                行号与表格左侧行号一致（第 1 行是表头，数据从第 2 行开始）。同一位置再次添加会覆盖原规则。
              </p>
            </div>
            <DataTable
              rows={rangeRules}
              columns={ruleColumns}
              rowKey={(rule) => rule.id}
              loading={configLoading}
              empty={<EmptyState compact icon={Columns3} title="暂无区域规则" description="当前对象在整张表上都按整表权限执行。" />}
            />
          </SectionCard>

          {/* Step 4 */}
          <SectionCard title="④ 核对：员工实际看到什么" description="综合部门、个人规则和整表权限计算出的最终结果。" icon={ScanSearch} iconTone="amber">
            {users.length === 0 ? (
              <EmptyState compact icon={UserRound} title="没有受权限控制的员工" description="管理员不受权限限制；先在「员工账号」中创建普通员工。" />
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px]">
                  <Field label="员工">
                    <SelectInput value={previewUserId ?? ''} onChange={(event) => setPreviewUserId(Number(event.target.value) || null)}>
                      {users.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.username}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="列">
                    <SelectInput value={previewColumn} onChange={(event) => setPreviewColumn(event.target.value)}>
                      {selectedSheet?.columns.map((column) => (
                        <option key={column.key} value={column.key}>
                          {column.name}（{column.key}）
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="行号">
                    <TextInput type="number" min={2} value={previewDisplayRow} onChange={(event) => setPreviewDisplayRow(Math.max(2, Number(event.target.value) || 2))} />
                  </Field>
                </div>
                {preview ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center">
                    <StatusBadge tone={preview.tone} className="h-7 text-sm">
                      {preview.permission === 'none' ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {preview.label}
                    </StatusBadge>
                    <span className="text-slate-600">决定因素：{preview.source}</span>
                    <span className="text-slate-500">所属部门：{preview.departments.join('、') || '未加入部门'}</span>
                    <span className="text-slate-500">
                      整表：{[preview.sheetFlags.canView && '查看', preview.sheetFlags.canEdit && '编辑', preview.sheetFlags.canDelete && '删除', preview.sheetFlags.canExport && '导出'].filter(Boolean).join(' / ') || '无'}
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">选择工作表和员工后显示结果。</p>
                )}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Department editor */}
      <Modal
        open={Boolean(deptDraft)}
        onClose={() => setDeptDraft(null)}
        busy={deptSaving}
        variant="drawer"
        title={deptDraft?.id ? `编辑部门：${deptDraft.name || ''}` : '新建部门'}
        description="成员变化会立即影响通过该部门获得的表格权限，以及之后发起的审批。"
        icon={Building2}
        footer={
          <>
            {deptDraft?.id && (
              <Button
                variant="danger-outline"
                icon={Trash2}
                className="sm:mr-auto"
                loading={busy === `department-delete-${deptDraft.id}`}
                onClick={() => {
                  const department = departments.find((item) => item.id === deptDraft.id)
                  if (department) void deleteDepartment(department)
                }}
              >
                删除部门
              </Button>
            )}
            <Button onClick={() => setDeptDraft(null)} disabled={deptSaving}>取消</Button>
            <Button variant="primary" icon={Save} loading={deptSaving} onClick={() => void saveDepartment()}>
              保存
            </Button>
          </>
        }
      >
        {deptDraft && (
          <div className="space-y-4">
            {deptError && <Notice tone="danger">{deptError}</Notice>}
            <Field label="部门名称" required>
              <TextInput value={deptDraft.name} onChange={(event) => setDeptDraft((current) => current && { ...current, name: event.target.value })} placeholder="例如：销售部" maxLength={120} />
            </Field>
            <Field label="说明">
              <TextArea rows={2} value={deptDraft.description} onChange={(event) => setDeptDraft((current) => current && { ...current, description: event.target.value })} placeholder="可选" />
            </Field>
            <Field
              label={`成员（已选 ${deptDraft.memberIds.filter((id) => users.some((user) => user.id === id)).length} 人）`}
              group
              hint="只列出启用中的非管理员员工；管理员不受表格权限限制，无需加入部门。"
            >
              <SearchInput value={memberSearch} onChange={setMemberSearch} placeholder="搜索员工" />
              <div className="mt-2 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {filteredMembers.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-slate-400">没有匹配的员工</div>
                ) : (
                  filteredMembers.map((user) => (
                    <label key={user.id} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={deptDraft.memberIds.includes(user.id)}
                        onChange={() =>
                          setDeptDraft((current) =>
                            current && {
                              ...current,
                              memberIds: current.memberIds.includes(user.id) ? current.memberIds.filter((id) => id !== user.id) : [...current.memberIds, user.id],
                            },
                          )
                        }
                        className="h-4 w-4 accent-slate-900"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800">{user.username}</span>
                        <span className="block truncate text-xs text-slate-400">{user.email}</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
            </Field>
          </div>
        )}
      </Modal>
    </AdminShell>
  )
}
