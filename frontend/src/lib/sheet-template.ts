import type { ColumnDef } from '@/types'

export const DEFAULT_SHEET_COLUMNS: ColumnDef[] = [
  {
    key: 'item',
    name: '项目',
    type: 'text',
    width: 220,
  },
  {
    key: 'owner',
    name: '负责人',
    type: 'text',
    width: 160,
  },
  {
    key: 'country',
    name: '国家',
    type: 'text',
    width: 140,
  },
  {
    key: 'status',
    name: '状态',
    type: 'select',
    width: 140,
    options: ['待开始', '进行中', '已完成'],
  },
  {
    key: 'budget',
    name: '预算',
    type: 'currency',
    width: 150,
    currencyCode: 'CNY',
    currencySource: 'country',
  },
  {
    key: 'updated_at',
    name: '更新时间',
    type: 'date',
    width: 160,
  },
]
