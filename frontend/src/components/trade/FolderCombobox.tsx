"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Folder, Search } from "lucide-react";
import type { FolderOption } from "@/types";

interface FolderComboboxProps {
  folders: FolderOption[];
  value?: number;
  onChange: (folderID?: number) => void;
}

export function FolderCombobox({
  folders,
  value,
  onChange,
}: FolderComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = folders.find((folder) => folder.id === value);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return folders;
    return folders.filter((folder) =>
      folder.path.toLocaleLowerCase().includes(keyword),
    );
  }, [folders, query]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-sm hover:border-slate-300"
      >
        <Folder className="h-4 w-4 shrink-0 text-sky-600" />
        <span className="min-w-0 flex-1 truncate text-slate-700">
          {selected?.path || "工作台根目录"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-[140] mt-1 w-full min-w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <label className="flex h-10 items-center gap-2 border-b border-slate-200 px-3 text-slate-400">
            <Search className="h-4 w-4" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件夹路径"
              className="min-w-0 flex-1 text-sm text-slate-800 outline-none"
            />
          </label>
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
            >
              <Folder className="h-4 w-4 text-slate-400" />
              <span className="flex-1">工作台根目录</span>
              {!value && <Check className="h-4 w-4 text-emerald-600" />}
            </button>
            {filtered.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => {
                  onChange(folder.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50"
              >
                <Folder className="h-4 w-4 shrink-0 text-sky-600" />
                <span className="min-w-0 flex-1 truncate">{folder.path}</span>
                {folder.id === value && (
                  <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
