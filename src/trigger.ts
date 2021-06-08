import * as vscode from "vscode";

import { COMMAND } from "./constants";

import { fileServer } from "./fileserver";

export class Trigger implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    if (!fileServer.isAtStartOfType(document, range)) {
      return;
    }

    return [this.createCommand()];
  }

  private createCommand(): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "Implement interface",
      vscode.CodeActionKind.Empty
    );
    action.command = {
      command: COMMAND,
      title: "Implement interface",
      tooltip: "This will implement a interface.",
    };
    return action;
  }
}
