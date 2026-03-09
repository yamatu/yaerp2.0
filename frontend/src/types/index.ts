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
  metadata: Record<string, unknown>
  is_template: boolean
  status: number
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
  created_at: string
  updated_at: string
}

export interface SheetConfig {
  zoom?: number
  lockedCells?: Record<string, boolean>
  mergedCells?: MergedCellRange[]
  advancedFilter?: AdvancedFilterConfig
  univerSheetData?: unknown
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
  value: unknown
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
  row?: number
  col?: string
  value?: unknown
  changes?: CellUpdate[]
  afterRow?: number
  userId?: number
}

export interface Folder {
  id: number
  name: string
  parent_id: number | null
  owner_id: number
  created_at: string
  updated_at: string
}

export interface FolderContents {
  folders: Folder[]
  workbooks: Workbook[]
}

export interface AIChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AIConfigStatus {
  configured: boolean
  endpoint: string
  model: string
}
