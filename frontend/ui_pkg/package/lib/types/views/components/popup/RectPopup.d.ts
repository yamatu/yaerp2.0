import { Nullable } from '@univerjs/core';
import { RefObject, default as React } from 'react';
import { Observable } from 'rxjs';
interface IAbsolutePosition {
    left: number;
    right: number;
    top: number;
    bottom: number;
}
export interface IRectPopupProps {
    children?: React.ReactNode;
    /**
     * the anchor element bounding rect
     */
    anchorRect$: Observable<IAbsolutePosition>;
    excludeRects?: RefObject<Nullable<IAbsolutePosition[]>>;
    direction?: 'vertical' | 'horizontal' | 'left' | 'top' | 'right' | 'left' | 'bottom' | 'bottom-center' | 'top-center';
    hidden?: boolean;
    onClickOutside?: (e: MouseEvent) => void;
    excludeOutside?: HTMLElement[];
    onContextMenu?: () => void;
    onPointerEnter?: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave?: (e: React.PointerEvent<HTMLElement>) => void;
    onClick?: (e: React.MouseEvent<HTMLElement>) => void;
}
export interface IPopupLayoutInfo extends Pick<IRectPopupProps, 'direction'> {
    position: IAbsolutePosition;
    width: number;
    height: number;
    containerWidth: number;
    containerHeight: number;
}
declare function RectPopup(props: IRectPopupProps): React.JSX.Element;
declare namespace RectPopup {
    var calcPopupPosition: (layout: IPopupLayoutInfo) => {
        top: number;
        left: number;
    };
    var useContext: () => RefObject<IAbsolutePosition | undefined>;
}
export { RectPopup };
