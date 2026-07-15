'use client'

import {
  Building2,
  Check,
  Columns3,
  Eye,
  EyeOff,
  PencilLine,
  Plus,
  Rows3,
  Save,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { Department, PageData, User, Workbook } from '@/types'

type PrincipalType = 'department' | 'user'
type RangePermission = 'none' | 'read' | 'write'
type ScopeType = 'column' | 'row' | 'cell'

interface SheetOption {
  id: number
  name: string
  workbookName: string
  columns: string[]
}

interface SheetPermission {
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

const emptySheetPermission: SheetPermission = {
  can_view: false,
  can_edit: false,
  can_delete: false,
  can_export: false,
}

const sheetPermissionOptions: Array<{ key: keyof SheetPermission; label: string; icon: typeof Eye }> = [
  { key: 'can_view', label: '允许查看', icon: Eye },
  { key: 'can_edit', label: '允许编辑', icon: PencilLine },
  { key: 'can_delete', label: '允许删除', icon: Trash2 },
  { key: 'can_export', label: '允许导出', icon: Save },
]

const permissionOptions: Array<{ value: RangePermission; label: string; description: string }> = [
  { value: 'none', label: '不可见', description: '接口返回时遮盖原始内容' },
  { value: 'read', label: '只读', description: '可以查看但不能修改' },
  { value: 'write', label: '可编辑', description: '可以查看并修改' },
]

const displayRowToDataRow = (value: number) => Math.max(0, value - 2)
const dataRowToDisplayRow = (value?: number) => (value ?? 0) + 2

export default function PermissionsPage() {
  const [departments, setDepartments] = useState<Department[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [sheets, setSheets] = useState<SheetOption[]>([])
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number | null>(null)
  const [departmentName, setDepartmentName] = useState('')
  const [departmentDescription, setDepartmentDescription] = useState('')
  const [departmentMemberIds, setDepartmentMemberIds] = useState<number[]>([])
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedSheetId, setSelectedSheetId] = useState<number | null>(null)
  const [principalType, setPrincipalType] = useState<PrincipalType>('department')
  const [principalId, setPrincipalId] = useState<number | null>(null)
  const [sheetPermission, setSheetPermission] = useState<SheetPermission>(emptySheetPermission)
  const [rangeRules, setRangeRules] = useState<RangeRule[]>([])
  const [scopeType, setScopeType] = useState<ScopeType>('column')
  const [draftColumn, setDraftColumn] = useState('')
  const [draftDisplayRow, setDraftDisplayRow] = useState(2)
  const [draftPermission, setDraftPermission] = useState<RangePermission>('read')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2200)
  }

  const loadDepartments = useCallback(async () => {
    const response = await api.get<Department[]>('/departments')
    const items = response.code === 0 && Array.isArray(response.data) ? response.data : []
    setDepartments(items)
    setSelectedDepartmentId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null)
    return items
  }, [])

  const loadInitialData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [departmentItems, userResponse, workbookResponse] = await Promise.all([
        loadDepartments(),
        api.get<PageData<User>>('/users?page=1&size=500'),
        api.get<Workbook[]>('/workbooks'),
      ])
      const employeeItems = userResponse.code === 0 && userResponse.data
        ? userResponse.data.list.filter((user) => user.status === 1 && !user.roles?.some((role) => role.code === 'admin'))
        : []
      setUsers(employeeItems)

      const workbookItems = workbookResponse.code === 0 && workbookResponse.data ? workbookResponse.data : []
      const details = await Promise.all(workbookItems.map((workbook) => api.get<Workbook>(`/workbooks/${workbook.id}`)))
      const sheetItems = details.flatMap((response, index) =>
        response.code === 0 && response.data?.sheets
          ? response.data.sheets.map((sheet) => ({
              id: sheet.id,
              name: sheet.name,
              workbookName: workbookItems[index].name,
              columns: Array.isArray(sheet.columns) ? sheet.columns.map((column) => column.key) : [],
            }))
          : []
      )
      setSheets(sheetItems)
      setSelectedSheetId((current) => current && sheetItems.some((item) => item.id === current) ? current : sheetItems[0]?.id ?? null)
      if (departmentItems.length > 0) {
        setPrincipalType('department')
        setPrincipalId((current) => current && departmentItems.some((item) => item.id === current) ? current : departmentItems[0].id)
      } else if (employeeItems.length > 0) {
        setPrincipalType('user')
        setPrincipalId(employeeItems[0].id)
      }
    } catch (loadError) {
      console.error(loadError)
      setError('权限数据加载失败，请刷新后重试。')
    } finally {
      setLoading(false)
    }
  }, [loadDepartments])

  useEffect(() => { void loadInitialData() }, [loadInitialData])

  const selectedDepartment = departments.find((item) => item.id === selectedDepartmentId) || null
  useEffect(() => {
    setDepartmentName(selectedDepartment?.name || '')
    setDepartmentDescription(selectedDepartment?.description || '')
    setDepartmentMemberIds(selectedDepartment?.member_ids || [])
  }, [selectedDepartment])

  const principalOptions = principalType === 'department'
    ? departments.map((department) => ({ id: department.id, label: department.name }))
    : users.map((user) => ({ id: user.id, label: user.username }))

  useEffect(() => {
    if (principalOptions.length === 0) {
      setPrincipalId(null)
      return
    }
    if (!principalId || !principalOptions.some((item) => item.id === principalId)) {
      setPrincipalId(principalOptions[0].id)
    }
  }, [principalId, principalOptions])

  const selectedSheet = sheets.find((item) => item.id === selectedSheetId) || null
  useEffect(() => {
    if (selectedSheet?.columns.length && !selectedSheet.columns.includes(draftColumn)) {
      setDraftColumn(selectedSheet.columns[0])
    }
  }, [draftColumn, selectedSheet])

  const loadPermissionConfig = useCallback(async () => {
    if (!selectedSheetId || !principalId) {
      setSheetPermission(emptySheetPermission)
      setRangeRules([])
      return
    }
    const response = await api.get<PermissionConfig>(`/permissions/sheets/${selectedSheetId}/principals/${principalType}/${principalId}`)
    if (response.code !== 0 || !response.data) {
      setSheetPermission(emptySheetPermission)
      setRangeRules([])
      return
    }
    setSheetPermission({
      can_view: response.data.sheet.can_view || false,
      can_edit: response.data.sheet.can_edit || false,
      can_delete: response.data.sheet.can_delete || false,
      can_export: response.data.sheet.can_export || false,
    })
    setRangeRules([...(response.data.columns || []), ...(response.data.rows || []), ...(response.data.cells || [])])
  }, [principalId, principalType, selectedSheetId])

  useEffect(() => { void loadPermissionConfig() }, [loadPermissionConfig])

  const filteredUsers = useMemo(() => {
    const keyword = memberSearch.trim().toLocaleLowerCase('zh-CN')
    return keyword
      ? users.filter((user) => `${user.username} ${user.email}`.toLocaleLowerCase('zh-CN').includes(keyword))
      : users
  }, [memberSearch, users])

  const createDepartment = async () => {
    const name = window.prompt('请输入新部门名称')?.trim()
    if (!name) return
    setSaving('department-create')
    setError('')
    try {
      const response = await api.post<Department>('/departments', { name, description: '', member_ids: [] })
      if (response.code !== 0 || !response.data) throw new Error(response.message || '创建部门失败')
      await loadDepartments()
      setSelectedDepartmentId(response.data.id)
      showNotice(`部门“${name}”已创建`)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '创建部门失败')
    } finally {
      setSaving('')
    }
  }

  const saveDepartment = async () => {
    if (!selectedDepartmentId || !departmentName.trim()) return
    setSaving('department')
    setError('')
    try {
      const updateResponse = await api.put(`/departments/${selectedDepartmentId}`, {
        name: departmentName.trim(), description: departmentDescription.trim(),
      })
      if (updateResponse.code !== 0) throw new Error(updateResponse.message || '保存部门失败')
      const memberResponse = await api.put(`/departments/${selectedDepartmentId}/members`, { user_ids: departmentMemberIds })
      if (memberResponse.code !== 0) throw new Error(memberResponse.message || '保存部门成员失败')
      await loadDepartments()
      showNotice('部门信息和成员已保存')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存部门失败')
    } finally {
      setSaving('')
    }
  }

  const deleteDepartment = async () => {
    if (!selectedDepartment || !window.confirm(`确认删除部门“${selectedDepartment.name}”？部门权限也会停止生效。`)) return
    setSaving('department-delete')
    try {
      const response = await api.delete(`/departments/${selectedDepartment.id}`)
      if (response.code !== 0) throw new Error(response.message || '删除部门失败')
      await loadDepartments()
      showNotice('部门已删除')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '删除部门失败')
    } finally {
      setSaving('')
    }
  }

  const saveSheetPermission = async () => {
    if (!selectedSheetId || !principalId) return
    setSaving('sheet')
    setError('')
    try {
      const response = await api.post('/permissions/principal-sheet', {
        sheet_id: selectedSheetId,
        principal_type: principalType,
        principal_id: principalId,
        ...sheetPermission,
      })
      if (response.code !== 0) throw new Error(response.message || '保存整表权限失败')
      await loadPermissionConfig()
      showNotice('整表权限已保存')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存整表权限失败')
    } finally {
      setSaving('')
    }
  }

  const saveRangeRule = async (rule?: RangeRule) => {
    if (!selectedSheetId || !principalId) return
    const columnKey = rule?.column_key ?? (scopeType === 'row' ? '' : draftColumn)
    const rowIndex = rule?.row_index ?? (scopeType === 'column' ? undefined : displayRowToDataRow(draftDisplayRow))
    if ((scopeType === 'column' || scopeType === 'cell') && !columnKey) return
    setSaving(rule ? `rule-${rule.id}` : 'rule-new')
    setError('')
    try {
      const response = await api.post('/permissions/principal-cell', {
        sheet_id: selectedSheetId,
        principal_type: principalType,
        principal_id: principalId,
        column_key: columnKey,
        ...(rowIndex === undefined ? {} : { row_index: rowIndex }),
        permission: rule?.permission ?? draftPermission,
      })
      if (response.code !== 0) throw new Error(response.message || '保存范围权限失败')
      await loadPermissionConfig()
      showNotice(rule ? '范围权限已更新' : '范围权限已添加')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存范围权限失败')
    } finally {
      setSaving('')
    }
  }

  const deleteRangeRule = async (rule: RangeRule) => {
    if (!window.confirm('确认删除这条范围权限？删除后会继承更上一级权限。')) return
    setSaving(`rule-delete-${rule.id}`)
    try {
      const response = await api.delete(`/permissions/principal-cell/${rule.id}`)
      if (response.code !== 0) throw new Error(response.message || '删除范围权限失败')
      await loadPermissionConfig()
      showNotice('范围权限已删除')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '删除范围权限失败')
    } finally {
      setSaving('')
    }
  }

  const describeRule = (rule: RangeRule) => {
    if (rule.row_index !== undefined && rule.column_key) return `单元格 ${rule.column_key}${dataRowToDisplayRow(rule.row_index)}`
    if (rule.row_index !== undefined) return `第 ${dataRowToDisplayRow(rule.row_index)} 行`
    return `列 ${rule.column_key}`
  }

  return (
    <AdminShell
      title="部门与区域权限"
      description="员工可加入多个部门，并按工作表、行、列和单元格分配查看或编辑范围。"
      summary={(
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryItem icon={Building2} label="自定义部门" value={departments.length} />
          <SummaryItem icon={Users} label="可配置员工" value={users.length} />
          <SummaryItem icon={ShieldCheck} label="工作表" value={sheets.length} />
        </div>
      )}
    >
      {(notice || error) && (
        <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {error ? <EyeOff className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          {error || notice}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">部门与成员</h2>
              <p className="mt-1 text-xs text-slate-500">同一员工可以同时属于多个部门。</p>
            </div>
            <button type="button" onClick={createDepartment} disabled={saving === 'department-create'} title="新建部门" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex max-h-48 gap-2 overflow-x-auto pb-1 xl:max-h-none xl:flex-col xl:overflow-y-auto">
            {departments.map((department) => (
              <button key={department.id} type="button" onClick={() => setSelectedDepartmentId(department.id)} className={`min-w-44 rounded-lg border px-3 py-2.5 text-left transition xl:min-w-0 ${selectedDepartmentId === department.id ? 'border-sky-300 bg-sky-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                <div className="truncate text-sm font-semibold text-slate-900">{department.name}</div>
                <div className="mt-1 text-xs text-slate-500">{department.member_count} 名成员</div>
              </button>
            ))}
            {!loading && departments.length === 0 && <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">先创建一个部门</div>}
          </div>

          {selectedDepartment && (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <label className="block text-xs font-medium text-slate-600">部门名称
                <input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
              </label>
              <label className="block text-xs font-medium text-slate-600">说明
                <textarea value={departmentDescription} onChange={(event) => setDepartmentDescription(event.target.value)} rows={2} className="mt-1.5 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
              </label>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-600"><span>部门成员</span><span>{departmentMemberIds.length} 人</span></div>
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="搜索员工" className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-sky-300" />
                </label>
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 p-1">
                  {filteredUsers.map((user) => (
                    <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-slate-50">
                      <input type="checkbox" checked={departmentMemberIds.includes(user.id)} onChange={() => setDepartmentMemberIds((current) => current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id])} className="h-4 w-4 rounded border-slate-300 text-sky-600" />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-800">{user.username}</span><span className="block truncate text-xs text-slate-400">{user.email}</span></span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={saveDepartment} disabled={saving === 'department'} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"><Save className="h-4 w-4" />保存部门与成员</button>
                <button type="button" onClick={deleteDepartment} disabled={saving === 'department-delete'} title="删除部门" className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </section>

        <div className="space-y-3">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs font-medium text-slate-600">工作表
                <select value={selectedSheetId ?? ''} onChange={(event) => setSelectedSheetId(Number(event.target.value) || null)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300">
                  {sheets.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.workbookName} / {sheet.name}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">授权对象
                <select value={principalType} onChange={(event) => setPrincipalType(event.target.value as PrincipalType)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300">
                  <option value="department">部门</option>
                  <option value="user">单个员工</option>
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">{principalType === 'department' ? '部门' : '员工'}
                <select value={principalId ?? ''} onChange={(event) => setPrincipalId(Number(event.target.value) || null)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300">
                  {principalOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><h2 className="text-base font-semibold text-slate-950">整张工作表权限</h2><p className="mt-1 text-xs text-slate-500">范围规则会覆盖这里的默认查看和编辑权限。</p></div>
              <button type="button" onClick={saveSheetPermission} disabled={!principalId || !selectedSheetId || saving === 'sheet'} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"><Save className="h-4 w-4" />保存整表权限</button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {sheetPermissionOptions.map(({ key, label, icon: Icon }) => (
                <label key={key} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition ${sheetPermission[key] ? 'border-sky-300 bg-sky-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <input type="checkbox" checked={sheetPermission[key]} onChange={(event) => setSheetPermission((current) => ({ ...current, [key]: event.target.checked }))} className="h-4 w-4 rounded border-slate-300 text-sky-600" />
                  <Icon className="h-4 w-4 text-slate-500" /><span className="text-sm font-medium text-slate-700">{label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
            <div><h2 className="text-base font-semibold text-slate-950">精确区域权限</h2><p className="mt-1 text-xs text-slate-500">优先级：单元格高于行，行高于列，未配置区域继承整表权限。个人同级规则优先于部门。</p></div>
            <div className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-[160px_1fr_1fr_180px_auto]">
              <label className="text-xs font-medium text-slate-600">范围类型
                <select value={scopeType} onChange={(event) => setScopeType(event.target.value as ScopeType)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
                  <option value="column">整列</option><option value="row">整行</option><option value="cell">单元格</option>
                </select>
              </label>
              <label className={`text-xs font-medium text-slate-600 ${scopeType === 'row' ? 'opacity-40' : ''}`}>列
                <select value={draftColumn} disabled={scopeType === 'row'} onChange={(event) => setDraftColumn(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm disabled:bg-slate-100">
                  {selectedSheet?.columns.map((column) => <option key={column} value={column}>{column}</option>)}
                </select>
              </label>
              <label className={`text-xs font-medium text-slate-600 ${scopeType === 'column' ? 'opacity-40' : ''}`}>工作表行号
                <input type="number" min={2} disabled={scopeType === 'column'} value={draftDisplayRow} onChange={(event) => setDraftDisplayRow(Math.max(2, Number(event.target.value) || 2))} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm disabled:bg-slate-100" />
              </label>
              <label className="text-xs font-medium text-slate-600">权限
                <select value={draftPermission} onChange={(event) => setDraftPermission(event.target.value as RangePermission)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm">
                  {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void saveRangeRule()} disabled={!principalId || !selectedSheetId || saving === 'rule-new'} className="self-end inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"><Plus className="h-4 w-4" />添加规则</button>
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3 text-left font-medium">范围</th><th className="px-4 py-3 text-left font-medium">权限</th><th className="px-4 py-3 text-left font-medium">效果</th><th className="px-4 py-3 text-right font-medium">操作</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rangeRules.map((rule) => {
                    const option = permissionOptions.find((item) => item.value === rule.permission) || permissionOptions[0]
                    return (
                      <tr key={rule.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3"><span className="inline-flex items-center gap-2 font-medium text-slate-800">{rule.row_index !== undefined && rule.column_key ? <Square className="h-4 w-4 text-sky-600" /> : rule.row_index !== undefined ? <Rows3 className="h-4 w-4 text-sky-600" /> : <Columns3 className="h-4 w-4 text-sky-600" />}{describeRule(rule)}</span></td>
                        <td className="px-4 py-3"><select value={rule.permission} onChange={(event) => setRangeRules((current) => current.map((item) => item.id === rule.id ? { ...item, permission: event.target.value as RangePermission } : item))} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm">{permissionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></td>
                        <td className="px-4 py-3 text-xs text-slate-500">{option.description}</td>
                        <td className="px-4 py-3"><div className="flex justify-end gap-2"><button type="button" onClick={() => void saveRangeRule(rule)} disabled={saving === `rule-${rule.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-white"><Save className="h-3.5 w-3.5" />保存</button><button type="button" onClick={() => void deleteRangeRule(rule)} disabled={saving === `rule-delete-${rule.id}`} title="删除规则" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button></div></td>
                      </tr>
                    )
                  })}
                  {!loading && rangeRules.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400">暂无范围规则，当前全部继承整表权限。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </AdminShell>
  )
}

function SummaryItem({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: number }) {
  return <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><Icon className="h-5 w-5" /></div><div><div className="text-xs text-slate-500">{label}</div><div className="text-xl font-semibold text-slate-950">{value}</div></div></div>
}
