import { UniverFormulaEnginePlugin as r } from "@univerjs/engine-formula";
import { UniverRPCWorkerThreadPlugin as e } from "@univerjs/rpc";
import { UniverSheetsPlugin as o } from "@univerjs/sheets";
import { UniverRemoteSheetsFormulaPlugin as i } from "@univerjs/sheets-formula";
function l() {
  return {
    plugins: [
      [o, { onlyRegisterFormulaRelatedMutations: !0 }],
      r,
      e,
      i
    ]
  };
}
export {
  l as UniverSheetsCoreWorkerPreset
};
