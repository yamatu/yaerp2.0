import { IUniverUIConfig } from './controllers/config.schema';
import { Injector, Plugin } from '@univerjs/core';
export declare const UNIVER_MOBILE_UI_PLUGIN_NAME = "UNIVER_MOBILE_UI_PLUGIN";
/**
 * @ignore
 */
export declare class UniverMobileUIPlugin extends Plugin {
    private readonly _config;
    protected readonly _injector: Injector;
    static pluginName: string;
    constructor(_config: IUniverUIConfig, _injector: Injector);
    onStarting(): void;
}
