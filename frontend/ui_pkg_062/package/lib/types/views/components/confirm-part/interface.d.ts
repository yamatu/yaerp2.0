import { IConfirmProps } from '@univerjs/design';
import { ICustomLabelProps } from '../../../components/custom-label/CustomLabel';
export type IConfirmPartMethodOptions = {
    id: string;
    children?: ICustomLabelProps;
    title?: ICustomLabelProps;
} & Omit<IConfirmProps, 'children' | 'title'>;
