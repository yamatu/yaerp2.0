import { Disposable, IDisposable, Injector } from '@univerjs/core';
import { INotificationOptions } from '../../components/notification/Notification';
import { IUIPartsService } from '../parts/parts.service';
import { INotificationService } from './notification.service';
export declare class DesktopNotificationService extends Disposable implements INotificationService {
    private readonly _injector;
    private readonly _uiPartsService;
    constructor(_injector: Injector, _uiPartsService: IUIPartsService);
    show(params: INotificationOptions): IDisposable;
    protected _initUIPart(): void;
}
