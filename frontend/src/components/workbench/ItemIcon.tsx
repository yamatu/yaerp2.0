import { FileSpreadsheet, FolderIcon, Sheet, Users } from "lucide-react";
import type { BrowserItem } from "./types";

const SIZES = {
  sm: { box: "h-8 w-8", icon: "h-4 w-4", folder: "h-7 w-7", badge: "h-3 w-3" },
  md: { box: "h-10 w-10", icon: "h-5 w-5", folder: "h-9 w-9", badge: "h-3.5 w-3.5" },
  lg: { box: "h-14 w-14", icon: "h-7 w-7", folder: "h-14 w-14", badge: "h-4 w-4" },
};

/** Folder / workbook glyph shared by every workbench view. */
export function ItemIcon({
  item,
  size = "md",
}: {
  item: Pick<BrowserItem, "kind" | "excelSource" | "shared">;
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  if (item.kind === "folder") {
    return (
      <span className={`relative flex ${s.box} shrink-0 items-center justify-center`}>
        <FolderIcon
          className={`${s.folder} ${
            item.shared ? "fill-sky-200 text-sky-500" : "fill-amber-300 text-amber-500"
          } drop-shadow-sm`}
          strokeWidth={1.5}
        />
        {item.shared && (
          <Users
            className={`absolute bottom-[18%] right-[14%] ${s.badge} rounded-sm bg-white p-px text-sky-600`}
          />
        )}
      </span>
    );
  }
  const Glyph = item.excelSource ? FileSpreadsheet : Sheet;
  return (
    <span
      className={`flex ${s.box} shrink-0 items-center justify-center rounded-lg border ${
        item.excelSource
          ? "border-emerald-200 bg-emerald-50 text-emerald-600"
          : "border-sky-200 bg-sky-50 text-sky-600"
      }`}
    >
      <Glyph className={s.icon} strokeWidth={1.75} />
    </span>
  );
}
