'use client'

import Link from 'next/link'
import { ArrowRight, Bot, Building2, CheckCircle2, ChevronRight, Circle, Database, Hourglass, KeyRound, ListChecks, Mail, RefreshCw, Users, Workflow, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { overviewHelp } from '@/components/admin/adminHelp'
import { groupedAdminModules } from '@/components/admin/adminNav'
import { IconButton, Notice, SectionCard, StatGrid, StatusBadge, type Tone } from '@/components/admin/ui'
import api from '@/lib/api'
import type { AIAssistant, AuthUser, AutomationRule, AutomationRun, Department, PageData, Role, WhatsAppSettings } from '@/types'

interface OverviewData {
  users: AuthUser[] | null
  roles: Role[] | null
  departments: Department[] | null
  rules: AutomationRule[] | null
  runs: AutomationRun[] | null
  assistants: AIAssistant[] | null
  mail: { enabled: boolean; configured: boolean; imap_host: string } | null
  mailAccounts: number | null
  whatsapp: WhatsAppSettings | null
  backup: { enabled: boolean; latest_at?: string; interval_hours: number } | null
}

const emptyData: OverviewData = {
  users: null,
  roles: null,
  departments: null,
  rules: null,
  runs: null,
  assistants: null,
  mail: null,
  mailAccounts: null,
  whatsapp: null,
  backup: null,
}

async function fetchData<T>(path: string): Promise<T | null> {
  try {
    const response = await api.get<T>(path)
    return response.code === 0 && response.data !== undefined ? response.data : null
  } catch {
    return null
  }
}

interface ChecklistStep {
  title: string
  description: string
  done: boolean | null
  status: string
  links: Array<{ label: string; href: string }>
  warning?: string
}

export default function AdminPage() {
  const [data, setData] = useState<OverviewData>(emptyData)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [users, roles, departments, rules, runs, assistants, mail, mailAccounts, whatsapp, backup] = await Promise.all([
      fetchData<PageData<AuthUser>>('/users?page=1&size=1000'),
      fetchData<Role[]>('/roles'),
      fetchData<Department[]>('/departments'),
      fetchData<PageData<AutomationRule>>('/automation/rules?page=1&size=100'),
      fetchData<PageData<AutomationRun>>('/automation/runs?page=1&size=20'),
      fetchData<AIAssistant[]>('/admin/ai/assistants'),
      fetchData<OverviewData['mail']>('/admin/mail/settings'),
      fetchData<unknown[]>('/admin/mail/accounts'),
      fetchData<WhatsAppSettings>('/admin/whatsapp/settings'),
      fetchData<OverviewData['backup']>('/admin/backup/automatic'),
    ])
    setData({
      users: users?.list ?? null,
      roles,
      departments,
      rules: rules?.list ?? null,
      runs: runs?.list ?? null,
      assistants,
      mail,
      mailAccounts: Array.isArray(mailAccounts) ? mailAccounts.length : null,
      whatsapp,
      backup,
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const derived = useMemo(() => {
    const users = data.users || []
    const employees = users.filter((user) => user.username !== 'admin')
    const activeUsers = users.filter((user) => user.status === 1)
    const noRole = activeUsers.filter((user) => (user.roles || []).length === 0)
    const enabledAssistants = (data.assistants || []).filter((item) => item.enabled)
    return {
      employees,
      activeUsers,
      noRole,
      enabledRules: (data.rules || []).filter((rule) => rule.enabled).length,
      waitingRuns: (data.runs || []).filter((run) => run.status === 'waiting_approval').length,
      failedRuns: (data.runs || []).filter((run) => run.status === 'failed').length,
      enabledAssistants,
      defaultAssistant: (data.assistants || []).find((item) => item.is_default),
      mailReady: Boolean(data.mail?.enabled && data.mail?.imap_host),
      whatsappReady: Boolean(data.whatsapp?.enabled),
    }
  }, [data])

  const value = (ready: boolean, content: ReactNode) => (loading && !ready ? '…' : content)

  const steps: ChecklistStep[] = [
    {
      title: '确认岗位角色',
      description: '检查内置的管理员 / 编辑者 / 查看者，按需要新增岗位角色。只有“管理员”角色带有后台和全部数据权限。',
      done: data.roles ? data.roles.some((role) => role.code !== 'admin') : null,
      status: data.roles ? `${data.roles.length} 个角色` : '',
      links: [{ label: '角色管理', href: '/admin/roles' }],
    },
    {
      title: '创建员工账号并分配角色',
      description: '为每位员工开通账号，设置初始密码，并分配角色。',
      done: data.users ? derived.employees.length > 0 : null,
      status: data.users ? `${derived.employees.length} 名员工` : '',
      warning: derived.noRole.length ? `${derived.noRole.length} 个启用中的账号还没有角色` : undefined,
      links: [{ label: '员工账号', href: '/admin/users' }],
    },
    {
      title: '配置部门与工作簿权限',
      description: '把员工分进部门，再为部门设置能看 / 能改哪些工作表、哪些列。否则普通员工只能看到自己创建或被共享的内容。',
      done: data.departments ? data.departments.length > 0 : null,
      status: data.departments ? `${data.departments.length} 个部门` : '',
      links: [{ label: '部门与表格权限', href: '/admin/permissions' }],
    },
    {
      title: '配置邮件 / WhatsApp',
      description: '填写企业邮箱服务器并启用；开启 WhatsApp 服务。之后员工在自己的页面绑定邮箱和 WhatsApp。',
      done: data.mail || data.whatsapp ? derived.mailReady || derived.whatsappReady : null,
      status: [data.mail ? `邮件${derived.mailReady ? '已启用' : '未启用'}` : '', data.whatsapp ? `WhatsApp${derived.whatsappReady ? '已启用' : '未启用'}` : ''].filter(Boolean).join(' · '),
      links: [
        { label: '邮件服务', href: '/admin/mail' },
        { label: 'WhatsApp', href: '/admin/whatsapp' },
      ],
    },
    {
      title: '配置 AI 助手',
      description: '接入一个大模型并设为默认，员工即可在表格、频道中使用 AI。保存后记得测试连接。',
      done: data.assistants ? derived.enabledAssistants.length > 0 : null,
      status: data.assistants ? (derived.defaultAssistant ? `默认：${derived.defaultAssistant.name}` : '未配置') : '',
      links: [{ label: 'AI 助手', href: '/admin/ai' }],
    },
    {
      title: '设置自动备份',
      description: '在服务器 .env 中启用自动备份（BACKUP_AUTO_ENABLED=true），并定期下载一份备份保存到别处。',
      done: data.backup ? data.backup.enabled : null,
      status: data.backup ? (data.backup.enabled ? `每 ${data.backup.interval_hours} 小时` : '未启用') : '',
      links: [{ label: '数据备份', href: '/admin/backup' }],
    },
  ]
  const doneCount = steps.filter((step) => step.done).length

  const moduleStat: Record<string, { text: string; tone: Tone } | undefined> = {
    'admin-users': data.users ? { text: `${derived.activeUsers.length} 启用 / ${data.users.length} 总数`, tone: 'slate' } : undefined,
    'admin-roles': data.roles ? { text: `${data.roles.length} 个角色`, tone: 'slate' } : undefined,
    'admin-permissions': data.departments ? { text: `${data.departments.length} 个部门`, tone: data.departments.length ? 'slate' : 'amber' } : undefined,
    'admin-automation': data.rules ? { text: `${derived.enabledRules} 条启用${derived.waitingRuns ? ` · ${derived.waitingRuns} 待审批` : ''}`, tone: derived.failedRuns ? 'rose' : 'slate' } : undefined,
    'admin-ai': data.assistants ? { text: derived.enabledAssistants.length ? `${derived.enabledAssistants.length} 个可用` : '未配置', tone: derived.enabledAssistants.length ? 'emerald' : 'amber' } : undefined,
    'admin-mail': data.mail ? { text: derived.mailReady ? `已启用 · ${data.mailAccounts ?? 0} 个邮箱` : '未启用', tone: derived.mailReady ? 'emerald' : 'amber' } : undefined,
    'admin-whatsapp': data.whatsapp ? { text: derived.whatsappReady ? '服务已启用' : '未启用', tone: derived.whatsappReady ? 'emerald' : 'amber' } : undefined,
    'admin-backup': data.backup ? { text: data.backup.enabled ? '自动备份已启用' : '自动备份未启用', tone: data.backup.enabled ? 'emerald' : 'amber' } : undefined,
  }

  const groups = groupedAdminModules().filter((group) => group.id !== 'overview')

  return (
    <AdminShell
      title="管理后台"
      description="账号权限、自动化与 AI、通讯集成、数据安全"
      help={overviewHelp}
      actions={<IconButton icon={RefreshCw} label="刷新统计" spin={loading} onClick={() => void load()} />}
    >
      <StatGrid
        items={[
          { label: '启用中的员工', value: value(Boolean(data.users), derived.activeUsers.length), icon: Users, hint: data.users ? `共 ${data.users.length} 个账号` : undefined },
          { label: '部门', value: value(Boolean(data.departments), data.departments?.length ?? '—'), icon: Building2, tone: 'sky' },
          { label: '启用的自动化规则', value: value(Boolean(data.rules), derived.enabledRules), icon: Workflow, tone: 'violet' },
          { label: '等待审批（近 20 次运行）', value: value(Boolean(data.runs), derived.waitingRuns), icon: Hourglass, tone: derived.waitingRuns ? 'amber' : 'slate' },
        ]}
      />

      <Notice tone="warning" title="安全提醒">
        如果仍在使用默认管理员账号 admin / admin123，请立即到
        <Link href="/settings" className="mx-1 font-semibold underline underline-offset-2">个人设置</Link>
        修改密码。
      </Notice>

      <SectionCard
        title="第一次使用？推荐配置顺序"
        description="按顺序完成以下 6 步，系统即可投入使用。完成状态根据当前配置自动判断。"
        icon={ListChecks}
        iconTone="emerald"
        actions={
          <div className="flex items-center gap-2">
            <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
            <span className="text-xs font-medium tabular-nums text-slate-600">
              {doneCount}/{steps.length}
            </span>
          </div>
        }
        flush
      >
        <ol className="divide-y divide-slate-100">
          {steps.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${step.done ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                  {step.done ? <CheckCircle2 className="h-5 w-5" /> : index + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{step.title}</span>
                    {step.done === null ? (
                      loading ? <StatusBadge>检查中…</StatusBadge> : <StatusBadge>无法检测</StatusBadge>
                    ) : step.done ? (
                      <StatusBadge tone="emerald">已完成</StatusBadge>
                    ) : (
                      <StatusBadge tone="amber">待配置</StatusBadge>
                    )}
                    {step.status && <span className="text-xs text-slate-400">{step.status}</span>}
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-slate-500">{step.description}</p>
                  {step.warning && <p className="mt-0.5 text-xs text-amber-700">{step.warning}</p>}
                </div>
              </div>
              <div className="flex shrink-0 gap-2 pl-11 sm:pl-0">
                {step.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition md:h-9 ${step.done ? 'border border-slate-200 text-slate-700 hover:bg-slate-50' : 'bg-slate-900 text-white hover:bg-slate-700'}`}
                  >
                    {link.label}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <div className="grid gap-3 lg:grid-cols-2">
        {groups.map((group) => (
          <SectionCard key={group.id} title={group.label} description={group.description} flush>
            <ul className="divide-y divide-slate-100">
              {group.modules.map((module) => {
                const Icon: LucideIcon = module.icon
                const stat = moduleStat[module.id]
                return (
                  <li key={module.id}>
                    <Link href={module.href} className="group flex min-h-16 items-center gap-3 px-4 py-3 transition hover:bg-slate-50">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">{module.label}</span>
                          {stat && <StatusBadge tone={stat.tone}>{stat.text}</StatusBadge>}
                        </span>
                        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{module.description}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-600" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </SectionCard>
        ))}
      </div>

      <SectionCard title="常见问题" icon={KeyRound} iconTone="sky">
        <dl className="grid gap-4 text-sm md:grid-cols-2">
          {[
            {
              q: '员工登录后看不到某个表格？',
              a: '普通员工只能看到自己创建的、被共享的或被授权的工作表。到「部门与表格权限」给其所在部门授予“查看”，再用页面底部的“核对”确认结果。',
            },
            { q: '员工离职怎么办？', a: '在「员工账号」中把账号“停用”即可立即退出所有设备，数据保留。确认不再需要时再删除，删除会把其名下数据转给你。' },
            { q: '修改需要审批才能生效？', a: '在「流程自动化」新建“单元格变化”规则，添加审批步骤并开启“暂存修改待审批”。审批人在「任务中心」处理。' },
            { q: 'AI 能看到所有数据吗？', a: '不能。AI 读写数据时完全按使用者本人的权限执行，被设为“不可见”的单元格 AI 也拿不到。' },
          ].map((item) => (
            <div key={item.q}>
              <dt className="flex items-center gap-1.5 font-semibold text-slate-800">
                <Circle className="h-2 w-2 fill-sky-500 text-sky-500" />
                {item.q}
              </dt>
              <dd className="mt-1 pl-3.5 text-xs leading-5 text-slate-600">{item.a}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      <div className="flex flex-wrap gap-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Bot className="h-3.5 w-3.5" />
          AI：{data.assistants ? (derived.defaultAssistant ? derived.defaultAssistant.name : '未配置') : '—'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Mail className="h-3.5 w-3.5" />
          邮件：{data.mail ? (derived.mailReady ? '已启用' : '未启用') : '—'}
        </span>
        <span className="inline-flex items-center gap-1">
          <Database className="h-3.5 w-3.5" />
          最近自动备份：{data.backup?.latest_at ? new Date(data.backup.latest_at).toLocaleString('zh-CN', { hour12: false }) : '尚未生成'}
        </span>
      </div>
    </AdminShell>
  )
}
