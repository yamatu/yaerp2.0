'use client'

import { KeyRound, PencilLine, RefreshCw, ShieldCheck, Trash2, UserCheck, UserRound, UserRoundPlus, UserX, Users, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { usersHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText, formatDateTime } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Notice,
  SectionCard,
  Segmented,
  SelectInput,
  StatGrid,
  StatusBadge,
  SwitchField,
  TextInput,
  Toolbar,
  type DataColumn,
} from '@/components/admin/ui'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type { AuthUser, PageData, Role } from '@/types'

interface CreateUserForm {
  username: string
  email: string
  password: string
  roleIds: number[]
}

const emptyCreateForm: CreateUserForm = { username: '', email: '', password: '', roleIds: [] }

type StatusFilter = 'all' | 'active' | 'disabled'

const ROLE_HINTS: Record<string, string> = {
  admin: '进入后台，查看并修改全部数据',
  editor: '岗位标签，不自带表格权限',
  viewer: '岗位标签，不自带表格权限',
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const values = new Uint32Array(10)
  window.crypto.getRandomValues(values)
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
}

const isDefaultAdmin = (user: AuthUser) => user.username === 'admin'

export default function UsersManagementPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [roleFilter, setRoleFilter] = useState('')

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateUserForm>(emptyCreateForm)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const [editingUser, setEditingUser] = useState<AuthUser | null>(null)
  const [editEmail, setEditEmail] = useState('')
  const [editActive, setEditActive] = useState(true)
  const [editRoles, setEditRoles] = useState<number[]>([])
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [editError, setEditError] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    setCurrentUserId(getStoredUser()?.id ?? null)
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [usersRes, rolesRes] = await Promise.all([
        api.get<PageData<AuthUser>>('/users?page=1&size=1000'),
        api.get<Role[]>('/roles'),
      ])
      ensureOk(usersRes, '加载员工账号失败')
      ensureOk(rolesRes, '加载角色列表失败')
      setUsers(Array.isArray(usersRes.data?.list) ? usersRes.data!.list.map((user) => ({ ...user, roles: user.roles || [] })) : [])
      setRoles(Array.isArray(rolesRes.data) ? rolesRes.data : [])
    } catch (error) {
      setLoadError(errorText(error, '加载员工账号失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const adminRoleId = roles.find((role) => role.code === 'admin')?.id ?? null

  const stats = useMemo(() => {
    const active = users.filter((user) => user.status === 1).length
    return {
      total: users.length,
      active,
      disabled: users.length - active,
      admins: users.filter((user) => user.roles.some((role) => role.code === 'admin')).length,
      noRole: users.filter((user) => user.roles.length === 0).length,
    }
  }, [users])

  const filteredUsers = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return users.filter((user) => {
      if (statusFilter === 'active' && user.status !== 1) return false
      if (statusFilter === 'disabled' && user.status === 1) return false
      if (roleFilter === '__none' && user.roles.length > 0) return false
      if (roleFilter && roleFilter !== '__none' && !user.roles.some((role) => String(role.id) === roleFilter)) return false
      if (!keyword) return true
      return `${user.username} ${user.email || ''}`.toLowerCase().includes(keyword)
    })
  }, [roleFilter, search, statusFilter, users])

  /* ---------------- create ---------------- */

  const openCreate = () => {
    const defaultRole = roles.find((role) => role.code === 'viewer')
    setCreateForm({ ...emptyCreateForm, roleIds: defaultRole ? [defaultRole.id] : [] })
    setCreateError('')
    setCreateOpen(true)
  }

  const validateCreate = () => {
    if (createForm.username.trim().length < 3) return '用户名至少 3 个字符'
    if (!/^\S+@\S+\.\S+$/.test(createForm.email.trim())) return '请填写有效的邮箱地址'
    if (createForm.password.length < 6) return '初始密码至少 6 位'
    return ''
  }

  const handleCreate = async () => {
    const validation = validateCreate()
    if (validation) {
      setCreateError(validation)
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      const response = await api.post<AuthUser>('/users', {
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        password: createForm.password,
        role_ids: createForm.roleIds,
      })
      ensureOk(response, '创建员工账号失败')
      setCreateOpen(false)
      toast.success(`员工「${createForm.username.trim()}」已创建，请把初始密码告知本人。`)
      await loadData()
    } catch (error) {
      setCreateError(errorText(error, '创建员工账号失败'))
    } finally {
      setCreating(false)
    }
  }

  /* ---------------- edit ---------------- */

  const openEdit = (user: AuthUser) => {
    setEditingUser(user)
    setEditEmail(user.email || '')
    setEditActive(user.status === 1)
    setEditRoles(user.roles.map((role) => role.id))
    setNewPassword('')
    setEditError('')
  }

  const isSelf = (user: AuthUser | null) => Boolean(user && currentUserId !== null && user.id === currentUserId)

  const roleLocked = (roleId: number) =>
    Boolean(editingUser && roleId === adminRoleId && (isDefaultAdmin(editingUser) || isSelf(editingUser)) && editingUser.roles.some((role) => role.id === roleId))

  const handleSave = async () => {
    if (!editingUser) return
    const email = editEmail.trim()
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setEditError('请填写有效的邮箱地址')
      return
    }
    const wasActive = editingUser.status === 1
    if (wasActive && !editActive) {
      const ok = await confirm({
        title: `停用员工「${editingUser.username}」？`,
        message: '停用后：',
        consequences: ['该账号立即在所有设备上退出登录，且无法再登录', '数据完整保留，之后可以随时重新启用', '不能再被加入部门、选为审批人或自动化规则负责人'],
        confirmText: '停用并保存',
      })
      if (!ok) return
    }
    setSaving(true)
    setEditError('')
    try {
      const statusChanged = wasActive !== editActive
      if (email !== (editingUser.email || '') || statusChanged) {
        ensureOk(await api.put(`/users/${editingUser.id}`, { email, status: editActive ? 1 : 0 }), '保存员工信息失败')
      }
      const before = [...editingUser.roles.map((role) => role.id)].sort().join(',')
      const after = [...editRoles].sort().join(',')
      if (before !== after) {
        ensureOk(await api.post(`/users/${editingUser.id}/roles`, { roles: editRoles }), '保存角色失败')
      }
      toast.success(`员工「${editingUser.username}」已保存`)
      setEditingUser(null)
      await loadData()
    } catch (error) {
      setEditError(errorText(error, '保存员工信息失败'))
      // Part of the save may have succeeded (e.g. email saved, roles rejected).
      void loadData()
    } finally {
      setSaving(false)
    }
  }

  const handleResetPassword = async () => {
    if (!editingUser) return
    if (newPassword.trim().length < 6) {
      setEditError('新密码至少 6 位')
      return
    }
    const ok = await confirm({
      title: `重置「${editingUser.username}」的密码？`,
      consequences: ['该员工所有已登录的设备会被强制退出', '请通过安全渠道把新密码告知员工，并提醒其登录后自行修改'],
      confirmText: '重置密码',
      tone: 'primary',
    })
    if (!ok) return
    setResetting(true)
    setEditError('')
    try {
      ensureOk(await api.post(`/users/${editingUser.id}/password`, { new_password: newPassword.trim() }), '重置密码失败')
      setNewPassword('')
      toast.success(isSelf(editingUser) ? '密码已重置，你需要用新密码重新登录。' : `已重置「${editingUser.username}」的密码`)
    } catch (error) {
      setEditError(errorText(error, '重置密码失败'))
    } finally {
      setResetting(false)
    }
  }

  /* ---------------- delete ---------------- */

  const handleDelete = async (user: AuthUser) => {
    const ok = await confirm({
      title: `永久删除员工「${user.username}」？`,
      message: '此操作不可撤销。如只是员工离职或暂停使用，建议改为“停用”。',
      consequences: [
        '账号立即失效，所有设备退出登录',
        '名下工作簿、文件夹、频道、图库目录、AI 总结页、自动化规则，以及外贸客户、供应商、订单和报价全部转交给你',
        '该员工的部门成员关系、个人权限规则随之删除',
      ],
      confirmText: '永久删除',
      requireText: user.username,
    })
    if (!ok) return
    setDeletingId(user.id)
    try {
      ensureOk(await api.delete(`/users/${user.id}`), '删除员工账号失败')
      toast.success(`员工「${user.username}」已删除，名下数据已转交给你`)
      await loadData()
    } catch (error) {
      toast.error(errorText(error, '删除员工账号失败'))
    } finally {
      setDeletingId(null)
    }
  }

  /* ---------------- render ---------------- */

  const columns: Array<DataColumn<AuthUser>> = [
    {
      key: 'user',
      header: '员工',
      mobile: 'title',
      render: (user) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${user.status === 1 ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-500'}`}>
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-semibold text-slate-900">{user.username}</span>
              {isSelf(user) && <StatusBadge tone="sky">当前账号</StatusBadge>}
              {isDefaultAdmin(user) && <StatusBadge tone="violet">默认管理员</StatusBadge>}
            </div>
            <div className="truncate text-xs text-slate-400 md:hidden">{user.email || '未设置邮箱'}</div>
            <div className="hidden text-xs text-slate-400 md:block">ID {user.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: '邮箱',
      mobile: 'hidden',
      render: (user) => <span className="text-slate-600">{user.email || <span className="text-slate-400">未设置</span>}</span>,
    },
    {
      key: 'roles',
      header: '角色',
      render: (user) =>
        user.roles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {user.roles.map((role) => (
              <StatusBadge key={role.id} tone={role.code === 'admin' ? 'violet' : 'slate'}>
                {role.name}
              </StatusBadge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-400">未分配</span>
        ),
    },
    {
      key: 'status',
      header: '状态',
      mobile: 'badge',
      render: (user) => (
        <StatusBadge tone={user.status === 1 ? 'emerald' : 'rose'} dot>
          {user.status === 1 ? '启用' : '已停用'}
        </StatusBadge>
      ),
    },
    {
      key: 'created',
      header: '创建时间',
      render: (user) => <span className="text-xs text-slate-500">{formatDateTime(user.created_at)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      mobile: 'actions',
      render: (user) => {
        const protectedUser = isDefaultAdmin(user) || isSelf(user)
        return (
          <div className="flex justify-end gap-2">
            <Button size="sm" icon={PencilLine} onClick={() => openEdit(user)}>
              编辑
            </Button>
            <IconButton
              icon={Trash2}
              label={protectedUser ? (isSelf(user) ? '不能删除当前登录的账号' : '默认管理员不能删除') : '删除员工'}
              variant="danger-outline"
              className="md:h-8 md:w-8"
              loading={deletingId === user.id}
              disabled={protectedUser || deletingId !== null}
              onClick={() => void handleDelete(user)}
            />
          </div>
        )
      },
    },
  ]

  const createRoleIds = createForm.roleIds

  return (
    <AdminShell
      title="员工账号"
      description="开通账号、启用 / 停用、分配角色、重置密码"
      help={usersHelp}
      actions={
        <Button variant="primary" icon={UserRoundPlus} onClick={openCreate} disabled={loading && roles.length === 0}>
          <span className="hidden sm:inline">新建员工</span>
          <span className="sm:hidden">新建</span>
        </Button>
      }
    >
      <StatGrid
        items={[
          { label: '员工总数', value: stats.total, icon: Users },
          { label: '启用中', value: stats.active, icon: UserCheck, tone: 'emerald' },
          { label: '已停用', value: stats.disabled, icon: UserX, tone: stats.disabled ? 'rose' : 'slate' },
          { label: '管理员', value: stats.admins, icon: ShieldCheck, tone: 'violet', hint: stats.noRole ? `${stats.noRole} 人未分配角色` : undefined },
        ]}
      />

      {loadError && (
        <Notice tone="danger" action={<Button size="sm" icon={RefreshCw} onClick={() => void loadData()}>重试</Button>}>
          {loadError}
        </Notice>
      )}

      <SectionCard title="员工列表" description={`共 ${users.length} 个账号，当前显示 ${filteredUsers.length} 个`} icon={UserRound} flush>
        <Toolbar search={search} onSearch={setSearch} placeholder="搜索用户名或邮箱" actions={<IconButton icon={RefreshCw} label="刷新" spin={loading} onClick={() => void loadData()} />}>
          <Segmented
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: '全部', count: stats.total },
              { value: 'active', label: '启用', count: stats.active },
              { value: 'disabled', label: '停用', count: stats.disabled },
            ]}
          />
          <SelectInput value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="按角色筛选" className="w-full! sm:w-40!">
            <option value="">全部角色</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
            <option value="__none">未分配角色</option>
          </SelectInput>
        </Toolbar>
        <DataTable
          rows={filteredUsers}
          columns={columns}
          rowKey={(user) => user.id}
          loading={loading}
          loadingLabel="正在加载员工账号…"
          empty={
            users.length === 0 ? (
              <EmptyState icon={Users} title="还没有员工账号" description="点击右上角“新建员工”开通第一个账号。" action={<Button variant="primary" icon={UserRoundPlus} onClick={openCreate}>新建员工</Button>} />
            ) : (
              <EmptyState icon={Users} title="没有符合条件的员工" description="试试清空搜索词或切换筛选条件。" />
            )
          }
        />
      </SectionCard>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        busy={creating}
        title="新建员工账号"
        description="创建后员工即可用用户名和初始密码登录。"
        icon={UserRoundPlus}
        size="lg"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>取消</Button>
            <Button variant="primary" icon={UserRoundPlus} loading={creating} onClick={() => void handleCreate()}>
              创建账号
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCreate()
          }}
        >
          {createError && <Notice tone="danger">{createError}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="用户名" required hint="用于登录，至少 3 个字符，创建后不能修改。">
              <TextInput value={createForm.username} onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))} placeholder="例如 zhangsan" autoComplete="off" maxLength={64} />
            </Field>
            <Field label="邮箱" required hint="必须唯一，用于显示和通知。">
              <TextInput type="email" value={createForm.email} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} placeholder="name@company.com" autoComplete="off" />
            </Field>
          </div>
          <Field
            label="初始密码"
            required
            hint="至少 6 位。员工首次登录后应在「个人设置」中修改。"
            aside={
              <button type="button" onClick={(event) => { event.preventDefault(); setCreateForm((current) => ({ ...current, password: generatePassword() })) }} className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50">
                <Wand2 className="h-3.5 w-3.5" />随机生成
              </button>
            }
          >
            <TextInput value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} placeholder="不少于 6 位" autoComplete="new-password" className="font-mono" />
          </Field>
          <Field label="角色" group hint="可多选，也可以不分配。员工能看到哪些表格由「部门与表格权限」决定。">
            <div className="flex flex-wrap gap-2">
              {roles.map((role) => (
                <Chip
                  key={role.id}
                  active={createRoleIds.includes(role.id)}
                  onClick={() =>
                    setCreateForm((current) => ({
                      ...current,
                      roleIds: current.roleIds.includes(role.id) ? current.roleIds.filter((id) => id !== role.id) : [...current.roleIds, role.id],
                    }))
                  }
                >
                  {role.name}
                </Chip>
              ))}
            </div>
            {createRoleIds.includes(adminRoleId ?? -1) && <Notice tone="warning" className="mt-2">管理员角色可以进入后台并修改全部数据，请确认确有必要。</Notice>}
          </Field>
          <button type="submit" className="hidden" />
        </form>
      </Modal>

      {/* Edit */}
      <Modal
        open={Boolean(editingUser)}
        onClose={() => setEditingUser(null)}
        busy={saving || resetting}
        variant="drawer"
        title={editingUser ? `编辑员工：${editingUser.username}` : ''}
        description={editingUser ? `ID ${editingUser.id} · 创建于 ${formatDateTime(editingUser.created_at)}` : ''}
        icon={PencilLine}
        footer={
          <>
            <Button onClick={() => setEditingUser(null)} disabled={saving || resetting}>取消</Button>
            <Button variant="primary" loading={saving} disabled={resetting} onClick={() => void handleSave()}>
              保存
            </Button>
          </>
        }
      >
        {editingUser && (
          <div className="space-y-5">
            {editError && <Notice tone="danger">{editError}</Notice>}
            {(isDefaultAdmin(editingUser) || isSelf(editingUser)) && (
              <Notice tone="info">
                {isSelf(editingUser) ? '这是你当前登录的账号：' : '默认管理员账号受保护：'}不能停用、删除，也不能移除管理员角色。
              </Notice>
            )}
            <Field label="邮箱" required>
              <TextInput type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} />
            </Field>
            <SwitchField
              label="允许登录"
              hint={editActive ? '账号正常使用中。关闭后会立即退出所有设备。' : '账号已停用，无法登录；数据保留。'}
              checked={editActive}
              disabled={isDefaultAdmin(editingUser) || isSelf(editingUser)}
              onChange={setEditActive}
            />
            <Field label="角色" group hint="管理员 = 进入后台 + 全部数据；其他角色是岗位标签。">
              <div className="space-y-2">
                {roles.map((role) => {
                  const active = editRoles.includes(role.id)
                  const locked = roleLocked(role.id)
                  return (
                    <label key={role.id} className={`flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 transition ${active ? 'border-sky-300 bg-sky-50' : 'border-slate-200 hover:bg-slate-50'} ${locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        disabled={locked}
                        onChange={() => setEditRoles((current) => (current.includes(role.id) ? current.filter((id) => id !== role.id) : [...current, role.id]))}
                        className="h-4 w-4 accent-slate-900"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-800">
                          {role.name} <span className="font-mono text-xs font-normal text-slate-400">{role.code}</span>
                        </span>
                        <span className="block truncate text-xs text-slate-500">{ROLE_HINTS[role.code] || role.description || '自定义角色'}</span>
                      </span>
                      {locked && <StatusBadge>不可移除</StatusBadge>}
                    </label>
                  )
                })}
              </div>
            </Field>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <KeyRound className="h-4 w-4 text-slate-500" />
                重置密码
              </div>
              <p className="mb-3 text-xs leading-5 text-slate-500">独立于上方“保存”，点击“重置”后立即生效，员工所有设备会被强制退出。</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <TextInput value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="输入不少于 6 位的新密码" autoComplete="new-password" className="font-mono" />
                <IconButton icon={Wand2} label="随机生成" onClick={() => setNewPassword(generatePassword())} className="hidden sm:inline-flex" />
                <Button icon={KeyRound} loading={resetting} disabled={saving || newPassword.trim().length === 0} onClick={() => void handleResetPassword()}>
                  重置
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </AdminShell>
  )
}
