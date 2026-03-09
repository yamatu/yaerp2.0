import { Disposable, Injector, IUniverInstanceService, LifecycleService } from '@univerjs/core';
import { IRenderManagerService } from '@univerjs/engine-render';
import { ILayoutService } from '../../services/layout/layout.service';
import { IUIPartsService } from '../../services/parts/parts.service';
import { IUniverUIConfig } from '../config.schema';
import { IMenuManagerService } from '../../services/menu/menu-manager.service';
import { IUIController } from './ui.controller';
export declare class MobileUIController extends Disposable implements IUIController {
    private readonly _config;
    private readonly _instanceService;
    private readonly _renderManagerService;
    private readonly _injector;
    private readonly _lifecycleService;
    private readonly _uiPartsService;
    private readonly _menuManagerService;
    private readonly _layoutService?;
    constructor(_config: IUniverUIConfig, _instanceService: IUniverInstanceService, _renderManagerService: IRenderManagerService, _injector: Injector, _lifecycleService: LifecycleService, _uiPartsService: IUIPartsService, _menuManagerService: IMenuManagerService, _layoutService?: ILayoutService | undefined);
    private _initMenus;
    private _bootstrapWorkbench;
    private _initBuiltinComponents;
}
