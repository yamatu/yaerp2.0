import { ADMIN_MODULES, type AppModule } from '@/components/nav/appModules'

/**
 * Logical grouping of the admin modules. The modules themselves (labels, icons,
 * hrefs) live in the shared registry `ADMIN_MODULES`; this file only decides in
 * which group each one is listed.
 */
export interface AdminNavGroup {
  id: string
  label: string
  description: string
  moduleIds: string[]
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  { id: 'overview', label: '总览', description: '后台入口与推荐配置顺序', moduleIds: ['admin'] },
  {
    id: 'access',
    label: '账号与权限',
    description: '谁能登录、属于什么岗位、能看到哪些表格数据',
    moduleIds: ['admin-users', 'admin-roles', 'admin-permissions'],
  },
  {
    id: 'automation',
    label: '自动化与 AI',
    description: '表格驱动的审批 / 通知流程，以及员工使用的 AI 模型',
    moduleIds: ['admin-automation', 'admin-ai'],
  },
  {
    id: 'integrations',
    label: '通讯集成',
    description: '企业邮箱、WhatsApp 与出站代理',
    moduleIds: ['admin-mail', 'admin-whatsapp', 'admin-proxy'],
  },
  {
    id: 'security',
    label: '数据安全',
    description: '备份还原与操作留痕',
    moduleIds: ['admin-backup', 'admin-audit'],
  },
]

export function groupedAdminModules(): Array<AdminNavGroup & { modules: AppModule[] }> {
  return ADMIN_NAV_GROUPS.map((group) => ({
    ...group,
    modules: group.moduleIds
      .map((id) => ADMIN_MODULES.find((module) => module.id === id))
      .filter((module): module is AppModule => Boolean(module)),
  }))
}

/**
 * A module stays highlighted on its sub-pages, except `/admin` itself which must
 * not light up for every child route.
 */
export function isModuleActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  return href !== '/admin' && pathname.startsWith(`${href}/`)
}

export function findActiveAdminModule(pathname: string): AppModule | undefined {
  return ADMIN_MODULES.find((module) => isModuleActive(pathname, module.href))
}
