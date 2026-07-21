export interface User {
  id: number;
  username: string;
  email: string;
  avatar?: string;
  status: number;
  created_at: string;
  updated_at: string;
  roles?: Role[];
}

export interface Department {
  id: number;
  name: string;
  description: string;
  created_by?: number;
  member_ids: number[];
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface AuthUser extends User {
  roles: Role[];
}

export interface Role {
  id: number;
  name: string;
  code: string;
  description?: string;
  created_at: string;
}

export interface Workbook {
  id: number;
  name: string;
  description?: string;
  owner_id: number;
  owner_name?: string;
  folder_id?: number | null;
  metadata: Record<string, unknown>;
  is_template: boolean;
  status: number;
  is_locked?: boolean;
  is_hidden?: boolean;
  is_public?: boolean;
  can_manage?: boolean;
  locked_by_id?: number;
  locked_by_name?: string;
  locked_at?: string;
  hidden_by_id?: number;
  hidden_by_name?: string;
  hidden_at?: string;
  deleted_at?: string;
  deleted_by_id?: number;
  deleted_by_name?: string;
  created_at: string;
  updated_at: string;
  sheets?: Sheet[];
}

export interface Sheet {
  id: number;
  workbook_id: number;
  name: string;
  sort_order: number;
  columns: ColumnDef[];
  frozen: { row: number; col: number };
  config: SheetConfig;
  is_locked?: boolean;
  is_archived?: boolean;
  is_hidden?: boolean;
  access_level?: "read" | "write";
  locked_by_id?: number;
  locked_by_name?: string;
  locked_at?: string;
  archived_by_id?: number;
  archived_by_name?: string;
  archived_at?: string;
  hidden_by_id?: number;
  hidden_by_name?: string;
  hidden_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SheetConfig {
  zoom?: number;
  importSource?: {
    filename?: string;
    imported_at?: string;
    attachment_id?: number | null;
    attachment_url?: string;
    mode?: string;
  };
  sheetState?: {
    locked?: { id: number; name: string; at: string };
    archived?: { id: number; name: string; at: string };
    hidden?: { id: number; name: string; at: string };
  };
  lockedCells?: Record<string, boolean>;
  protections?: {
    rows?: Record<string, ProtectionOwner>;
    columns?: Record<string, ProtectionOwner>;
    cells?: Record<string, ProtectionOwner>;
  };
  mergedCells?: MergedCellRange[];
  advancedFilter?: AdvancedFilterConfig;
  univerSheetData?: unknown;
  univerStyles?: unknown;
}

export interface ProtectionOwner {
  ownerId: number;
  ownerName: string;
  readonlyUserIds?: number[];
  readonlyDepartmentIds?: number[];
  editableUserIds?: number[];
  editableDepartmentIds?: number[];
  viewHiddenUserIds?: number[];
  viewHiddenDepartmentIds?: number[];
  lockEditing?: boolean;
  hidden?: boolean;
  protectedAt: string;
}

export interface ProtectionInfo {
  scope: "row" | "column" | "cell";
  key: string;
  row_index?: number;
  column_key?: string;
  owner_id: number;
  owner_name: string;
  readonly_user_ids?: number[];
  readonly_department_ids?: number[];
  editable_user_ids?: number[];
  editable_department_ids?: number[];
  view_hidden_user_ids?: number[];
  view_hidden_department_ids?: number[];
  lock_editing: boolean;
  hidden?: boolean;
  can_edit: boolean;
  masked_for_current_user: boolean;
  protected_at: string;
}

export interface ProtectionSnapshot {
  rows: ProtectionInfo[];
  columns: ProtectionInfo[];
  cells: ProtectionInfo[];
}

export interface MergedCellRange {
  startRow: number;
  endRow: number;
  startCol: string;
  endCol: string;
}

export type FilterOperator =
  | "contains"
  | "equals"
  | "not_equals"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "is_empty"
  | "is_not_empty";

export interface FilterRule {
  id: string;
  columnKey: string;
  operator: FilterOperator;
  value?: string;
}

export interface SortRule {
  id: string;
  columnKey: string;
  direction: "asc" | "desc";
}

export interface AdvancedFilterConfig {
  match: "all" | "any";
  rules: FilterRule[];
  sorts: SortRule[];
  columnFilters?: Record<string, string[]>;
}

export interface ColumnDef {
  key: string;
  name: string;
  type:
    | "text"
    | "number"
    | "currency"
    | "percentage"
    | "formula"
    | "date"
    | "select"
    | "checkbox"
    | "image";
  width?: number;
  required?: boolean;
  validation?: Record<string, unknown>;
  formula?: string;
  options?: string[];
  optionColors?: Record<
    string,
    { backgroundColor?: string; textColor?: string }
  >;
  searchable?: boolean;
  currencyCode?: string;
  currencySource?: string;
}

export interface CellStyle {
  textColor?: string;
  backgroundColor?: string;
}

export interface CellRecord {
  value?: unknown;
  style?: CellStyle;
}

export interface Row {
  id: number;
  sheet_id: number;
  row_index: number;
  data: Record<string, unknown>;
  created_by?: number;
  updated_by?: number;
  created_at: string;
  updated_at: string;
}

export interface CellUpdate {
  sheet_id: number;
  row: number;
  col: string;
  value: unknown;
}

export interface PermissionMatrix {
  sheet: {
    canView: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canExport: boolean;
  };
  defaultPermission?: string;
  rows: Record<string, string>;
  columns: Record<string, string>;
  cells: Record<string, string>;
  departmentOverrides: ScopedPermissionLayer;
  userOverrides: ScopedPermissionLayer;
  explicitUserSheetRule?: boolean;
}

export interface ScopedPermissionLayer {
  rows: Record<string, string>;
  columns: Record<string, string>;
  cells: Record<string, string>;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
}

export interface PageData<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

export interface WSMessage {
  type: string;
  sheetId?: number;
  channelId?: number;
  messageId?: number;
  orderId?: number;
  row?: number;
  col?: string;
  value?: unknown;
  changes?: CellUpdate[];
  afterRow?: number;
  userId?: number;
  username?: string;
  clientId?: string;
  state?: "viewing" | "selected" | "editing";
  presence?: SheetPresenceEntry[];
}

export interface SheetPresenceEntry {
  userId: number;
  username: string;
  clientId: string;
  state: "viewing" | "selected" | "editing";
  row?: number;
  col?: string;
}

export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  owner_id: number;
  owner_name?: string;
  access_level?: "view" | "edit" | "owner" | "admin";
  can_write?: boolean;
  can_manage?: boolean;
  deleted_at?: string;
  deleted_by_id?: number;
  deleted_by_name?: string;
  created_at: string;
  updated_at: string;
}

export interface FolderShareUser {
  id: number;
  username: string;
  email: string;
  access_level: "view" | "edit";
}

export interface FolderContents {
  folders: Folder[];
  workbooks: Workbook[];
}

export interface FolderOption {
  id: number;
  name: string;
  path: string;
  parent_id?: number | null;
  owner_id: number;
  can_write: boolean;
}

export interface RecycleBinContents {
  folders: Folder[];
  workbooks: Workbook[];
  trade_orders: DeletedTradeOrder[];
  retention_days: number;
}

export interface DeletedTradeOrder {
  id: number;
  order_no: string;
  title: string;
  stage: TradeStage;
  customer_name: string;
  customer_company: string;
  owner_id: number;
  owner_name: string;
  workbook_id?: number;
  workbook_name: string;
  item_count: number;
  supplier_quote_count: number;
  customer_quote_count: number;
  stage_event_count: number;
  inspection_photo_count: number;
  deleted_at?: string;
  deleted_by_id?: number;
  deleted_by_name?: string;
  created_at: string;
  updated_at: string;
}

export interface GalleryDirectory {
  id: number;
  name: string;
  owner_id: number;
  owner_name?: string;
  channel_id?: number | null;
  visibility: "private" | "channel" | "public";
  can_manage: boolean;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
}

export interface GalleryDirectoryAccess {
  directory_id: number;
  visibility: "private" | "channel" | "public";
  view_user_ids: number[];
  edit_user_ids: number[];
}

export interface GalleryImage {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
  uploader_id: number;
  uploader_name?: string;
  created_at: string;
  url: string;
  thumbnail_url?: string;
  can_manage: boolean;
}

export interface Channel {
  id: number;
  name: string;
  description?: string;
  owner_id: number;
  owner_name?: string;
  avatar_attachment_id?: number | null;
  avatar_url?: string;
  channel_type: "group" | "ai_private";
  ai_assistant_id?: number | null;
  ai_assistant_name?: string;
  ai_assistant_count: number;
  member_count: number;
  is_pinned: boolean;
  pin_sort_order: number;
  unread_count: number;
  last_message_id?: number | null;
  last_message_sender_id?: number | null;
  last_message_at?: string | null;
  search_text?: string;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChannelMember {
  channel_id: number;
  user_id: number;
  username: string;
  email: string;
  avatar?: string;
  role: "owner" | "member";
  created_at: string;
}

export interface ChannelAIMember {
  channel_id: number;
  assistant_id: number;
  name: string;
  description: string;
  model: string;
  is_default: boolean;
  enabled: boolean;
  supports_vision: boolean;
  supports_files: boolean;
  created_at: string;
}

export interface ChannelMessage {
  id: number;
  channel_id: number;
  sender_id: number;
  sender_name?: string;
  sender_avatar?: string;
  sender_type: "user" | "ai" | "whatsapp";
  external_source?: string;
  external_message_id?: string;
  external_sender_name?: string;
  external_sender_address?: string;
  external_sender_avatar?: string;
  assistant_id?: number | null;
  assistant_name?: string;
  content: string;
  attachment_id?: number | null;
  attachment_url?: string;
  attachment_filename?: string;
  attachment_mime_type?: string;
  attachment_size?: number;
  linked_workbook_id?: number | null;
  linked_workbook_name?: string;
  linked_sheet_id?: number | null;
  linked_sheet_name?: string;
  linked_summary_id?: number | null;
  linked_summary_title?: string;
  forwarded_from_message_id?: number | null;
  reply_to_message_id?: number | null;
  reply_sender_id?: number | null;
  reply_sender_name?: string;
  reply_content?: string;
  reply_attachment_filename?: string;
  reply_recalled_at?: string | null;
  reply_external_message_id?: string;
  reply_snapshot_sender?: string;
  reply_snapshot_content?: string;
  recalled_at?: string | null;
  recalled_by?: number | null;
  edited_at?: string | null;
  translated_content?: string;
  translation_language?: string;
  translated_at?: string | null;
  staff_read_count: number;
  staff_read_names?: string;
  whatsapp_ack?: number | null;
  whatsapp_direction?: "inbound" | "outbound" | "";
  whatsapp_receipt_at?: string | null;
  created_at: string;
}

export interface ChannelBackup {
  id: number;
  source_channel_id?: number | null;
  source_channel_name: string;
  created_by?: number | null;
  created_by_name: string;
  filename: string;
  attachment_id: number;
  download_url: string;
  message_count: number;
  size: number;
  checksum?: string;
  snapshot_version: number;
  verified_at?: string | null;
  restore_count: number;
  last_restored_at?: string | null;
  created_at: string;
}

export interface ChannelBackupRestore {
  id: number;
  backup_id: number;
  target_channel_id?: number | null;
  target_channel_name: string;
  restored_by?: number | null;
  restored_by_name: string;
  message_count: number;
  created_at: string;
}

export interface WorkbookImportResult {
  workbook: Workbook;
  first_sheet_id: number;
  imported_rows: number;
  imported_sheets: number;
  attachment_id?: number;
  attachment_url?: string;
}

export interface WhatsAppSettings {
  enabled: boolean;
  auto_start: boolean;
  proxy_type: "none" | "http" | "https" | "socks5";
  proxy_host: string;
  proxy_port: number;
  proxy_username: string;
  proxy_password?: string;
  proxy_password_configured: boolean;
}

export interface WhatsAppStatus {
  status:
    | "disabled"
    | "unavailable"
    | "initializing"
    | "loading"
    | "qr"
    | "authenticated"
    | "ready"
    | "disconnected"
    | "auth_failure"
    | "error";
  qrDataUrl?: string;
  loadingPercent: number;
  loadingMessage?: string;
  account?: {
    wid?: string;
    pushname?: string;
    platform?: string;
  };
  lastError?: string;
  updatedAt?: string;
}

export interface WhatsAppAccount {
  id: number;
  user_id: number;
  username: string;
  email: string;
  enabled: boolean;
  auto_start: boolean;
  status: WhatsAppStatus["status"];
  whatsapp_id: string;
  display_name: string;
  phone_number: string;
  profile_pic_url: string;
  about: string;
  platform: string;
  last_error: string;
  last_connected_at?: string;
  created_at: string;
  updated_at: string;
  qr_data_url?: string;
  loading_percent: number;
  loading_message?: string;
}

export interface WhatsAppChat {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  pinned: boolean;
  archived: boolean;
  isMuted: boolean;
  profilePicUrl: string;
  about: string;
  description: string;
  participantCount: number;
  lastMessage: string;
  searchAliases?: string[];
}

export interface WhatsAppChannelLink {
  channel_id: number;
  whatsapp_account_id: number;
  whatsapp_user_id: number;
  whatsapp_username: string;
  whatsapp_display_name: string;
  whatsapp_chat_id: string;
  whatsapp_chat_name: string;
  whatsapp_chat_avatar_url: string;
  whatsapp_chat_about: string;
  whatsapp_is_group: boolean;
  whatsapp_participant_count: number;
  sync_inbound: boolean;
  sync_outbound: boolean;
  created_by: number;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppHistorySyncResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface WhatsAppContactSyncResult {
  created: number;
  skipped: number;
  failed: number;
  total: number;
  channel_ids: number[];
  errors?: string[];
}

export interface ChannelMessageSearchResult extends ChannelMessage {
  channel_name: string;
}

export interface ChannelAIAskResult {
  user_message: ChannelMessage;
  assistant_message: ChannelMessage;
  assistant_id: number;
  assistant_name: string;
  touched_sheet_ids?: number[];
  changed_sheet_ids?: number[];
  resources_changed?: boolean;
  pending_operations?: AISpreadsheetOperation[];
}

export interface AIChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AIChatToolTrace {
  name: string;
  status: "success" | "error";
  summary?: string;
  data?: unknown;
  touched_sheet_ids?: number[];
}

export interface AIChatResponse {
  assistant_id: number;
  assistant_name: string;
  reply: string;
  model: string;
  touched_sheet_ids?: number[];
  changed_sheet_ids?: number[];
  resources_changed?: boolean;
  pending_operations?: AISpreadsheetOperation[];
  tool_traces?: AIChatToolTrace[];
}

export interface AIConfigStatus {
  configured: boolean;
  endpoint: string;
  model: string;
}

export interface AIAssistant {
  id: number;
  name: string;
  description: string;
  endpoint?: string;
  model: string;
  has_api_key: boolean;
  system_prompt?: string;
  enabled: boolean;
  is_default: boolean;
  supports_vision: boolean;
  supports_files: boolean;
  created_by?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AISummaryMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface AISummarySection {
  title: string;
  body: string;
  bullets?: string[];
}

export interface AISummarySource {
  workbook_id: number;
  workbook_name: string;
  sheet_names: string[];
}

export interface AISummaryContent {
  headline: string;
  overview: string;
  metrics: AISummaryMetric[];
  sections: AISummarySection[];
  sources: AISummarySource[];
}

export interface AISummaryPage {
  id: number;
  title: string;
  owner_id: number;
  owner_name?: string;
  assistant_id?: number;
  assistant_name?: string;
  source_workbook_ids: number[];
  content: AISummaryContent;
  created_at: string;
  updated_at: string;
}

export interface AISpreadsheetOperation {
  kind?:
    | "update_cell"
    | "insert_row"
    | "delete_row"
    | "insert_column"
    | "fill_formula"
    | "create_workbook"
    | "create_sheet"
    | "update_workbook"
    | "update_sheet_name"
    | "set_cell_format";
  sheet_id: number;
  sheet_name: string;
  row?: number;
  column_key?: string;
  column_name?: string;
  current_value?: unknown;
  value: unknown;
  reason?: string;
  row_values?: Record<string, unknown>;
  column_type?: string;
  insert_after_column_key?: string;
  start_row?: number;
  end_row?: number;
  formula_template?: string;
}

export interface AISpreadsheetPlanResponse {
  reply: string;
  model: string;
  operations: AISpreadsheetOperation[];
}

export interface SheetVersion {
  id: number;
  sheet_id: number;
  version_number: number;
  created_by?: number;
  created_by_name: string;
  source: string;
  summary: string;
  checksum?: string;
  change_count: number;
  restored_from_id?: number;
  restored_from_version?: number;
  created_at: string;
  updated_at: string;
  can_view_details: boolean;
  can_restore: boolean;
}

export interface SheetVersionCellChange {
  row: number;
  column: string;
  old_value?: unknown;
  new_value?: unknown;
  kind: "added" | "modified" | "removed";
}

export interface SheetVersionFieldChange {
  field: string;
  old_value?: unknown;
  new_value?: unknown;
}

export interface SheetVersionDiff {
  version: SheetVersion;
  changed_cells: number;
  added_rows: number;
  removed_rows: number;
  modified_rows: number;
  field_changes: SheetVersionFieldChange[];
  cell_changes: SheetVersionCellChange[];
  cell_changes_limited: boolean;
}

export interface OperationLog {
  id: number;
  user_id?: number;
  username: string;
  sheet_id?: number;
  sheet_name: string;
  workbook_id?: number;
  workbook_name: string;
  resource_type: string;
  resource_id?: number;
  row_index?: number;
  column_key?: string;
  action: string;
  source: string;
  summary: string;
  old_value?: unknown;
  new_value?: unknown;
  metadata?: Record<string, unknown>;
  request_id?: string;
  ip_address?: string;
  user_agent?: string;
  created_at: string;
}

export type AutomationTriggerType = "cell_change" | "schedule" | "manual";
export type AutomationRunStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";
export type AutomationConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "not_empty"
  | "in"
  | "regex";

export interface AutomationCondition {
  column: string;
  operator: AutomationConditionOperator;
  value?: unknown;
}

export interface AutomationApprovalStep {
  name: string;
  user_ids: number[];
  department_ids: number[];
  required_approvals: number;
}

export interface AutomationApprovalRange {
  start_row?: number;
  end_row?: number;
  columns: string[];
}

export interface AutomationAction {
  type: "notify" | "channel_message" | "update_cell";
  title_template?: string;
  message_template?: string;
  recipient_type?: "owner" | "trigger_user" | "users_departments";
  user_ids?: number[];
  department_ids?: number[];
  channel_id?: number;
  send_whatsapp?: boolean;
  target_column?: string;
  value?: unknown;
  value_template?: string;
}

export interface AutomationRule {
  id: number;
  name: string;
  description: string;
  owner_id: number;
  owner_name: string;
  sheet_id?: number;
  sheet_name?: string;
  workbook_id?: number;
  workbook_name?: string;
  trigger_type: AutomationTriggerType;
  watched_columns: string[];
  cron_expr: string;
  timezone: string;
  condition_logic: "all" | "any";
  conditions: AutomationCondition[];
  approval_steps: AutomationApprovalStep[];
  approval_ranges: AutomationApprovalRange[];
  actions: AutomationAction[];
  hold_changes: boolean;
  enabled: boolean;
  last_triggered_at?: string;
  last_status?: AutomationRunStatus;
  last_message: string;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationTriggerContext {
  sheet_id?: number;
  row_index?: number;
  row_data?: Record<string, unknown>;
  changed_values?: Record<string, unknown>;
  changed_columns?: string[];
  field_labels?: Record<string, string>;
  pending_changes?: Array<{
    sheet_id: number;
    row: number;
    col: string;
    proposed_value: unknown;
    original_value: unknown;
  }>;
  triggered_at: string;
  metadata?: Record<string, unknown>;
}

export interface CellApprovalState {
  id: number;
  run_id: number;
  rule_id?: number;
  rule_name: string;
  sheet_id: number;
  row: number;
  col: string;
  status: "pending" | "approved" | "rejected" | "failed" | "cancelled";
  proposed_value?: unknown;
  original_value?: unknown;
  submitted_by: number;
  submitted_by_name: string;
  related_data?: Record<string, unknown>;
  field_labels?: Record<string, string>;
  submitted_at: string;
  decided_at?: string;
  updated_at: string;
}

export interface CellUpdateResult {
  applied_changes: CellUpdate[];
  pending_states: CellApprovalState[];
  reverted_changes: CellUpdate[];
}

export interface AutomationRun {
  id: number;
  rule_id?: number;
  rule_name: string;
  rule_snapshot: Omit<
    AutomationRule,
    | "description"
    | "owner_name"
    | "sheet_name"
    | "workbook_id"
    | "workbook_name"
    | "cron_expr"
    | "timezone"
    | "enabled"
    | "last_triggered_at"
    | "last_status"
    | "last_message"
    | "next_run_at"
    | "created_at"
    | "updated_at"
  >;
  trigger_type: AutomationTriggerType;
  status: AutomationRunStatus;
  triggered_by?: number;
  triggered_by_name?: string;
  sheet_id?: number;
  sheet_name?: string;
  workbook_name?: string;
  row_index?: number;
  trigger_context: AutomationTriggerContext;
  current_step: number;
  result?: unknown;
  error_message: string;
  started_at: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalAssignee {
  user_id: number;
  username: string;
  avatar?: string;
  source_type: "user" | "department";
  source_id?: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  comment: string;
  decided_at?: string;
}

export interface ApprovalRequest {
  id: number;
  run_id: number;
  rule_name: string;
  step_index: number;
  name: string;
  status: "queued" | "pending" | "approved" | "rejected" | "cancelled";
  required_approvals: number;
  approved_count: number;
  assignees: ApprovalAssignee[];
  run?: AutomationRun;
  activated_at?: string;
  decided_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationRunLog {
  id: number;
  run_id: number;
  level: "info" | "warning" | "error";
  event: string;
  message: string;
  details?: unknown;
  created_at: string;
}

export interface AutomationRunDetail {
  run: AutomationRun;
  approvals: ApprovalRequest[];
  logs: AutomationRunLog[];
}

export interface UserNotification {
  id: number;
  user_id: number;
  notification_type: "automation" | "approval" | string;
  title: string;
  content: string;
  link_url: string;
  entity_type: string;
  entity_id?: number;
  metadata?: Record<string, unknown>;
  read_at?: string;
  created_at: string;
}

export interface TaskCenterSummary {
  pending_approvals: number;
  unread_erp_tasks: number;
  unread_system_notifications: number;
  unread_notifications: number;
}

export type TradeStage =
  | "inquiry"
  | "supplier_quote"
  | "quotation"
  | "purchase"
  | "receiving"
  | "inspection"
  | "packing"
  | "shipment"
  | "completed"
  | "cancelled";

export interface TradeSupplier {
  id: number;
  supplier_code: string;
  owner_id: number;
  owner_name: string;
  name: string;
  company_name: string;
  contact_name: string;
  phone: string;
  email: string;
  whatsapp: string;
  country: string;
  default_currency: string;
  payment_method: string;
  status: "active" | "inactive" | "blocked";
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TradeCustomer {
  id: number;
  customer_code: string;
  owner_id: number;
  owner_name: string;
  name: string;
  company_name: string;
  country: string;
  region: string;
  contact_name: string;
  email: string;
  phone: string;
  source:
    | "manual"
    | "whatsapp"
    | "email"
    | "website"
    | "exhibition"
    | "referral"
    | "marketplace"
    | "other";
  status: "lead" | "active" | "inactive" | "blocked";
  customer_level: "A" | "B" | "C";
  whatsapp_account_id?: number;
  whatsapp_chat_id: string;
  whatsapp_chat_name: string;
  avatar_url: string;
  channel_id?: number;
  workbook_folder_id?: number;
  workbook_folder_name: string;
  tags: string[];
  notes: string;
  order_count: number;
  open_order_count: number;
  integration_warning?: string;
  created_at: string;
  updated_at: string;
}

export interface TradeCustomerDeleteRequest {
  id: number;
  customer_id: number;
  customer_code: string;
  customer_name: string;
  customer_company: string;
  requested_by?: number;
  requester_name: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decided_by?: number;
  decider_name: string;
  decision_comment: string;
  requested_at: string;
  decided_at?: string;
  updated_at: string;
}

export interface TradeOrderItem {
  id: number;
  order_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  description: string;
  specification: string;
  quantity: number;
  unit: string;
  target_price: number;
  quoted_price: number;
  supplier_name: string;
  purchase_currency: string;
  purchase_price: number;
  received_quantity: number;
  accepted_quantity: number;
  packed_quantity: number;
  carton_count: number;
  hs_code: string;
  gross_weight: number;
  net_weight: number;
  status: string;
  workflow_data?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TradeOrderStageEvent {
  id: number;
  order_id: number;
  from_stage: TradeStage | "";
  to_stage: TradeStage;
  actor_id?: number;
  actor_name: string;
  note: string;
  snapshot?: Record<string, unknown>;
  created_at: string;
}

export interface TradeSupplierQuote {
  id: number;
  order_id: number;
  order_item_id: number;
  line_no: number;
  sheet_row_index: number;
  supplier_id?: number;
  supplier_code: string;
  supplier_name: string;
  sku: string;
  product_name: string;
  currency: string;
  unit_price: number;
  moq: number;
  lead_time_days: number;
  valid_until?: string;
  is_selected: boolean;
  notes: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export type TradeCustomerQuoteStatus =
  "draft" | "sent" | "negotiating" | "accepted" | "rejected" | "superseded";

export interface TradeCustomerQuoteItem {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  amount: number;
}

export interface TradeCustomerQuoteRound {
  id: number;
  order_id: number;
  round_no: number;
  currency: string;
  status: TradeCustomerQuoteStatus;
  goods_amount: number;
  exchange_rate_cny: number;
  freight_mode: "customer_forwarder" | "quoted";
  freight_amount: number;
  total_amount: number;
  total_amount_cny: number;
  items: TradeCustomerQuoteItem[];
  customer_feedback: string;
  notes: string;
  payment_status: "unpaid" | "partial" | "paid";
  payment_currency: string;
  paid_amount: number;
  payment_proofs?: TradePaymentProof[];
  created_by: number;
  created_by_name: string;
  sent_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TradeShipment {
  order_id: number;
  booking_no: string;
  carrier: string;
  vessel_flight: string;
  etd?: string;
  eta?: string;
  bl_no: string;
  shipping_status: string;
  actual_freight_currency: string;
  actual_freight_amount: number;
  actual_freight_to_cny_rate: number;
  actual_freight_notes: string;
  notes: string;
  updated_at: string;
}

export interface TradeInspectionPhoto {
  id: number;
  order_id: number;
  order_item_id?: number;
  order_item_line_no?: number;
  sku: string;
  attachment_id: number;
  attachment_url: string;
  thumbnail_url: string;
  filename: string;
  note: string;
  uploaded_by: number;
  uploaded_by_name: string;
  gallery_directory_id?: number;
  created_at: string;
}

export interface TradePaymentProof {
  id: number;
  order_id: number;
  quote_id: number;
  attachment_id: number;
  attachment_url: string;
  thumbnail_url: string;
  filename: string;
  note: string;
  uploaded_by: number;
  uploaded_by_name: string;
  gallery_directory_id?: number;
  created_at: string;
}

export interface TradePackingGroupItem {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  quantity: number;
}

export interface TradePackingGroup {
  id: number;
  order_id: number;
  group_no: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  weight_kg: number;
  volumetric_weight_kg: number;
  copies: number;
  items: TradePackingGroupItem[];
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TradePositionMember {
  user_id: number;
  username: string;
  avatar: string;
}

export interface TradePosition {
  id: number;
  code: string;
  name: string;
  description: string;
  stage: TradeStage;
  sort_order: number;
  enabled: boolean;
  members: TradePositionMember[];
}

export interface TradeSettings {
  payment_methods: string[];
  pi_profile: TradePIProfile;
}

export interface TradePIProfile {
  company_name: string;
  address: string;
  contact_name: string;
  phone: string;
  email: string;
  tax_id: string;
  bank_name: string;
  bank_address: string;
  account_name: string;
  account_number: string;
  swift_code: string;
  beneficiary_address: string;
  default_notes: string;
}

export interface TradeAccessProfile {
  user_id: number;
  is_admin: boolean;
  is_manager: boolean;
  position_codes: string[];
  position_names: string[];
  allowed_stages: TradeStage[];
  can_view_all_orders: boolean;
  can_view_customers: boolean;
  can_create_customers: boolean;
  can_create_orders: boolean;
  can_view_suppliers: boolean;
  can_manage_suppliers: boolean;
  scope_label: string;
}

export interface TradeOrderAccess {
  scope_label: string;
  can_view_customer: boolean;
  can_view_customer_contact: boolean;
  can_view_customer_pricing: boolean;
  can_view_supplier: boolean;
  can_view_supplier_pricing: boolean;
  can_view_receiving: boolean;
  can_view_inspection: boolean;
  can_view_packing: boolean;
  can_view_shipment: boolean;
  can_view_profit: boolean;
  can_view_timeline: boolean;
  can_sync_workbook: boolean;
  can_add_items: boolean;
  visible_sheet_names: string[];
  editable_sheet_names: string[];
}

export interface TradeProfitLine {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  quantity: number;
  sales_unit_price: number;
  revenue: number;
  purchase_currency: string;
  purchase_unit_price: number;
  cost_exchange_rate: number;
  purchase_cost: number;
  profit_amount: number;
  profit_margin: number;
  cost_complete: boolean;
}

export interface TradeProfitSummary {
  currency: string;
  revenue: number;
  goods_revenue: number;
  freight_revenue: number;
  product_cost: number;
  actual_freight_cost: number;
  additional_cost: number;
  total_cost: number;
  goods_profit: number;
  freight_profit: number;
  profit_amount: number;
  profit_margin: number;
  exchange_rate_cny: number;
  revenue_cny: number;
  total_cost_cny: number;
  profit_amount_cny: number;
  freight_revenue_cny: number;
  freight_cost_cny: number;
  freight_profit_cny: number;
  cost_complete: boolean;
  cny_complete: boolean;
  finalized: boolean;
  warnings: string[];
  additional_cost_notes: string;
  lines?: TradeProfitLine[];
}

export interface TradeBossCurrencySummary {
  currency: string;
  order_count: number;
  revenue: number;
  goods_revenue: number;
  freight_revenue: number;
  product_cost: number;
  actual_freight_cost: number;
  additional_cost: number;
  total_cost: number;
  freight_profit: number;
  profit_amount: number;
  profit_margin: number;
}

export interface TradeBossOrderSummary {
  id: number;
  order_no: string;
  title: string;
  customer_name: string;
  owner_name: string;
  stage: TradeStage;
  currency: string;
  revenue: number;
  goods_revenue: number;
  freight_revenue: number;
  total_cost: number;
  actual_freight_cost: number;
  freight_profit: number;
  profit_amount: number;
  profit_margin: number;
  revenue_cny: number;
  total_cost_cny: number;
  profit_amount_cny: number;
  freight_profit_cny: number;
  cost_complete: boolean;
  cny_complete: boolean;
  warnings: string[];
  updated_at: string;
}

export interface TradeBossMonthlySummary {
  month: string;
  completed_orders: number;
  finalized_orders: number;
  incomplete_orders: number;
  revenue_cny: number;
  total_cost_cny: number;
  profit_amount_cny: number;
  freight_profit_cny: number;
  profit_margin: number;
}

export interface TradeBossDashboard {
  total_orders: number;
  active_orders: number;
  completed_orders: number;
  profitable_orders: number;
  loss_orders: number;
  incomplete_cost_orders: number;
  cny_complete_orders: number;
  revenue_cny: number;
  total_cost_cny: number;
  profit_amount_cny: number;
  freight_revenue_cny: number;
  freight_cost_cny: number;
  freight_profit_cny: number;
  currencies: TradeBossCurrencySummary[];
  monthly: TradeBossMonthlySummary[];
  recent_orders: TradeBossOrderSummary[];
  top_profit_orders: TradeBossOrderSummary[];
  loss_orders_list: TradeBossOrderSummary[];
}

export interface TradeOrder {
  id: number;
  order_no: string;
  customer_id: number;
  customer_name: string;
  customer_company: string;
  customer_avatar_url: string;
  owner_id: number;
  owner_name: string;
  title: string;
  stage: TradeStage;
  priority: "low" | "normal" | "high" | "urgent";
  inquiry_date: string;
  quote_deadline?: string;
  expected_ship_date?: string;
  currency: string;
  incoterm: string;
  destination_country: string;
  destination_port: string;
  payment_terms: string;
  payment_method: string;
  total_amount: number;
  quoted_goods_amount: number;
  quote_exchange_rate_cny: number;
  freight_mode: "customer_forwarder" | "quoted";
  quoted_freight_amount: number;
  actual_freight_currency: string;
  actual_freight_amount: number;
  actual_freight_to_cny_rate: number;
  actual_freight_notes: string;
  additional_cost_amount: number;
  additional_cost_notes: string;
  workbook_id?: number;
  workbook_sheet_id?: number;
  workspace_folder_id?: number;
  workspace_folder_name: string;
  channel_id?: number;
  notes: string;
  label_width_mm: number;
  label_height_mm: number;
  label_paper_size: string;
  label_paper_width_mm: number;
  label_paper_height_mm: number;
  label_orientation: "portrait" | "landscape";
  label_margin_top_mm: number;
  label_margin_right_mm: number;
  label_margin_bottom_mm: number;
  label_margin_left_mm: number;
  label_gap_x_mm: number;
  label_gap_y_mm: number;
  label_content_scale: number;
  label_start_slot: number;
  label_offset_x_mm: number;
  label_offset_y_mm: number;
  inspection_gallery_directory_id?: number;
  payment_gallery_directory_id?: number;
  rework_required: boolean;
  rework_reason: string;
  rework_count: number;
  item_count: number;
  required_position_code: string;
  required_position_name: string;
  can_operate_stage: boolean;
  can_advance: boolean;
  can_return: boolean;
  advance_blockers: string[];
  access?: TradeOrderAccess;
  stage_updated_at: string;
  created_at: string;
  updated_at: string;
  customer?: TradeCustomer;
  items?: TradeOrderItem[];
  events?: TradeOrderStageEvent[];
  supplier_quotes?: TradeSupplierQuote[];
  customer_quotes?: TradeCustomerQuoteRound[];
  inspection_photos?: TradeInspectionPhoto[];
  packing_groups?: TradePackingGroup[];
  shipment?: TradeShipment;
  profit_summary?: TradeProfitSummary;
}

export interface TradeDashboard {
  customer_count: number;
  active_order_count: number;
  pending_quote_count: number;
  purchase_count: number;
  warehouse_count: number;
  shipping_count: number;
  overdue_quote_count: number;
  completed_this_month: number;
  stage_counts: Partial<Record<TradeStage, number>>;
}
