import {
  BarChart3,
  Bot,
  BriefcaseBusiness,
  CheckSquare,
  Database,
  FolderKanban,
  Images,
  Mail,
  MessageCircle,
  MessageSquare,
  ScrollText,
  Settings2,
  Shield,
  Trash2,
  UserRound,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

/**
 * Central registry of the top-level modules that can be reached from anywhere
 * in the product. Keeping it in one place lets the global command palette stay
 * in sync with the app instead of hard-coding links page by page.
 */
export interface AppModule {
  id: string
  label: string
  description: string
  href: string
  icon: LucideIcon
  /** Extra search tokens (English words, aliases, ...). */
  keywords: string[]
  adminOnly?: boolean
}

export const BUSINESS_MODULES: AppModule[] = [
  {
    id: 'workbench',
    label: '业务工作台',
    description: '工作簿、文件夹与协作任务',
    href: '/',
    icon: FolderKanban,
    keywords: ['home', 'workbench', 'gongzuotai', '文件', '文件夹'],
  },
  {
    id: 'trade',
    label: '外贸业务中心',
    description: '询价、报价、采购、仓库、质检、发货',
    href: '/trade',
    icon: BriefcaseBusiness,
    keywords: ['trade', 'erp', 'order', '订单', '客户', '供应商', '询价'],
  },
  {
    id: 'mail',
    label: '邮件',
    description: '收发工作邮件、撰写与预览',
    href: '/mail',
    icon: Mail,
    keywords: ['mail', 'email', 'youxiang', '邮箱', '收件箱'],
  },
  {
    id: 'channels',
    label: '频道',
    description: '团队频道与消息协作',
    href: '/channels',
    icon: MessageSquare,
    keywords: ['channel', 'message', 'chat', '消息', '聊天', '群'],
  },
  {
    id: 'tasks',
    label: '任务中心',
    description: '待办任务与发放记录',
    href: '/tasks',
    icon: CheckSquare,
    keywords: ['task', 'todo', 'daiban', '待办', '任务'],
  },
  {
    id: 'gallery',
    label: '图库',
    description: '图片素材上传与引用',
    href: '/gallery',
    icon: Images,
    keywords: ['gallery', 'image', 'tupian', '图片', '素材'],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    description: '客户会话与消息推送',
    href: '/whatsapp',
    icon: MessageCircle,
    keywords: ['whatsapp', 'wa', '客服', '会话'],
  },
  {
    id: 'ai-summaries',
    label: 'AI 总结',
    description: '智能摘要与业务洞察',
    href: '/ai/summaries',
    icon: BarChart3,
    keywords: ['ai', 'summary', 'zongjie', '总结', '报表', '洞察'],
  },
  {
    id: 'recycle-bin',
    label: '回收站',
    description: '还原 30 天内删除的内容',
    href: '/recycle-bin',
    icon: Trash2,
    keywords: ['recycle', 'trash', 'delete', '回收', '删除', '还原'],
  },
  {
    id: 'settings',
    label: '个人设置',
    description: '账号资料、我的权限、密码与偏好',
    href: '/settings',
    icon: UserRound,
    keywords: ['settings', 'profile', 'shezhi', '设置', '密码', '偏好', '权限', 'quanxian', 'permission', '我的权限'],
  },
]

export const ADMIN_MODULES: AppModule[] = [
  {
    id: 'admin',
    label: '管理后台',
    description: '系统管理总览',
    href: '/admin',
    icon: Shield,
    keywords: ['admin', 'manage', 'guanli', '后台'],
    adminOnly: true,
  },
  {
    id: 'admin-users',
    label: '员工账号',
    description: '创建员工、维护状态与角色',
    href: '/admin/users',
    icon: Users,
    keywords: ['user', 'account', '员工', '账号'],
    adminOnly: true,
  },
  {
    id: 'admin-roles',
    label: '角色管理',
    description: '配置管理员、编辑者、查看者',
    href: '/admin/roles',
    icon: Shield,
    keywords: ['role', '角色', '权限'],
    adminOnly: true,
  },
  {
    id: 'admin-permissions',
    label: '部门与区域权限',
    description: '部门、工作表、行列与单元格权限',
    href: '/admin/permissions',
    icon: Settings2,
    keywords: ['permission', '权限', '矩阵', '部门', '区域', '单元格'],
    adminOnly: true,
  },
  {
    id: 'admin-backup',
    label: '数据备份',
    description: '生成、下载与管理备份',
    href: '/admin/backup',
    icon: Database,
    keywords: ['backup', '备份'],
    adminOnly: true,
  },
  {
    id: 'admin-audit',
    label: '操作审计',
    description: '变更、版本恢复与操作者记录',
    href: '/admin/audit',
    icon: ScrollText,
    keywords: ['audit', 'log', '审计', '日志'],
    adminOnly: true,
  },
  {
    id: 'admin-automation',
    label: '流程自动化',
    description: '触发条件、审批与自动回写',
    href: '/admin/automation',
    icon: Workflow,
    keywords: ['automation', 'workflow', '自动化', '流程'],
    adminOnly: true,
  },
  {
    id: 'admin-ai',
    label: 'AI 助手管理',
    description: '接口、模型参数与自动任务',
    href: '/admin/ai',
    icon: Bot,
    keywords: ['ai', 'model', '模型'],
    adminOnly: true,
  },
  {
    id: 'admin-mail',
    label: '邮件服务',
    description: 'SMTP、收件与发件账号配置',
    href: '/admin/mail',
    icon: Mail,
    keywords: ['mail', 'smtp', '邮件', '邮箱'],
    adminOnly: true,
  },
  {
    id: 'admin-whatsapp',
    label: 'WhatsApp 管理',
    description: '登录、代理与频道同步',
    href: '/admin/whatsapp',
    icon: MessageCircle,
    keywords: ['whatsapp', 'wa', '代理'],
    adminOnly: true,
  },
]

export function allModules(admin: boolean): AppModule[] {
  return admin
    ? [...BUSINESS_MODULES, ...ADMIN_MODULES]
    : BUSINESS_MODULES
}

export function findModuleById(id: string): AppModule | undefined {
  return [...BUSINESS_MODULES, ...ADMIN_MODULES].find((item) => item.id === id)
}
