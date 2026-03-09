import { ComponentType, default as React } from 'react';
import { Injector } from '@univerjs/core';
export interface IComponentContainerProps {
    components?: Set<ComponentType>;
    fallback?: React.ReactNode;
    sharedProps?: Record<string, unknown>;
}
export declare function ComponentContainer(props: IComponentContainerProps): string | number | boolean | React.ReactElement<any, string | React.JSXElementConstructor<any>> | Iterable<React.ReactNode> | null;
/**
 * Get a set of render functions to render components of a part.
 *
 * @param part The part name.
 * @param injector The injector to get the service. It is optional. However, you should not change this prop in a given
 * component.
 */
export declare function useComponentsOfPart(part: string, injector?: Injector): Set<() => import('../..').ComponentType>;
