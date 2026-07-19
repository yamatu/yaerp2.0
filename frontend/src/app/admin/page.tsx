'use client'

import Link from 'next/link'
import {
  Bot,
  ChevronRight,
  Database,
  Images,
  LayoutDashboard,
  MessageSquare,
  MessageCircle,
  ScrollText,
  Settings2,
  Shield,
  Users,
  Workflow,
} from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'

const managementEntries = [
  {
    title: '员工账号',
    description: '创建员工账号，维护状态、资料和角色。',
    href: '/admin/users',
    icon: Users,
  },
  {
    title: '角色管理',
    description: '配置管理员、编辑者和查看者等角色。',
    href: '/admin/roles',
    icon: Shield,
  },
  {
    title: '权限矩阵',
    description: '集中配置工作簿、工作表和字段权限。',
    href: '/admin/permissions',
    icon: Settings2,
  },
  {
    title: '数据备份',
    description: '生成、下载和管理系统数据备份。',
    href: '/admin/backup',
    icon: Database,
  },
  {
    title: '操作审计',
    description: '查询工作表变更、版本恢复和操作者记录。',
    href: '/admin/audit',
    icon: ScrollText,
  },
  {
    title: '流程自动化',
    description: '配置触发条件、多级审批、通知与自动回写。',
    href: '/admin/automation',
    icon: Workflow,
  },
  {
    title: 'AI 助手',
    description: '维护 AI 接口、模型参数和自动任务。',
    href: '/admin/ai',
    icon: Bot,
  },
  {
    title: 'WhatsApp',
    description: '二维码登录、代理配置和频道同步管理。',
    href: '/admin/whatsapp',
    icon: MessageCircle,
  },
]

const businessEntries = [
  { title: '业务工作台', href: '/', icon: LayoutDashboard },
  { title: '频道协作', href: '/channels', icon: MessageSquare },
  { title: '图库', href: '/gallery', icon: Images },
]

export default function AdminPage() {
  return (
    <AdminShell title="管理后台" description="账号、角色、权限、备份和系统能力集中管理">
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="mb-3 text-sm font-semibold text-slate-900">业务入口</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {businessEntries.map((entry) => {
            const Icon = entry.icon
            return (
              <Link key={entry.href} href={entry.href} className="flex h-11 items-center gap-3 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-950">
                <Icon className="h-4 w-4 text-slate-400" />
                {entry.title}
              </Link>
            )
          })}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-slate-950">系统管理</h2>
          <p className="mt-1 text-sm text-slate-500">选择一个管理模块继续操作。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {managementEntries.map((entry) => {
            const Icon = entry.icon
            return (
              <Link key={entry.href} href={entry.href} className="group flex min-h-32 items-start gap-4 rounded-lg border border-slate-200 p-4 transition hover:border-sky-300 hover:bg-sky-50/40">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white"><Icon className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{entry.title}</h3>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-sky-600" />
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-500">{entry.description}</p>
                </div>
              </Link>
            )
          })}
        </div>
      </section>
    </AdminShell>
  )
}
