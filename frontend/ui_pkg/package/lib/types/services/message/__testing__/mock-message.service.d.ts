import { IMessageOptions, IMessageProps } from '@univerjs/design';
import { IDisposable } from '@univerjs/core';
import { IMessageService } from '../message.service';
/**
 * This is a mocked message service for testing purposes.
 */
export declare class MockMessageService implements IMessageService {
    show(_options: IMessageOptions & Omit<IMessageProps, 'key'>): IDisposable;
    setContainer(): void;
    getContainer(): HTMLElement | undefined;
}
