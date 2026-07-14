export interface User {
  id: number
  username: string
  email: string
  avatar?: string
  status: number
  created_at: string
  updated_at: string
  roles?: Role[]
}

export interface AuthUser extends User {
  roles: Role[]
}

export interface Role {
  id: number
  name: string
  code: string
  description?: string
  created_at: string
}

export interface Workbook {
  id: number
  name: string
  description?: string
  owner_id: number
  owner_name?: string
  folder_id?: number | null
  metadata: Record<string, unknown>
  is_template: boolean
  status: number
  is_locked?: boolean
  is_hidden?: boolean
  is_public?: boolean
  locked_by_id?: number
  locked_by_name?: string
  locked_at?: string
  hidden_by_id?: number
  hidden_by_name?: string
  hidden_at?: string
  created_at: string
  updated_at: string
  sheets?: Sheet[]
}

export interface Sheet {
  id: number
  workbook_id: number
  name: string
  sort_order: number
  columns: ColumnDef[]
  frozen: { row: number; col: number }
  config: SheetConfig
  is_locked?: boolean
  is_archived?: boolean
  is_hidden?: boolean
  locked_by_id?: number
  locked_by_name?: string
  locked_at?: string
  archived_by_id?: number
  archived_by_name?: string
  archived_at?: string
  hidden_by_id?: number
  hidden_by_name?: string
  hidden_at?: string
  created_at: string
  updated_at: string
}

export interface SheetConfig {
  zoom?: number
  importSource?: {
    filename?: string
    imported_at?: string
    attachment_id?: number | null
    attachment_url?: string
    mode?: string
  }
  sheetState?: {
    locked?: { id: number; name: string; at: string }
    archived?: { id: number; name: string; at: string }
    hidden?: { id: number; name: string; at: string }
  }
  lockedCells?: Record<string, boolean>
  protections?: {
    rows?: Record<string, ProtectionOwner>
    columns?: Record<string, ProtectionOwner>
    cells?: Record<string, ProtectionOwner>
  }
  mergedCells?: MergedCellRange[]
  advancedFilter?: AdvancedFilterConfig
  univerSheetData?: unknown
  univerStyles?: unknown
}

export interface ProtectionOwner {
  ownerId: number
  ownerName: string
  editableUserIds?: number[]
  protectedAt: string
}

export interface ProtectionInfo {
  scope: 'row' | 'column' | 'cell'
  key: string
  row_index?: number
  column_key?: string
  owner_id: number
  owner_name: string
  editable_user_ids?: number[]
  protected_at: string
}

export interface ProtectionSnapshot {
  rows: ProtectionInfo[]
  columns: ProtectionInfo[]
  cells: ProtectionInfo[]
}

export interface MergedCellRange {
  startRow: number
  endRow: number
  startCol: string
  endCol: string
}

export type FilterOperator =
  | 'contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'greater_or_equal'
  | 'less_than'
  | 'less_or_equal'
  | 'is_empty'
  | 'is_not_empty'

export interface FilterRule {
  id: string
  columnKey: string
  operator: FilterOperator
  value?: string
}

export interface SortRule {
  id: string
  columnKey: string
  direction: 'asc' | 'desc'
}

export interface AdvancedFilterConfig {
  match: 'all' | 'any'
  rules: FilterRule[]
  sorts: SortRule[]
  columnFilters?: Record<string, string[]>
}

export interface ColumnDef {
  key: string
  name: string
  type: 'text' | 'number' | 'currency' | 'formula' | 'date' | 'select' | 'image'
  width?: number
  required?: boolean
  validation?: Record<string, unknown>
  formula?: string
  options?: string[]
  currencyCode?: string
  currencySource?: string
}

export interface CellStyle {
  textColor?: string
  backgroundColor?: string
}

export interface CellRecord {
  value?: unknown
  style?: CellStyle
}

export interface Row {
  id: number
  sheet_id: number
  row_index: number
  data: Record<string, unknown>
  created_by?: number
  updated_by?: number
  created_at: string
  updated_at: string
}

export interface CellUpdate {
  sheet_id: number
  row: number
  col: string
  value: unknown
}

export interface PermissionMatrix {
  sheet: {
    canView: boolean
    canEdit: boolean
    canDelete: boolean
    canExport: boolean
  }
  rows: Record<string, string>
  columns: Record<string, string>
  cells: Record<string, string>
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data?: T
}

export interface PageData<T> {
  list: T[]
  total: number
  page: number
  size: number
}

export interface WSMessage {
  type: string
  sheetId?: number
  channelId?: number
  messageId?: number
  row?: number
  col?: string
  value?: unknown
  changes?: CellUpdate[]
  afterRow?: number
  userId?: number
  username?: string
  clientId?: string
  state?: 'viewing' | 'selected' | 'editing'
  presence?: SheetPresenceEntry[]
}

export interface SheetPresenceEntry {
  userId: number
  username: string
  clientId: string
  state: 'viewing' | 'selected' | 'editing'
  row?: number
  col?: string
}

export interface Folder {
  id: number
  name: string
  parent_id: number | null
  owner_id: number
  owner_name?: string
  access_level?: 'view' | 'edit' | 'owner' | 'admin'
  can_write?: boolean
  can_manage?: boolean
  created_at: string
  updated_at: string
}

export interface FolderShareUser {
  id: number
  username: string
  email: string
  access_level: 'view' | 'edit'
}

export interface FolderContents {
  folders: Folder[]
  workbooks: Workbook[]
}

export interface GalleryDirectory {
  id: number
  name: string
  owner_id: number
  owner_name?: string
  channel_id?: number | null
  visibility: 'private' | 'channel' | 'public'
  can_manage: boolean
  can_edit: boolean
  created_at: string
  updated_at: string
}

export interface GalleryDirectoryAccess {
  directory_id: number
  visibility: 'private' | 'channel' | 'public'
  view_user_ids: number[]
  edit_user_ids: number[]
}

export interface GalleryImage {
  id: number
  filename: string
  mime_type: string
  size: number
  uploader_id: number
  uploader_name?: string
  created_at: string
  url: string
}

export interface Channel {
  id: number
  name: string
  description?: string
  owner_id: number
  owner_name?: string
  avatar_attachment_id?: number | null
  avatar_url?: string
  channel_type: 'group' | 'ai_private'
  ai_assistant_id?: number | null
  ai_assistant_name?: string
  ai_assistant_count: number
  member_count: number
  is_pinned: boolean
  pin_sort_order: number
  unread_count: number
  last_message_id?: number | null
  last_message_sender_id?: number | null
  last_message_at?: string | null
  can_manage: boolean
  created_at: string
  updated_at: string
}

export interface ChannelMember {
  channel_id: number
  user_id: number
  username: string
  email: string
  avatar?: string
  role: 'owner' | 'member'
  created_at: string
}

export interface ChannelAIMember {
  channel_id: number
  assistant_id: number
  name: string
  description: string
  model: string
  is_default: boolean
  enabled: boolean
  supports_vision: boolean
  supports_files: boolean
  created_at: string
}

export interface ChannelMessage {
  id: number
  channel_id: number
  sender_id: number
  sender_name?: string
  sender_avatar?: string
  sender_type: 'user' | 'ai' | 'whatsapp'
  external_source?: string
  external_message_id?: string
  external_sender_name?: string
  external_sender_address?: string
  external_sender_avatar?: string
  assistant_id?: number | null
  assistant_name?: string
  content: string
  attachment_id?: number | null
  attachment_url?: string
  attachment_filename?: string
  attachment_mime_type?: string
  attachment_size?: number
  linked_workbook_id?: number | null
  linked_workbook_name?: string
  linked_sheet_id?: number | null
  linked_sheet_name?: string
  linked_summary_id?: number | null
  linked_summary_title?: string
  forwarded_from_message_id?: number | null
  reply_to_message_id?: number | null
  reply_sender_id?: number | null
  reply_sender_name?: string
  reply_content?: string
  reply_attachment_filename?: string
  reply_recalled_at?: string | null
  reply_external_message_id?: string
  reply_snapshot_sender?: string
  reply_snapshot_content?: string
  recalled_at?: string | null
  recalled_by?: number | null
  edited_at?: string | null
  created_at: string
}

export interface ChannelBackup {
  id: number
  source_channel_id?: number | null
  source_channel_name: string
  created_by?: number | null
  created_by_name: string
  filename: string
  attachment_id: number
  download_url: string
  message_count: number
  size: number
  restore_count: number
  last_restored_at?: string | null
  created_at: string
}

export interface ChannelBackupRestore {
  id: number
  backup_id: number
  target_channel_id?: number | null
  target_channel_name: string
  restored_by?: number | null
  restored_by_name: string
  message_count: number
  created_at: string
}

export interface WorkbookImportResult {
  workbook: Workbook
  first_sheet_id: number
  imported_rows: number
  imported_sheets: number
  attachment_id?: number
  attachment_url?: string
}

export interface WhatsAppSettings {
  enabled: boolean
  auto_start: boolean
  proxy_type: 'none' | 'http' | 'https' | 'socks5'
  proxy_host: string
  proxy_port: number
  proxy_username: string
  proxy_password?: string
  proxy_password_configured: boolean
}

export interface WhatsAppStatus {
  status: 'disabled' | 'unavailable' | 'initializing' | 'loading' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure' | 'error'
  qrDataUrl?: string
  loadingPercent: number
  loadingMessage?: string
  account?: {
    wid?: string
    pushname?: string
    platform?: string
  }
  lastError?: string
  updatedAt?: string
}

export interface WhatsAppAccount {
  id: number
  user_id: number
  username: string
  email: string
  enabled: boolean
  auto_start: boolean
  status: WhatsAppStatus['status']
  whatsapp_id: string
  display_name: string
  phone_number: string
  profile_pic_url: string
  about: string
  platform: string
  last_error: string
  last_connected_at?: string
  created_at: string
  updated_at: string
  qr_data_url?: string
  loading_percent: number
  loading_message?: string
}

export interface WhatsAppChat {
  id: string
  name: string
  isGroup: boolean
  unreadCount: number
  timestamp: number
  pinned: boolean
  archived: boolean
  isMuted: boolean
  profilePicUrl: string
  about: string
  description: string
  participantCount: number
  lastMessage: string
}

export interface WhatsAppChannelLink {
  channel_id: number
  whatsapp_account_id: number
  whatsapp_user_id: number
  whatsapp_username: string
  whatsapp_display_name: string
  whatsapp_chat_id: string
  whatsapp_chat_name: string
  whatsapp_chat_avatar_url: string
  whatsapp_chat_about: string
  whatsapp_is_group: boolean
  whatsapp_participant_count: number
  sync_inbound: boolean
  sync_outbound: boolean
  created_by: number
  created_at: string
  updated_at: string
}

export interface ChannelMessageSearchResult extends ChannelMessage {
  channel_name: string
}

export interface ChannelAIAskResult {
  user_message: ChannelMessage
  assistant_message: ChannelMessage
  assistant_id: number
  assistant_name: string
  touched_sheet_ids?: number[]
  changed_sheet_ids?: number[]
  resources_changed?: boolean
  pending_operations?: AISpreadsheetOperation[]
}

export interface AIChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AIChatToolTrace {
  name: string
  status: 'success' | 'error'
  summary?: string
  data?: unknown
  touched_sheet_ids?: number[]
}

export interface AIChatResponse {
  assistant_id: number
  assistant_name: string
  reply: string
  model: string
  touched_sheet_ids?: number[]
  changed_sheet_ids?: number[]
  resources_changed?: boolean
  pending_operations?: AISpreadsheetOperation[]
  tool_traces?: AIChatToolTrace[]
}

export interface AIConfigStatus {
  configured: boolean
  endpoint: string
  model: string
}

export interface AIAssistant {
  id: number
  name: string
  description: string
  endpoint?: string
  model: string
  has_api_key: boolean
  system_prompt?: string
  enabled: boolean
  is_default: boolean
  supports_vision: boolean
  supports_files: boolean
  created_by?: number
  created_at?: string
  updated_at?: string
}

export interface AISummaryMetric {
  label: string
  value: string
  hint?: string
}

export interface AISummarySection {
  title: string
  body: string
  bullets?: string[]
}

export interface AISummarySource {
  workbook_id: number
  workbook_name: string
  sheet_names: string[]
}

export interface AISummaryContent {
  headline: string
  overview: string
  metrics: AISummaryMetric[]
  sections: AISummarySection[]
  sources: AISummarySource[]
}

export interface AISummaryPage {
  id: number
  title: string
  owner_id: number
  owner_name?: string
  assistant_id?: number
  assistant_name?: string
  source_workbook_ids: number[]
  content: AISummaryContent
  created_at: string
  updated_at: string
}

export interface AISpreadsheetOperation {
  kind?: 'update_cell' | 'insert_row' | 'delete_row' | 'insert_column' | 'fill_formula' | 'create_workbook' | 'create_sheet' | 'update_workbook' | 'update_sheet_name' | 'set_cell_format'
  sheet_id: number
  sheet_name: string
  row?: number
  column_key?: string
  column_name?: string
  current_value?: unknown
  value: unknown
  reason?: string
  row_values?: Record<string, unknown>
  column_type?: string
  insert_after_column_key?: string
  start_row?: number
  end_row?: number
  formula_template?: string
}

export interface AISpreadsheetPlanResponse {
  reply: string
  model: string
  operations: AISpreadsheetOperation[]
}
