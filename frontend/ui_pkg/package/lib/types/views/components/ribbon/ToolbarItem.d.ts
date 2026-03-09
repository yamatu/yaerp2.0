import { default as React } from 'react';
import { IDropdownProps } from '@univerjs/design';
import { IDisplayMenuItem, IMenuItem } from '../../../services/menu/menu';
export declare const ToolbarItem: React.ForwardRefExoticComponent<(IDisplayMenuItem<IMenuItem> & {
    align?: IDropdownProps["align"];
}) & React.RefAttributes<any>>;
