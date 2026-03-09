import { IValueOption } from '../../../services/menu/menu';
import { default as React } from 'react';
export interface IBaseMenuProps {
    parentKey?: string | number;
    menuType?: string;
    value?: string | number;
    options?: IValueOption[];
    /**
     * The menu will show scroll on it over viewport height
     * Recommend that you use this prop when displaying menu overlays in Dropdown
     */
    overViewport?: 'scroll';
    onOptionSelect?: (option: IValueOption) => void;
}
export declare const Menu: (props: IBaseMenuProps) => React.JSX.Element;
