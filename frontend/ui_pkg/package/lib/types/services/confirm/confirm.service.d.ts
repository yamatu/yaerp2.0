import { IDisposable } from '@univerjs/core';
import { Subject } from 'rxjs';
import { IConfirmPartMethodOptions } from '../../views/components/confirm-part/interface';
export declare const IConfirmService: import('@wendellhu/redi').IdentifierDecorator<IConfirmService>;
export interface IConfirmService {
    readonly confirmOptions$: Subject<IConfirmPartMethodOptions[]>;
    open(params: IConfirmPartMethodOptions): IDisposable;
    confirm(params: IConfirmPartMethodOptions): Promise<boolean>;
    close(id: string): void;
}
