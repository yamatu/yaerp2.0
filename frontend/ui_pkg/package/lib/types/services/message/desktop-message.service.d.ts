import { IDisposable } from '@univerjs/core';
import { IMessageOptions, IMessageProps, Message } from '@univerjs/design';
import { IMessageService } from './message.service';
export declare class DesktopMessageService implements IMessageService, IDisposable {
    protected _portalContainer: HTMLElement | undefined;
    protected _message?: Message;
    dispose(): void;
    setContainer(container: HTMLElement): void;
    getContainer(): HTMLElement | undefined;
    show(options: IMessageOptions & Omit<IMessageProps, 'key'>): IDisposable;
}
