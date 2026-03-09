import { Observable } from 'rxjs';
import { ICustomComponentProps } from '../../services/menu/menu';
export interface IFontSizeProps extends ICustomComponentProps<string> {
    value: string;
    min: number;
    max: number;
    onChange: (value: string) => void;
    disabled$?: Observable<boolean>;
}
export declare const FONT_SIZE_LIST: {
    label: string;
    value: number;
}[];
