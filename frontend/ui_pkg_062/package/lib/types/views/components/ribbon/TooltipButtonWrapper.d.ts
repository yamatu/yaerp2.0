import { ITooltipProps } from '@univerjs/design';
import { ReactNode } from 'react';
import { IValueOption } from '../../../services/menu/menu';
export interface ITooltipWrapperRef {
    el: HTMLSpanElement | null;
}
export declare const TooltipWrapper: import('react').ForwardRefExoticComponent<ITooltipProps & import('react').RefAttributes<ITooltipWrapperRef>>;
export declare function DropdownWrapper({ children, overlay, disabled }: {
    children: ReactNode;
    overlay: ReactNode;
    disabled?: boolean;
}): import("react/jsx-runtime").JSX.Element;
export declare function DropdownMenuWrapper({ menuId, slot, value, options, children, disabled, onOptionSelect, }: {
    menuId: string;
    slot?: boolean;
    value?: string | number;
    options: IValueOption[];
    children: ReactNode;
    disabled?: boolean;
    onOptionSelect: (option: IValueOption) => void;
}): import("react/jsx-runtime").JSX.Element;
