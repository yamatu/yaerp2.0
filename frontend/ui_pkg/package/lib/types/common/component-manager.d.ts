import { IDisposable } from '@univerjs/core';
import { default as React } from 'react';
import { defineComponent } from 'vue';
type ComponentFramework = 'vue3' | 'react';
export interface IComponentOptions {
    framework?: ComponentFramework;
}
export interface IVue3Component {
    framework: 'vue3';
    component: ReturnType<typeof defineComponent>;
}
export interface IReactComponent {
    framework: 'react';
    component: React.ForwardRefExoticComponent<any>;
}
export type ComponentType = React.ForwardRefExoticComponent<any> | ReturnType<typeof defineComponent>;
export type ComponentList = Map<string, IVue3Component | IReactComponent>;
export declare class ComponentManager {
    private _components;
    private _componentsReverse;
    constructor();
    register(name: string, component: ComponentType, options?: IComponentOptions): IDisposable;
    getKey(component: ComponentType): string | undefined;
    get(name: string): React.ForwardRefExoticComponent<any> | ((props: any) => React.FunctionComponentElement<{
        component: ReturnType<typeof defineComponent>;
        props: Record<string, any>;
    }>) | undefined;
    delete(name: string): void;
}
export declare function VueComponentWrapper(options: {
    component: ReturnType<typeof defineComponent>;
    props: Record<string, any>;
}): React.DetailedReactHTMLElement<React.HTMLAttributes<HTMLElement>, HTMLElement>;
export {};
