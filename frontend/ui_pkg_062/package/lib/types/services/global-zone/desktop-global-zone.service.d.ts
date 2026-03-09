import { IDisposable } from '@univerjs/core';
import { ForwardRefExoticComponent } from 'react';
import { Subject } from 'rxjs';
import { ComponentManager } from '../../common/component-manager';
import { IGlobalZoneService } from './global-zone.service';
export declare class DesktopGlobalZoneService implements IGlobalZoneService {
    private readonly _componentManager;
    readonly visible$: Subject<boolean>;
    readonly componentKey$: Subject<string>;
    private _componentKey;
    constructor(_componentManager: ComponentManager);
    get componentKey(): string;
    set(key: string, component: ForwardRefExoticComponent<any>): IDisposable;
    open(): void;
    close(): void;
}
