import { CSSProperties } from 'react';
import { ICustomLabelProps } from '../../../components/custom-label/CustomLabel';
export interface ISidebarMethodOptions {
    id?: string;
    header?: ICustomLabelProps;
    children?: ICustomLabelProps;
    bodyStyle?: CSSProperties;
    footer?: ICustomLabelProps;
    visible?: boolean;
    width?: number | string;
    onClose?: () => void;
    onOpen?: () => void;
}
