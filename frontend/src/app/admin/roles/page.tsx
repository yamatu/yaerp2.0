'use client'

import { Lock, PencilLine, Plus, RefreshCw, Shield, ShieldCheck, Tags, Trash2, Users } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { rolesHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Notice,
  SectionCard,
  StatGrid,
  StatusBadge,
  TextInput,
  Toolbar,
  type DataColumn,
} from '@/components/admin/ui'
import api from '@/lib/api'
import type { AuthUser, PageData, Role } from '@/types'

const BUILTIN_CODES = new Set(['admin', 'editor', 'viewer'])
const ROLE_EFFECT: Record<string, string> = {
  admin: '进入后台，查看并修改全部数据',
  editor: '岗位标签，不自带表格权限',
  viewer: '岗位标签，不自带表格权限',
}
const CODE_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/

interface RoleRow extends Role {
  members: AuthUser[]
}

export default function RolesManagementPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [roles, setRoles] = useState<Role[]>([])
  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Role | null>(null)
  const [form, setForm] = useState({ name: '', code: '', description: '' })
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [rolesRes, usersRes] = await Promise.all([api.get<Role[]>('/roles'), api.get<PageData<AuthUser>>('/users?page=1&size=1000')])
      ensureOk(rolesRes, '加载角色列表失败')
      setRoles(Array.isArray(rolesRes.data) ? rolesRes.data : [])
      setUsers(usersRes.code === 0 && usersRes.data?.list ? usersRes.data.list : [])
    } catch (error) {
      setLoadError(errorText(error, '加载角色列表失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const rows = useMemo<RoleRow[]>(() => {
    const keyword = search.trim().toLowerCase()
    return roles
      .map((role) => ({ ...role, members: users.filter((user) => (user.roles || []).some((item) => item.id === role.id)) }))
      .filter((role) => !keyword || `${role.name} ${role.code} ${role.description || ''}`.toLowerCase().includes(keyword))
  }, [roles, search, users])

  const assignedUsers = users.filter((user) => (user.roles || []).length > 0).length

  const openCreate = () => {
    setEditing(null)
    setForm({ name: '', code: '', description: '' })
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (role: Role) => {
    setEditing(role)
    setForm({ name: role.name, code: role.code, description: role.description || '' })
    setFormError('')
    setFormOpen(true)
  }

  const submit = async () => {
    const name = form.name.trim()
    const codeValue = form.code.trim()
    if (!name) {
      setFormError('请填写角色名称')
      return
    }
    if (!editing && !CODE_PATTERN.test(codeValue)) {
      setFormError('角色代码需以小写字母开头，只能包含小写字母、数字、下划线或短横线，长度 2–32')
      return
    }
    setSaving(true)
    setFormError('')
    try {
      if (editing) {
        ensureOk(await api.put(`/roles/${editing.id}`, { name, description: form.description.trim() }), '更新角色失败')
        toast.success(`角色「${name}」已更新`)
      } else {
        ensureOk(await api.post('/roles', { name, code: codeValue, description: form.description.trim() }), '创建角色失败')
        toast.success(`角色「${name}」已创建，可到「员工账号」中分配给员工`)
      }
      setFormOpen(false)
      await loadData()
    } catch (error) {
      setFormError(errorText(error, editing ? '更新角色失败' : '创建角色失败'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (role: RoleRow) => {
    const memberNames = role.members.map((user) => user.username)
    const ok = await confirm({
      title: `删除角色「${role.name}」？`,
      message:
        memberNames.length > 0
          ? `该角色当前分配给 ${memberNames.length} 名员工：${memberNames.slice(0, 8).join('、')}${memberNames.length > 8 ? ' 等' : ''}。`
          : '该角色目前没有分配给任何员工。',
      consequences: ['所有员工身上的该角色立即被移除，员工账号本身不受影响', '按该角色配置过的旧表格权限、文件夹可见性规则一并删除', '此操作不可撤销'],
      confirmText: '删除角色',
      requireText: memberNames.length > 0 ? role.code : undefined,
    })
    if (!ok) return
    setDeletingId(role.id)
    try {
      ensureOk(await api.delete(`/roles/${role.id}`), '删除角色失败')
      toast.success(`角色「${role.name}」已删除`)
      await loadData()
    } catch (error) {
      toast.error(errorText(error, '删除角色失败'))
    } finally {
      setDeletingId(null)
    }
  }

  const columns: Array<DataColumn<RoleRow>> = [
    {
      key: 'name',
      header: '角色',
      mobile: 'title',
      render: (role) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${role.code === 'admin' ? 'bg-violet-50 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>
            {role.code === 'admin' ? <ShieldCheck className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-slate-900">{role.name}</span>
              {BUILTIN_CODES.has(role.code) && <StatusBadge>内置</StatusBadge>}
            </div>
            <div className="font-mono text-xs text-slate-400">{role.code}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'effect',
      header: '实际作用',
      render: (role) => (
        <span className={role.code === 'admin' ? 'font-medium text-violet-700' : 'text-slate-600'}>{ROLE_EFFECT[role.code] || '岗位标签，不自带表格权限'}</span>
      ),
    },
    {
      key: 'description',
      header: '说明',
      render: (role) => <span className="text-slate-500">{role.description || '—'}</span>,
    },
    {
      key: 'members',
      header: '使用人数',
      mobile: 'badge',
      render: (role) => (
        <span title={role.members.map((user) => user.username).join('、')}>
          <StatusBadge tone={role.members.length ? 'sky' : 'slate'}>
            <Users className="h-3 w-3" />
            {role.members.length} 人
          </StatusBadge>
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      mobile: 'actions',
      render: (role) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" icon={PencilLine} onClick={() => openEdit(role)}>
            编辑
          </Button>
          <IconButton
            icon={role.code === 'admin' ? Lock : Trash2}
            label={role.code === 'admin' ? '管理员角色是系统内置角色，不能删除' : '删除角色'}
            variant="danger-outline"
            className="md:h-8 md:w-8"
            disabled={role.code === 'admin' || deletingId !== null}
            loading={deletingId === role.id}
            onClick={() => void handleDelete(role)}
          />
        </div>
      ),
    },
  ]

  return (
    <AdminShell
      title="角色管理"
      description="管理员 / 编辑者 / 查看者等岗位角色"
      help={rolesHelp}
      actions={
        <Button variant="primary" icon={Plus} onClick={openCreate}>
          <span className="hidden sm:inline">新建角色</span>
          <span className="sm:hidden">新建</span>
        </Button>
      }
    >
      <StatGrid
        items={[
          { label: '角色总数', value: roles.length, icon: Tags },
          { label: '自定义角色', value: roles.filter((role) => !BUILTIN_CODES.has(role.code)).length, icon: Shield, tone: 'sky' },
          { label: '管理员人数', value: users.filter((user) => (user.roles || []).some((role) => role.code === 'admin')).length, icon: ShieldCheck, tone: 'violet' },
          { label: '未分配角色的员工', value: users.length - assignedUsers, icon: Users, tone: users.length - assignedUsers ? 'amber' : 'slate' },
        ]}
      />

      <Notice tone="info">
        角色只决定“是否为管理员”。要控制普通员工能看 / 改哪些表格，请到
        <Link href="/admin/permissions" className="mx-1 font-semibold underline underline-offset-2">部门与表格权限</Link>
        配置。
      </Notice>

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadData()}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      <SectionCard title="角色列表" description="内置角色可以改名和描述；角色代码创建后不能修改。" icon={Shield} flush>
        <Toolbar search={search} onSearch={setSearch} placeholder="搜索角色名称、代码或说明" actions={<IconButton icon={RefreshCw} label="刷新" spin={loading} onClick={() => void loadData()} />} />
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(role) => role.id}
          loading={loading}
          loadingLabel="正在加载角色…"
          empty={<EmptyState icon={Shield} title={roles.length ? '没有匹配的角色' : '还没有角色'} description={roles.length ? '换个关键词试试。' : '点击右上角“新建角色”。'} />}
        />
      </SectionCard>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        busy={saving}
        title={editing ? `编辑角色：${editing.name}` : '新建角色'}
        description={editing ? '角色代码不能修改；名称和描述修改后立即生效。' : '创建后到「员工账号」中把角色分配给员工。'}
        icon={editing ? PencilLine : Plus}
        footer={
          <>
            <Button onClick={() => setFormOpen(false)} disabled={saving}>取消</Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              {editing ? '保存' : '创建角色'}
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {formError && <Notice tone="danger">{formError}</Notice>}
          <Field label="角色名称" required hint="显示名称，不能与其他角色重复。">
            <TextInput value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：销售专员" maxLength={64} />
          </Field>
          <Field label="角色代码" required={!editing} hint={editing ? '代码是系统内部标识，创建后不可修改。' : '小写英文开头，可含数字、_、-，例如 sales、finance_mgr。创建后不可修改。'}>
            <TextInput
              value={form.code}
              disabled={Boolean(editing)}
              onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toLowerCase() }))}
              placeholder="例如：sales"
              className="font-mono"
              maxLength={32}
            />
          </Field>
          <Field label="说明" hint="可选，写明这个角色给哪些岗位使用。">
            <TextInput value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="例如：负责客户询价与报价" />
          </Field>
          {editing?.code === 'admin' && <Notice tone="warning">这是管理员角色：拥有它的账号可以进入后台并修改全部数据。</Notice>}
          <button type="submit" className="hidden" />
        </form>
      </Modal>
    </AdminShell>
  )
}
