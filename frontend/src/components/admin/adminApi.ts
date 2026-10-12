import type { ApiResponse } from '@/types'

/**
 * Backend admin handlers answer with `{ code, message, data }`. Non-zero codes
 * are NOT thrown by the api client, so admin pages must check every response;
 * `ensureOk` turns a failed response into an Error with a readable message.
 */

const MESSAGE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/default admin user cannot be disabled/i, '默认管理员账号（admin）受保护，不能停用'],
  [/default admin user cannot be deleted/i, '默认管理员账号（admin）受保护，不能删除'],
  [/default admin user must keep admin role/i, '默认管理员账号必须保留「管理员」角色'],
  [/cannot delete the currently signed-in account/i, '不能删除当前登录的账号'],
  [/cannot disable the currently signed-in account/i, '不能停用当前登录的账号'],
  [/cannot remove your own admin role/i, '不能移除自己的管理员角色，否则会立即失去后台权限'],
  [/admin role cannot be deleted/i, '「管理员」角色是系统内置角色，不能删除'],
  [/username already exists/i, '用户名已存在，请换一个'],
  [/users_email_key|email.*(exists|duplicate)/i, '该邮箱已被其他账号使用'],
  [/roles_code_key/i, '角色代码已存在，请换一个'],
  [/roles_name_key/i, '角色名称已存在，请换一个'],
  [/role not found/i, '角色不存在或已被删除'],
  [/Email.*'email' tag|failed on the 'email'/i, '邮箱格式不正确'],
  [/Username.*'min' tag/i, '用户名至少 3 个字符'],
  [/Password.*'min' tag|NewPassword.*'min' tag/i, '密码至少 6 位'],
  [/invalid request body/i, '提交的数据格式不正确'],
  [/admin role required/i, '需要管理员权限'],
  [/department name is required/i, '部门名称不能为空'],
  [/user (\d+) does not exist or is disabled/i, '部门成员中包含已停用或已删除的员工，请移除后再保存'],
  [/restore file is required/i, '请先选择备份文件'],
  [/backup exceeds configured size limit/i, '完整备份超过了服务器设置的大小上限（BACKUP_MAX_BYTES），请改用数据库备份或调高上限'],
  [/unsupported action/i, '不支持的操作'],
]

export function translateApiMessage(message: string | undefined | null, fallback: string): string {
  const text = (message || '').trim()
  if (!text || text === 'success') return fallback
  for (const [pattern, translated] of MESSAGE_TRANSLATIONS) {
    if (pattern.test(text)) return translated
  }
  return text
}

export function ensureOk<T>(response: ApiResponse<T>, fallback: string): ApiResponse<T> {
  if (!response || response.code !== 0) {
    throw new Error(translateApiMessage(response?.message, fallback))
  }
  return response
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    // fetch() network failures surface as TypeError("Failed to fetch").
    if (/failed to fetch|networkerror|load failed/i.test(error.message)) return '无法连接服务器，请检查网络后重试'
    if (/Unexpected token|JSON/i.test(error.message)) return `${fallback}（服务器返回了无法解析的响应）`
    return translateApiMessage(error.message, fallback)
  }
  return fallback
}

export function formatDateTime(value?: string | null, empty = '—') {
  if (!value) return empty
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatFileSize(size = 0) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
