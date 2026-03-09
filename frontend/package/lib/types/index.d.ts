import { IUniverRPCMainThreadConfig } from '@univerjs/rpc';
import { IUniverSheetsUIConfig } from '@univerjs/sheets-ui';
import { IUniverUIConfig } from '@univerjs/ui';
import { IPreset } from './types';
import '@univerjs/sheets/facade';
import '@univerjs/ui/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/sheets-ui/facade';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';
import '@univerjs/sheets-formula-ui/lib/index.css';
import '@univerjs/sheets-numfmt-ui/lib/index.css';
export interface IUniverSheetsCorePresetConfig extends Pick<IUniverUIConfig, 'container' | 'header' | 'footer' | 'toolbar' | 'menu' | 'contextMenu' | 'disableAutoFocus'>, Pick<IUniverSheetsUIConfig, 'formulaBar'> {
    workerURL: IUniverRPCMainThreadConfig['workerURL'];
}
/**
 * This presets helps you to create a Univer sheet with open sourced features.
 */
export declare function UniverSheetsCorePreset(config?: Partial<IUniverSheetsCorePresetConfig>): IPreset;
