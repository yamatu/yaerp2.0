import { IPopup } from '../../../services/popup/canvas-popup.service';
import { default as React } from 'react';
interface ISingleDOMPopupProps {
    popup: IPopup;
    children?: React.ReactNode;
}
/**
 * Align position is diff from SingleCanvasPopup
 */
declare const SingleDOMPopup: ({ popup, children }: ISingleDOMPopupProps) => import("react/jsx-runtime").JSX.Element | null;
export type { ISingleDOMPopupProps };
export { SingleDOMPopup };
