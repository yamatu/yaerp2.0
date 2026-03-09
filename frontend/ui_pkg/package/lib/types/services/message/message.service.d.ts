import { IDisposable } from '@univerjs/core';
import { IMessageOptions } from '@univerjs/design';
export declare const IMessageService: import('@wendellhu/redi').IdentifierDecorator<IMessageService>;
export interface IMessageService {
    show(options: IMessageOptions): IDisposable;
    setContainer(container: HTMLElement): void;
    getContainer(): HTMLElement | undefined;
}
