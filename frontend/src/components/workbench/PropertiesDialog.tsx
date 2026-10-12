"use client";

import type { ReactNode } from "react";
import { ItemIcon } from "./ItemIcon";
import { ResponsiveDialog, dialogPrimaryButton, dialogSecondaryButton } from "./ResponsiveDialog";
import type { BrowserItem } from "./types";

export interface PropertyRow {
  label: string;
  value: ReactNode;
}

interface PropertiesDialogProps {
  item: BrowserItem | null;
  rows: PropertyRow[];
  onClose: () => void;
  onOpen: (item: BrowserItem) => void;
}

export function PropertiesDialog({ item, rows, onClose, onOpen }: PropertiesDialogProps) {
  return (
    <ResponsiveDialog
      open={Boolean(item)}
      onClose={onClose}
      title={item?.name || "属性"}
      description={item ? `${item.typeLabel}属性` : undefined}
      icon={item ? <ItemIcon item={item} size="sm" /> : undefined}
      footer={
        item && (
          <>
            <button type="button" onClick={onClose} className={dialogSecondaryButton}>
              关闭
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpen(item);
              }}
              className={dialogPrimaryButton}
            >
              打开
            </button>
          </>
        )
      }
    >
      <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 px-3 py-2.5 text-sm">
            <dt className="text-slate-500">{row.label}</dt>
            <dd className="min-w-0 break-words text-slate-800">{row.value}</dd>
          </div>
        ))}
      </dl>
    </ResponsiveDialog>
  );
}
