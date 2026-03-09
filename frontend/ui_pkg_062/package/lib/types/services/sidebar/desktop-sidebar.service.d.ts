import { IDisposable } from '@univerjs/core';
import { ISidebarMethodOptions } from '../../views/components/sidebar/interface';
import { ISidebarService } from './sidebar.service';
import { Subject } from 'rxjs';
export declare class DesktopSidebarService implements ISidebarService {
    private _sidebarOptions;
    readonly sidebarOptions$: Subject<ISidebarMethodOptions>;
    readonly scrollEvent$: Subject<Event>;
    private container?;
    get visible(): boolean;
    get options(): ISidebarMethodOptions;
    open(params: ISidebarMethodOptions): IDisposable;
    close(id?: string): void;
    getContainer(): HTMLElement | undefined;
    setContainer(element: HTMLElement): void;
}
