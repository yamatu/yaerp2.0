import { IDisposable, Disposable } from '@univerjs/core';
import { ComponentType } from '../../common/component-manager';
import { Observable } from 'rxjs';
type ComponentRenderer = () => ComponentType;
type ComponentPartKey = BuiltInUIPart | string;
export declare enum BuiltInUIPart {
    GLOBAL = "global",
    HEADER = "header",
    HEADER_MENU = "header-menu",
    CONTENT = "content",
    FOOTER = "footer",
    LEFT_SIDEBAR = "left-sidebar",
    FLOATING = "floating",
    UNIT = "unit"
}
export interface IUIPartsService {
    componentRegistered$: Observable<ComponentPartKey>;
    registerComponent(part: ComponentPartKey, componentFactory: () => ComponentType): IDisposable;
    getComponents(part: ComponentPartKey): Set<ComponentRenderer>;
}
export declare const IUIPartsService: import('@wendellhu/redi').IdentifierDecorator<IUIPartsService>;
export declare class UIPartsService extends Disposable implements IUIPartsService {
    private _componentsByPart;
    private readonly _componentRegistered$;
    readonly componentRegistered$: Observable<string>;
    dispose(): void;
    registerComponent(part: ComponentPartKey, componentFactory: () => React.ComponentType): IDisposable;
    getComponents(part: ComponentPartKey): Set<ComponentType>;
}
export {};
