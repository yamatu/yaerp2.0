import { IDisposable, FUniver } from '@univerjs/core';
import { IDialogPartMethodOptions, ISidebarMethodOptions, ComponentManager } from '@univerjs/ui';
export interface IFUniverUIMixin {
    copy(): Promise<boolean>;
    paste(): Promise<boolean>;
    /**
     * Open a sidebar.
     * @param params the sidebar options
     * @returns the disposable object
     */
    openSiderbar(params: ISidebarMethodOptions): IDisposable;
    /**
     * Open a dialog.
     * @param dialog the dialog options
     * @returns the disposable object
     */
    openDialog(dialog: IDialogPartMethodOptions): IDisposable;
    /**
     * Get the component manager
     * @returns The component manager
     */
    getComponentManager(): ComponentManager;
}
export declare class FUniverUIMixin extends FUniver implements IFUniverUIMixin {
    copy(): Promise<boolean>;
    paste(): Promise<boolean>;
    openSiderbar(params: ISidebarMethodOptions): IDisposable;
    openDialog(dialog: IDialogPartMethodOptions): IDisposable;
    getComponentManager(): ComponentManager;
}
declare module '@univerjs/core' {
    interface FUniver extends IFUniverUIMixin {
    }
}
