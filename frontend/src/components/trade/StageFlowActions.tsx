"use client";

import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  ClipboardCheck,
  Loader2,
  RotateCcw,
} from "lucide-react";

interface StageFlowActionsProps {
  positionName: string;
  blockers: string[];
  note: string;
  flowing: boolean;
  returnLabel?: string;
  advanceLabel?: string;
  showRework: boolean;
  onNoteChange: (value: string) => void;
  onReturn?: () => void;
  onAdvance?: () => void;
  onRework: () => void;
}

export function StageFlowActions({
  positionName,
  blockers,
  note,
  flowing,
  returnLabel,
  advanceLabel,
  showRework,
  onNoteChange,
  onReturn,
  onAdvance,
  onRework,
}: StageFlowActionsProps) {
  return (
    <section className="mt-6 rounded-lg border border-sky-200 bg-sky-50/50 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">本环节交接</div>
          <p className="mt-0.5 text-xs text-slate-500">
            当前由“{positionName || "业务负责人"}”处理，交接后将通知下一职位。
          </p>
        </div>
        <BellRing className="h-5 w-5 shrink-0 text-sky-600" />
      </div>

      {blockers.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            <ClipboardCheck className="h-4 w-4" />
            推进前还需完成
          </div>
          <ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-700">
            {blockers.map((blocker) => (
              <li key={blocker}>· {blocker}</li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        className="mt-3 min-h-20 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
        placeholder="交接说明、退回原因或下一环节注意事项（可选）"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {onReturn && returnLabel && (
            <button
              type="button"
              onClick={onReturn}
              disabled={flowing}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-amber-200 bg-white px-4 text-sm font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-40"
            >
              {flowing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowLeft className="h-4 w-4" />
              )}
              退回{returnLabel}
            </button>
          )}
          {showRework && (
            <button
              type="button"
              onClick={onRework}
              disabled={flowing}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40"
            >
              <RotateCcw className="h-4 w-4" />
              采购/发货异常
            </button>
          )}
        </div>
        {onAdvance && advanceLabel && (
          <button
            type="button"
            onClick={onAdvance}
            disabled={flowing || blockers.length > 0}
            title={blockers.length > 0 ? "请先完成本环节必填资料" : "推进到下一业务环节"}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
          >
            {flowing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            推进到{advanceLabel}
          </button>
        )}
      </div>
    </section>
  );
}
