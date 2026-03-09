import { ICustomComponentProps } from '../../services/menu/menu';
export interface IFontFamilyProps extends ICustomComponentProps<string> {
    value: string;
}
export interface IFontFamilyItemProps extends ICustomComponentProps<string> {
    value: string;
}
export declare const FONT_FAMILY_LIST: {
    value: string;
}[];
