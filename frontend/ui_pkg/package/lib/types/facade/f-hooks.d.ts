import { IDisposable, FHooks } from '@univerjs/core';
export interface IFHooksSheetsUIMixin {
    /**
     * The onBeforeCopy event is fired before a copy operation is performed.
     * @param callback Callback function that will be called when the event is fired
     * @returns A disposable object that can be used to unsubscribe from the event
     */
    onBeforeCopy(callback: () => void): IDisposable;
    /**
     * The onBeforeCopy event is fired before a copy operation is performed.
     * @param callback Callback function that will be called when the event is fired
     * @returns A disposable object that can be used to unsubscribe from the event
     */
    onBeforePaste(callback: () => void): IDisposable;
    /**
     * The onCopy event is fired after a copy operation is performed.
     * @param callback Callback function that will be called when the event is fired
     * @returns A disposable object that can be used to unsubscribe from the event
     */
    onCopy(callback: () => void): IDisposable;
    /**
     * The onBeforePaste event is fired before a paste operation is performed.
     * @param callback Callback function that will be called when the event is fired
     * @returns A disposable object that can be used to unsubscribe from the event
     */
    onBeforePaste(callback: () => void): IDisposable;
    /**
     * The onPaste event is fired after a paste operation is performed.
     * @param callback Callback function that will be called when the event is fired
     * @returns A disposable object that can be used to unsubscribe from the event
     */
    onPaste(callback: () => void): IDisposable;
}
export declare class FHooksSheetsMixin extends FHooks implements IFHooksSheetsUIMixin {
    onBeforeCopy(callback: () => void): IDisposable;
    onCopy(callback: () => void): IDisposable;
    onBeforePaste(callback: () => void): IDisposable;
    onPaste(callback: () => void): IDisposable;
}
declare module '@univerjs/core' {
    interface FHooks extends IFHooksSheetsUIMixin {
    }
}
