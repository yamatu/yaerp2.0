import { IUniverUIConfig } from '../config.schema';
import { Disposable, Injector, IUniverInstanceService, LifecycleService } from '@univerjs/core';
import { IRenderManagerService } from '@univerjs/engine-render';
import { ILayoutService } from '../../services/layout/layout.service';
import { IMenuManagerService } from '../../services/menu/menu-manager.service';
import { IUIPartsService } from '../../services/parts/parts.service';
export declare class DesktopUIController extends Disposable {
    private readonly _config;
    private readonly _renderManagerService;
    private readonly _instanceSrv;
    private readonly _injector;
    private readonly _lifecycleService;
    private readonly _uiPartsService;
    private readonly _menuManagerService;
    private readonly _layoutService?;
    private _steadyTimeout;
    private _renderTimeout;
    constructor(_config: IUniverUIConfig, _renderManagerService: IRenderManagerService, _instanceSrv: IUniverInstanceService, _injector: Injector, _lifecycleService: LifecycleService, _uiPartsService: IUIPartsService, _menuManagerService: IMenuManagerService, _layoutService?: ILayoutService | undefined);
    private _initMenus;
    private _bootstrapWorkbench;
    private _initBuiltinComponents;
}
