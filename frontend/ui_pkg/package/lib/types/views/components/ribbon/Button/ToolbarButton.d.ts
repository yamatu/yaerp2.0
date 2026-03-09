import { default as React } from 'react';
export interface IBaseToolbarButtonProps {
    children?: React.ReactNode;
    /** Semantic DOM class */
    className?: string;
    /** Semantic DOM style */
    style?: React.CSSProperties;
    /**
     * Disabled state of button
     * @default false
     */
    disabled?: boolean;
    /** Set the handler to handle `click` event */
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onDoubleClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    /**
     * Set the button is activated
     * @default false
     */
    active?: boolean;
    onMouseEnter?: React.MouseEventHandler;
    onMouseLeave?: React.MouseEventHandler;
}
/**
 * Button Component
 */
export declare function ToolbarButton(props: IBaseToolbarButtonProps): React.JSX.Element;
