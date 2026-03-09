import { IDisposable, Injector, IUniverInstanceService, LifecycleService } from '@univerjs/core';
import { IUniverUIConfig } from '../config.schema';
import { IRenderManagerService } from '@univerjs/engine-render';
import { ILayoutService } from '../../services/layout/layout.service';
import { IMenuManagerService } from '../../services/menu/menu-manager.service';
import { IUIPartsService } from '../../services/parts/parts.service';
import { SingleUnitUIController } from './ui-shared.controller';
export declare class DesktopUIController extends SingleUnitUIController {
    private readonly _config;
    constructor(_config: IUniverUIConfig, injector: Injector, lifecycleService: LifecycleService, renderManagerService: IRenderManagerService, layoutService: ILayoutService, instanceService: IUniverInstanceService, menuManagerService: IMenuManagerService, uiPartsService: IUIPartsService);
    bootstrap(callback: (contentElement: HTMLElement, containerElement: HTMLElement) => void): IDisposable;
    private _initBuiltinComponents;
}
