import { IWorkbenchOptions } from '../controllers/ui/ui.controller';
import { default as React } from 'react';
export interface IUniverAppProps extends IWorkbenchOptions {
    mountContainer: HTMLElement;
    onRendered?: (container: HTMLElement) => void;
}
export declare function MobileApp(props: IUniverAppProps): React.JSX.Element;
