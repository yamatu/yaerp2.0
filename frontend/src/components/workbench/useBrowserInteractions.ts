"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { BrowserItem, MenuPoint } from "./types";

export interface BrowserDnd {
  dropTargetKey: string | null;
  draggingKeys: ReadonlySet<string>;
  onDragStart: (item: BrowserItem, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (
    event: ReactDragEvent<HTMLElement>,
    targetKey: string,
    canDrop: boolean,
  ) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>, targetKey: string) => void;
  onDrop: (
    event: ReactDragEvent<HTMLElement>,
    folderId: number,
    canDrop: boolean,
  ) => void;
}

export interface BrowserInteractionOptions {
  items: BrowserItem[];
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  /** Touch "select mode": taps toggle selection instead of opening. */
  selectMode: boolean;
  coarsePointer: boolean;
  onOpen: (item: BrowserItem) => void;
  /** Open the action menu; `selection` is the effective selection. */
  onMenu: (
    item: BrowserItem,
    point: MenuPoint,
    selection: string[],
    options?: { alignEnd?: boolean },
  ) => void;
  onRename: (item: BrowserItem) => void;
  onDelete: (items: BrowserItem[]) => void;
  dnd: BrowserDnd;
}

const LONG_PRESS_MS = 480;
const LONG_PRESS_TOLERANCE = 10;

/**
 * Shared selection / keyboard / long-press / context-menu / drag behaviour for
 * the workbench icon view and list view, so both expose the same operations.
 */
export function useBrowserInteractions({
  items,
  selectedKeys,
  onSelectionChange,
  selectMode,
  coarsePointer,
  onOpen,
  onMenu,
  onRename,
  onDelete,
  dnd,
}: BrowserInteractionOptions) {
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const anchorKeyRef = useRef<string | null>(null);
  const pointerTypeRef = useRef<string>("mouse");
  const longPressRef = useRef<{
    timer: number;
    x: number;
    y: number;
    key: string;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.key, index));
    return map;
  }, [items]);

  useEffect(() => {
    if (focusKey && !indexByKey.has(focusKey)) setFocusKey(null);
  }, [focusKey, indexByKey]);

  useEffect(
    () => () => {
      if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
    },
    [],
  );

  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) elementsRef.current.set(key, element);
    else elementsRef.current.delete(key);
  }, []);

  const rangeKeys = useCallback(
    (fromKey: string, toKey: string) => {
      const from = indexByKey.get(fromKey) ?? 0;
      const to = indexByKey.get(toKey) ?? 0;
      const [start, end] = from <= to ? [from, to] : [to, from];
      return items.slice(start, end + 1).map((item) => item.key);
    },
    [indexByKey, items],
  );

  const toggle = useCallback(
    (key: string) => {
      onSelectionChange(
        selectedSet.has(key)
          ? selectedKeys.filter((current) => current !== key)
          : [...selectedKeys, key],
      );
      anchorKeyRef.current = key;
    },
    [onSelectionChange, selectedKeys, selectedSet],
  );

  const openMenuFor = useCallback(
    (item: BrowserItem, point: MenuPoint, options?: { alignEnd?: boolean }) => {
      let selection = selectedKeys;
      if (!selectedSet.has(item.key)) {
        selection = selectMode ? [...selectedKeys, item.key] : [item.key];
        onSelectionChange(selection);
        anchorKeyRef.current = item.key;
      }
      setFocusKey(item.key);
      onMenu(item, point, selection, options);
    },
    [onMenu, onSelectionChange, selectMode, selectedKeys, selectedSet],
  );

  const cancelLongPress = () => {
    if (longPressRef.current) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    }
  };

  const focusItem = (key: string) => {
    setFocusKey(key);
    const element = elementsRef.current.get(key);
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  };

  /** Next item in a direction using on-screen geometry (works for grids and lists). */
  const neighbourKey = (fromKey: string, direction: "up" | "down") => {
    const from = elementsRef.current.get(fromKey);
    if (!from) return null;
    const fromRect = from.getBoundingClientRect();
    let bestRowTop: number | null = null;
    let best: { key: string; distance: number } | null = null;
    for (const item of items) {
      const element = elementsRef.current.get(item.key);
      if (!element || item.key === fromKey) continue;
      const rect = element.getBoundingClientRect();
      const isCandidate =
        direction === "down" ? rect.top > fromRect.top + 4 : rect.top < fromRect.top - 4;
      if (!isCandidate) continue;
      if (
        bestRowTop === null ||
        (direction === "down" ? rect.top < bestRowTop - 4 : rect.top > bestRowTop + 4)
      ) {
        bestRowTop = rect.top;
        best = null;
      }
      if (Math.abs(rect.top - bestRowTop) > 4) continue;
      const distance = Math.abs(rect.left - fromRect.left);
      if (!best || distance < best.distance) best = { key: item.key, distance };
    }
    return best?.key ?? null;
  };

  const handleContainerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (items.length === 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const currentKey = focusKey && indexByKey.has(focusKey) ? focusKey : items[0].key;
    const currentIndex = indexByKey.get(currentKey) ?? 0;
    const currentItem = items[currentIndex];
    const modifier = event.ctrlKey || event.metaKey;

    const moveTo = (nextKey: string | null) => {
      if (!nextKey) return;
      event.preventDefault();
      focusItem(nextKey);
      if (event.shiftKey) {
        const anchor = anchorKeyRef.current ?? currentKey;
        anchorKeyRef.current = anchor;
        onSelectionChange(rangeKeys(anchor, nextKey));
      } else if (!modifier && !selectMode) {
        onSelectionChange([nextKey]);
        anchorKeyRef.current = nextKey;
      }
    };

    switch (event.key) {
      case "ArrowRight":
        moveTo(items[Math.min(items.length - 1, currentIndex + 1)]?.key ?? null);
        return;
      case "ArrowLeft":
        moveTo(items[Math.max(0, currentIndex - 1)]?.key ?? null);
        return;
      case "ArrowDown":
        moveTo(neighbourKey(currentKey, "down"));
        return;
      case "ArrowUp":
        moveTo(neighbourKey(currentKey, "up"));
        return;
      case "Home":
        moveTo(items[0].key);
        return;
      case "End":
        moveTo(items[items.length - 1].key);
        return;
      case "Enter":
        event.preventDefault();
        onOpen(currentItem);
        return;
      case " ":
        event.preventDefault();
        if (modifier || selectMode) toggle(currentKey);
        else {
          onSelectionChange([currentKey]);
          anchorKeyRef.current = currentKey;
        }
        return;
      case "F2":
        event.preventDefault();
        onRename(currentItem);
        return;
      case "Delete":
      case "Backspace": {
        if (event.key === "Backspace" && !event.metaKey) return;
        event.preventDefault();
        const targets = selectedSet.has(currentKey)
          ? items.filter((item) => selectedSet.has(item.key))
          : [currentItem];
        onDelete(targets);
        return;
      }
      case "Escape":
        if (selectedKeys.length > 0) {
          event.preventDefault();
          onSelectionChange([]);
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) return;
        event.preventDefault();
        const element = elementsRef.current.get(currentKey);
        const rect = element?.getBoundingClientRect();
        openMenuFor(currentItem, {
          x: rect ? rect.left + Math.min(rect.width / 2, 48) : 0,
          y: rect ? rect.top + Math.min(rect.height / 2, 32) : 0,
        });
        return;
      }
      default:
        if ((event.key === "a" || event.key === "A") && modifier) {
          event.preventDefault();
          onSelectionChange(items.map((item) => item.key));
        }
    }
  };

  const getItemProps = (item: BrowserItem, index: number) => {
    const selected = selectedSet.has(item.key);
    const tabbable = focusKey ? focusKey === item.key : index === 0;
    const isFolder = item.kind === "folder";
    return {
      ref: (element: HTMLElement | null) => register(item.key, element),
      "data-item-key": item.key,
      role: "option" as const,
      "aria-selected": selected,
      "aria-label": `${item.typeLabel} ${item.name}`,
      tabIndex: tabbable ? 0 : -1,
      onFocus: () => setFocusKey(item.key),
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        const touch = pointerTypeRef.current !== "mouse";
        setFocusKey(item.key);
        if (event.shiftKey && anchorKeyRef.current) {
          const range = rangeKeys(anchorKeyRef.current, item.key);
          onSelectionChange(
            event.ctrlKey || event.metaKey
              ? Array.from(new Set([...selectedKeys, ...range]))
              : range,
          );
          return;
        }
        if (event.ctrlKey || event.metaKey || selectMode) {
          toggle(item.key);
          return;
        }
        if (touch) {
          onOpen(item);
          return;
        }
        onSelectionChange([item.key]);
        anchorKeyRef.current = item.key;
      },
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (pointerTypeRef.current !== "mouse") return;
        onOpen(item);
      },
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault();
        cancelLongPress();
        if (pointerTypeRef.current !== "mouse" && suppressClickRef.current) return;
        openMenuFor(item, { x: event.clientX, y: event.clientY });
      },
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        pointerTypeRef.current = event.pointerType || "mouse";
        suppressClickRef.current = false;
        if (event.pointerType === "mouse") return;
        cancelLongPress();
        const { clientX, clientY } = event;
        longPressRef.current = {
          key: item.key,
          x: clientX,
          y: clientY,
          timer: window.setTimeout(() => {
            longPressRef.current = null;
            suppressClickRef.current = true;
            navigator.vibrate?.(12);
            openMenuFor(item, { x: clientX, y: clientY });
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const press = longPressRef.current;
        if (!press) return;
        if (
          Math.abs(event.clientX - press.x) > LONG_PRESS_TOLERANCE ||
          Math.abs(event.clientY - press.y) > LONG_PRESS_TOLERANCE
        )
          cancelLongPress();
      },
      onPointerUp: cancelLongPress,
      onPointerCancel: cancelLongPress,
      draggable: item.canDrag && !coarsePointer,
      onDragStart: (event: ReactDragEvent<HTMLElement>) => {
        if (!item.canDrag) {
          event.preventDefault();
          return;
        }
        dnd.onDragStart(item, event);
      },
      onDragEnd: dnd.onDragEnd,
      onDragOver: isFolder
        ? (event: ReactDragEvent<HTMLElement>) => dnd.onDragOver(event, item.key, item.canDrop)
        : undefined,
      onDragLeave: isFolder
        ? (event: ReactDragEvent<HTMLElement>) => dnd.onDragLeave(event, item.key)
        : undefined,
      onDrop: isFolder
        ? (event: ReactDragEvent<HTMLElement>) => dnd.onDrop(event, item.id, item.canDrop)
        : undefined,
    };
  };

  /** Props for the "⋯" button inside an item. */
  const getMoreButtonProps = (item: BrowserItem) => ({
    type: "button" as const,
    "aria-label": `更多操作：${item.name}`,
    title: "更多操作",
    tabIndex: -1,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuFor(item, { x: rect.right, y: rect.bottom + 4 }, { alignEnd: true });
    },
  });

  /** Props for the selection checkbox inside an item. */
  const getCheckboxProps = (item: BrowserItem) => ({
    type: "button" as const,
    role: "checkbox" as const,
    "aria-checked": selectedSet.has(item.key),
    "aria-label": `选择 ${item.name}`,
    tabIndex: -1,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (event.shiftKey && anchorKeyRef.current) {
        onSelectionChange(
          Array.from(new Set([...selectedKeys, ...rangeKeys(anchorKeyRef.current, item.key)])),
        );
        return;
      }
      toggle(item.key);
    },
  });

  return {
    elementsRef,
    selectedSet,
    focusKey,
    setFocusKey,
    getItemProps,
    getMoreButtonProps,
    getCheckboxProps,
    containerProps: {
      role: "listbox" as const,
      "aria-multiselectable": true,
      onKeyDown: handleContainerKeyDown,
    },
  };
}
