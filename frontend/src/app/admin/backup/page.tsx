'use client'

import { AlertTriangle, Archive, Clock3, Database, Download, FileJson, FolderOpen, HardDrive, RefreshCw, RotateCcw, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminShell } from '@/components/admin/AdminShell'
import { backupHelp } from '@/components/admin/adminHelp'
import { errorText, formatDateTime, formatFileSize, translateApiMessage } from '@/components/admin/adminApi'
import { useConfirm, useToast } from '@/components/admin/feedback'
import { Button, CheckboxRow, DetailList, IconButton, LoadingState, Notice, SectionCard, StatGrid, StatusBadge } from '@/components/admin/ui'
import api from '@/lib/api'

interface AutomaticBackupStatus {
  enabled: boolean
  directory: string
  host_directory: string
  interval_hours: number
  retention_days: number
  latest_file?: string
  latest_at?: string
  latest_size?: number
}

interface DownloadOption {
  key: string
  icon: typeof Database
  tone: 'sky' | 'emerald' | 'amber'
  title: string
  badge: string
  description: string
  contains: string[]
  endpoint: string
  filename: string
  restorable: boolean
}

const downloadOptions: DownloadOption[] = [
  {
    key: 'database',
    icon: Database,
    tone: 'sky',
    title: '数据库备份',
    badge: '.sql',
    description: '完整的 PostgreSQL 导出，边生成边下载，数据量大也不会失败。日常备份首选。',
    contains: ['全部业务数据、账号、权限、配置表'],
    endpoint: '/admin/backup/database',
    filename: 'database-backup.sql',
    restorable: true,
  },
  {
    key: 'combined',
    icon: Archive,
    tone: 'emerald',
    title: '完整备份',
    badge: '.tar.gz',
    description: '数据库 + 运行配置 + 对象存储中的附件和图片，用于整机迁移。在服务器内存中打包，体积超过上限会失败。',
    contains: ['数据库', '附件 / 图片文件', '运行配置与清单'],
    endpoint: '/admin/backup/combined',
    filename: 'full-backup.tar.gz',
    restorable: true,
  },
  {
    key: 'config',
    icon: FileJson,
    tone: 'amber',
    title: '配置导出',
    badge: '.json',
    description: '只包含数据库、Redis、MinIO 地址等运行参数，不含密码和业务数据。用于核对部署环境，不能用于还原。',
    contains: ['运行参数（无密码）'],
    endpoint: '/admin/backup/config',
    filename: 'config-export.json',
    restorable: false,
  },
]

const toneTiles = { sky: 'bg-sky-50 text-sky-700', emerald: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-700' }

function filenameFromDisposition(disposition: string, fallback: string) {
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback
}

async function readError(res: Response, fallback: string) {
  try {
    const payload = (await res.json()) as { message?: string }
    return translateApiMessage(payload.message, `${fallback}（HTTP ${res.status}）`)
  } catch {
    return `${fallback}（HTTP ${res.status}）`
  }
}

export default function BackupPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [status, setStatus] = useState<AutomaticBackupStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [runningBackup, setRunningBackup] = useState(false)
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  const [restoreDone, setRestoreDone] = useState(false)
  const restoreInputRef = useRef<HTMLInputElement>(null)

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    setStatusError('')
    try {
      const response = await api.get<AutomaticBackupStatus>('/admin/backup/automatic')
      if (response.code !== 0 || !response.data) throw new Error(translateApiMessage(response.message, '读取自动备份状态失败'))
      setStatus(response.data)
    } catch (error) {
      setStatusError(errorText(error, '读取自动备份状态失败'))
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const runBackup = async () => {
    setRunningBackup(true)
    try {
      const response = await api.post<AutomaticBackupStatus>('/admin/backup/automatic/run')
      if (response.code !== 0 || !response.data) throw new Error(translateApiMessage(response.message, '备份执行失败'))
      setStatus(response.data)
      toast.success(`已生成 ${response.data.latest_file || '数据库备份'}（${formatFileSize(response.data.latest_size)}）`)
    } catch (error) {
      toast.error(errorText(error, '备份执行失败'))
    } finally {
      setRunningBackup(false)
    }
  }

  const handleDownload = async (option: DownloadOption) => {
    setLoadingKey(option.key)
    try {
      const res = await api.download(option.endpoint)
      if (!res.ok) throw new Error(await readError(res, `${option.title}下载失败`))
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filenameFromDisposition(res.headers.get('Content-Disposition') || '', option.filename)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
      toast.success(`${option.title}已开始下载（${formatFileSize(blob.size)}）`)
    } catch (error) {
      toast.error(errorText(error, `${option.title}下载失败`))
    } finally {
      setLoadingKey(null)
    }
  }

  const handleRestore = async () => {
    if (!restoreFile) {
      setRestoreError('请先选择备份文件')
      return
    }
    if (!/\.(sql|sql\.gz|gz|tar\.gz|tgz)$/i.test(restoreFile.name)) {
      setRestoreError('只支持 .sql、.sql.gz 或本系统生成的 .tar.gz 完整备份')
      return
    }
    const ok = await confirm({
      title: '确认还原数据库？',
      message: (
        <>
          将使用 <strong className="break-all text-slate-900">{restoreFile.name}</strong>（{formatFileSize(restoreFile.size)}）覆盖当前数据库。
        </>
      ),
      consequences: [
        '当前数据库的全部数据会先被删除，再导入备份内容',
        '备份时间点之后产生的所有数据将永久丢失，无法撤销',
        '所有账号和密码回到备份时的状态，你可能需要重新登录',
        '附件、图片等对象存储文件不会被还原或删除',
      ],
      confirmText: '开始还原',
      requireText: '确认还原',
    })
    if (!ok) return
    setRestoring(true)
    setRestoreError('')
    setRestoreDone(false)
    try {
      const formData = new FormData()
      formData.append('file', restoreFile)
      const res = await api.download('/admin/backup/restore', { method: 'POST', body: formData })
      const payload = (await res.json().catch(() => ({}))) as { code?: number; message?: string }
      if (!res.ok || payload.code !== 0) throw new Error(translateApiMessage(payload.message, `还原失败（HTTP ${res.status}）`))
      setRestoreDone(true)
      setRestoreFile(null)
      setRestoreAcknowledged(false)
      if (restoreInputRef.current) restoreInputRef.current.value = ''
      toast.success('数据库还原完成')
    } catch (error) {
      setRestoreError(errorText(error, '数据库还原失败'))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <AdminShell title="数据备份" description="下载备份、自动备份状态与数据库还原" help={backupHelp}>
      <StatGrid
        items={[
          { label: '服务器自动备份', value: status ? (status.enabled ? '已启用' : '未启用') : '—', icon: Clock3, tone: status?.enabled ? 'emerald' : 'amber' },
          { label: '最近一次自动备份', value: status?.latest_at ? formatDateTime(status.latest_at) : '尚未生成', icon: HardDrive, tone: status?.latest_at ? 'sky' : 'slate' },
          { label: '备份周期', value: status ? `每 ${status.interval_hours} 小时` : '—', icon: RefreshCw },
          { label: '保留天数', value: status ? `${status.retention_days} 天` : '—', icon: FolderOpen },
        ]}
      />

      <SectionCard
        title="服务器自动备份"
        description="由服务器环境变量控制（BACKUP_AUTO_ENABLED 等），页面上只能查看和立即执行。"
        icon={HardDrive}
        iconTone="emerald"
        actions={
          <>
            <IconButton icon={RefreshCw} label="刷新状态" spin={loadingStatus} disabled={runningBackup} onClick={() => void loadStatus()} />
            <Button variant="success" icon={Clock3} loading={runningBackup} onClick={() => void runBackup()}>
              立即备份
            </Button>
          </>
        }
      >
        {loadingStatus && !status ? (
          <LoadingState compact label="正在读取备份状态…" />
        ) : statusError ? (
          <Notice tone="danger">{statusError}</Notice>
        ) : status ? (
          <div className="space-y-3">
            {!status.enabled && (
              <Notice tone="warning" title="自动备份未启用">
                在服务器 .env 中设置 <code className="font-mono">BACKUP_AUTO_ENABLED=true</code> 并重启后端后生效。未启用时仍可点击“立即备份”手动生成。
              </Notice>
            )}
            <DetailList
              items={[
                { label: '状态', value: <StatusBadge tone={status.enabled ? 'emerald' : 'slate'} dot>{status.enabled ? `已启用 · 每 ${status.interval_hours} 小时` : '未启用'}</StatusBadge> },
                { label: '宿主机目录', value: <code className="break-all font-mono text-xs">{status.host_directory}</code> },
                { label: '容器内目录', value: <code className="break-all font-mono text-xs">{status.directory}</code> },
                { label: '保留策略', value: `超过 ${status.retention_days} 天的自动备份会被删除` },
                {
                  label: '最近备份',
                  value: status.latest_at ? (
                    <span className="break-all">
                      {formatDateTime(status.latest_at)} · {status.latest_file} · {formatFileSize(status.latest_size)}
                    </span>
                  ) : (
                    '尚未生成'
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="下载备份到本机" description="建议定期下载数据库备份，并保存在服务器以外的位置。" icon={Download} iconTone="sky">
        <div className="grid gap-3 md:grid-cols-3">
          {downloadOptions.map((option) => {
            const Icon = option.icon
            return (
              <div key={option.key} className="flex flex-col rounded-lg border border-slate-200 p-4">
                <div className="flex items-start gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneTiles[option.tone]}`}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-semibold text-slate-900">{option.title}</h3>
                      <StatusBadge>{option.badge}</StatusBadge>
                    </div>
                    <div className="mt-1">
                      <StatusBadge tone={option.restorable ? 'emerald' : 'amber'}>{option.restorable ? '可用于还原' : '不能用于还原'}</StatusBadge>
                    </div>
                  </div>
                </div>
                <p className="mt-3 flex-1 text-xs leading-5 text-slate-500">{option.description}</p>
                <p className="mt-2 text-xs text-slate-400">包含：{option.contains.join('、')}</p>
                <Button className="mt-3" block variant={option.key === 'database' ? 'primary' : 'secondary'} icon={Download} loading={loadingKey === option.key} disabled={loadingKey !== null && loadingKey !== option.key} onClick={() => void handleDownload(option)}>
                  {loadingKey === option.key ? '正在生成…' : '下载'}
                </Button>
              </div>
            )
          })}
        </div>
      </SectionCard>

      <SectionCard tone="danger" title="还原数据库" description="危险操作：会用备份文件覆盖当前全部数据。请先阅读上方“使用说明”。" icon={RotateCcw}>
        <div className="space-y-4">
          <Notice tone="warning" title="还原前请先下载一份最新的数据库备份">
            如果还原的文件有问题，你可以用这份备份恢复到现在的状态。
          </Notice>
          {restoreDone && (
            <Notice tone="success" title="数据库还原完成" onClose={() => setRestoreDone(false)}>
              请重新登录，并检查关键数据是否正确。
            </Notice>
          )}
          {restoreError && <Notice tone="danger" onClose={() => setRestoreError('')}>{restoreError}</Notice>}

          <div className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 p-4 sm:flex-row sm:items-center">
            <Button icon={Upload} onClick={() => restoreInputRef.current?.click()} disabled={restoring}>
              选择备份文件
            </Button>
            <div className="min-w-0 flex-1 text-sm">
              {restoreFile ? (
                <span className="break-all text-slate-800">
                  {restoreFile.name} <span className="text-slate-400">· {formatFileSize(restoreFile.size)}</span>
                </span>
              ) : (
                <span className="text-slate-500">支持 .sql、.sql.gz 和本系统生成的 .tar.gz 完整备份</span>
              )}
            </div>
            <input
              ref={restoreInputRef}
              type="file"
              accept=".sql,.gz,.tgz"
              className="hidden"
              onChange={(event) => {
                setRestoreFile(event.target.files?.[0] || null)
                setRestoreError('')
              }}
            />
          </div>

          <CheckboxRow
            checked={restoreAcknowledged}
            onChange={setRestoreAcknowledged}
            disabled={restoring}
            label="我已下载当前数据的备份，并了解还原会清空当前数据库且不可撤销"
          />

          <div className="flex justify-end">
            <Button variant="danger" icon={AlertTriangle} loading={restoring} disabled={!restoreFile || !restoreAcknowledged} onClick={() => void handleRestore()}>
              {restoring ? '正在还原，请勿关闭页面…' : '开始还原'}
            </Button>
          </div>
        </div>
      </SectionCard>
    </AdminShell>
  )
}
