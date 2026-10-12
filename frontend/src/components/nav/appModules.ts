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
  Network,
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
    description: '后台总览、关键指标与推荐配置顺序',
    href: '/admin',
    icon: Shield,
    keywords: ['admin', 'manage', 'guanli', '后台', '总览', '配置向导'],
    adminOnly: true,
  },
  {
    id: 'admin-users',
    label: '员工账号',
    description: '开通账号、启用 / 停用、分配角色、重置密码',
    href: '/admin/users',
    icon: Users,
    keywords: ['user', 'account', '员工', '账号', '密码', '停用'],
    adminOnly: true,
  },
  {
    id: 'admin-roles',
    label: '角色管理',
    description: '管理员 / 编辑者 / 查看者等岗位角色',
    href: '/admin/roles',
    icon: Shield,
    keywords: ['role', '角色', '岗位'],
    adminOnly: true,
  },
  {
    id: 'admin-permissions',
    label: '部门与表格权限',
    description: '部门成员，以及工作表 / 行 / 列 / 单元格的可见与可编辑范围',
    href: '/admin/permissions',
    icon: Settings2,
    keywords: ['permission', '权限', '矩阵', '部门', '区域', '单元格', '工作表'],
    adminOnly: true,
  },
  {
    id: 'admin-automation',
    label: '流程自动化',
    description: '表格变化 / 定时 / 手动触发的审批、通知与回写',
    href: '/admin/automation',
    icon: Workflow,
    keywords: ['automation', 'workflow', '自动化', '流程', '审批'],
    adminOnly: true,
  },
  {
    id: 'admin-ai',
    label: 'AI 助手',
    description: '模型接口、密钥、默认助手与能力开关',
    href: '/admin/ai',
    icon: Bot,
    keywords: ['ai', 'model', '模型', 'openai', '助手'],
    adminOnly: true,
  },
  {
    id: 'admin-mail',
    label: '邮件服务',
    description: 'IMAP / SMTP 服务器、邮件代理与员工邮箱绑定状态',
    href: '/admin/mail',
    icon: Mail,
    keywords: ['mail', 'smtp', 'imap', '邮件', '邮箱'],
    adminOnly: true,
  },
  {
    id: 'admin-whatsapp',
    label: 'WhatsApp',
    description: '服务开关、代理与员工 WhatsApp 登录状态',
    href: '/admin/whatsapp',
    icon: MessageCircle,
    keywords: ['whatsapp', 'wa', '代理'],
    adminOnly: true,
  },
  {
    id: 'admin-proxy',
    label: 'XTLS 代理',
    description: '订阅、节点测速与 AI / 邮件 / WhatsApp 分流',
    href: '/proxy',
    icon: Network,
    keywords: ['proxy', 'xtls', 'mihomo', 'clash', 'vless', 'vmess', '代理', '节点', '订阅'],
    adminOnly: true,
  },
  {
    id: 'admin-backup',
    label: '数据备份',
    description: '下载备份、自动备份状态与数据库还原',
    href: '/admin/backup',
    icon: Database,
    keywords: ['backup', 'restore', '备份', '还原'],
    adminOnly: true,
  },
  {
    id: 'admin-audit',
    label: '操作审计',
    description: '表格修改、版本恢复与自动化规则变更记录',
    href: '/admin/audit',
    icon: ScrollText,
    keywords: ['audit', 'log', '审计', '日志'],
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
