import { Placement } from 'rc-notification/es/interface';
import { Subject } from 'rxjs';
export type NotificationType = 'success' | 'info' | 'warning' | 'error';
export interface INotificationOptions {
    /**
     * Key of the notification.
     */
    key?: string;
    /**
     * Component type, optional success, warning, error
     */
    type: NotificationType;
    /**
     * The title text of the notification
     */
    title: string;
    /**
     * The content text of the notification
     */
    content: string;
    /**
     * Popup position
     */
    placement?: Placement;
    /**
     * Automatic close time
     */
    duration?: number;
    /**
     * Whether to support closing
     */
    closable?: boolean;
    /**
     * The number of lines of content text. Ellipses will be displayed beyond the line number.
     */
    lines?: number;
}
export declare const notificationObserver: Subject<INotificationOptions>;
export declare const PureContent: (props: INotificationOptions) => import("react/jsx-runtime").JSX.Element;
export declare function Notification(): import("react/jsx-runtime").JSX.Element | null;
export declare const notification: {
    show: (options: INotificationOptions) => void;
};
