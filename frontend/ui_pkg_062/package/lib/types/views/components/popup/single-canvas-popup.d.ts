import { IPopup } from '../../../services/popup/canvas-popup.service';
import { default as React } from 'react';
interface ISingleCanvasPopupProps {
    popup: IPopup;
    children?: React.ReactNode;
}
declare const SingleCanvasPopup: ({ popup, children }: ISingleCanvasPopupProps) => import("react/jsx-runtime").JSX.Element | null;
export type { ISingleCanvasPopupProps };
export { SingleCanvasPopup };
