import { FUniver as c, FHooks as d, ICommandService as i } from "@univerjs/core";
import { CopyCommand as r, PasteCommand as t, ISidebarService as a, IDialogService as s, ComponentManager as S } from "@univerjs/ui";
class v extends c {
  copy() {
    return this._commandService.executeCommand(r.id);
  }
  paste() {
    return this._commandService.executeCommand(t.id);
  }
  openSiderbar(e) {
    return this._injector.get(a).open(e);
  }
  openDialog(e) {
    const o = this._injector.get(s).open({
      ...e,
      onClose: () => {
        o.dispose();
      }
    });
    return o;
  }
  getComponentManager() {
    return this._injector.get(S);
  }
}
c.extend(v);
class p extends d {
  onBeforeCopy(e) {
    return this._injector.get(i).beforeCommandExecuted((o) => {
      o.id === r.id && e();
    });
  }
  onCopy(e) {
    return this._injector.get(i).onCommandExecuted((o) => {
      o.id === r.id && e();
    });
  }
  onBeforePaste(e) {
    return this._injector.get(i).beforeCommandExecuted((o) => {
      o.id === t.id && e();
    });
  }
  onPaste(e) {
    return this._injector.get(i).onCommandExecuted((o) => {
      o.id === t.id && e();
    });
  }
}
d.extend(p);
