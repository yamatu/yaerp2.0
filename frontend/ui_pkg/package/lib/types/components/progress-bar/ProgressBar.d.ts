import { default as React } from 'react';
export interface IProgressBarProps {
    progress: {
        done: number;
        count: number;
        label?: string;
    };
    barColor?: string;
    onTerminate?: () => void;
    onClearProgress?: () => void;
}
export declare function ProgressBar(props: IProgressBarProps): React.JSX.Element;
