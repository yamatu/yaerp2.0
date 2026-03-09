import { UniverDocsPlugin as t } from "@univerjs/docs";
import { UniverDocsUIPlugin as m } from "@univerjs/docs-ui";
import { UniverFormulaEnginePlugin as u } from "@univerjs/engine-formula";
import { UniverRenderEnginePlugin as l } from "@univerjs/engine-render";
import { UniverRPCMainThreadPlugin as p } from "@univerjs/rpc";
import { UniverSheetsPlugin as U } from "@univerjs/sheets";
import { UniverSheetsFormulaPlugin as f } from "@univerjs/sheets-formula";
import { UniverSheetsFormulaUIPlugin as s } from "@univerjs/sheets-formula-ui";
import { UniverSheetsNumfmtPlugin as g } from "@univerjs/sheets-numfmt";
import { UniverSheetsNumfmtUIPlugin as P } from "@univerjs/sheets-numfmt-ui";
import { UniverSheetsUIPlugin as a } from "@univerjs/sheets-ui";
import { UniverUIPlugin as v } from "@univerjs/ui";
import "@univerjs/sheets/facade";
import "@univerjs/ui/facade";
import "@univerjs/docs-ui/facade";
import "@univerjs/sheets-ui/facade";
import "@univerjs/engine-formula/facade";
import "@univerjs/sheets-formula/facade";
import "@univerjs/sheets-numfmt/facade";
function b(i = {}) {
  const {
    container: o = "app",
    workerURL: e
  } = i, r = !!e;
  return {
    plugins: [
      t,
      l,
      [v, { container: o }],
      m,
      r ? [p, { workerURL: e }] : null,
      [u, { notExecuteFormula: r }],
      [U, { notExecuteFormula: r, onlyRegisterFormulaRelatedMutations: !1 }],
      a,
      g,
      P,
      f,
      s
    ].filter((n) => !!n)
  };
}
export {
  b as UniverSheetsCorePreset
};
