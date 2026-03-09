import { IWorkbenchOptions } from '../../controllers/ui/ui.controller';
import { default as React } from 'react';
export interface IUniverWorkbenchProps extends IWorkbenchOptions {
    mountContainer: HTMLElement;
    onRendered?: (containerElement: HTMLElement) => void;
}
export declare function DesktopWorkbench(props: IUniverWorkbenchProps): React.JSX.Element;
