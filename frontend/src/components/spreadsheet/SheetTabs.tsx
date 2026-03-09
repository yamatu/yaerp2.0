'use client'

import type { Sheet } from '@/types'

interface Props {
  sheets: Sheet[]
  activeSheetId: number
  onSheetChange: (sheetId: number) => void
  onAddSheet: () => void
}

export default function SheetTabs({ sheets, activeSheetId, onSheetChange, onAddSheet }: Props) {
  return (
    <div className="flex items-center border-t border-border bg-secondary/30 px-2">
      {sheets.map((sheet) => (
        <button
          key={sheet.id}
          onClick={() => onSheetChange(sheet.id)}
          className={`px-4 py-2 text-sm border-t-2 transition-colors ${
            sheet.id === activeSheetId
              ? 'border-primary bg-white text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-white/50'
          }`}
        >
          {sheet.name}
        </button>
      ))}
      <button
        onClick={onAddSheet}
        className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-white/50"
        title="添加工作表"
      >
        +
      </button>
    </div>
  )
}
