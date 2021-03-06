import "fs";
import * as cp from "child_process";
import * as vscode from "vscode";
import * as path from "path";

import { COMMAND } from "./constants";
import { Trigger } from "./trigger";
import { fileServer } from "./fileserver";

import {
  getBinPath,
  getBinPathWithExplanation,
  getWorkspaceFolderPath,
  suggestDownloadGo,
  toolExecutionEnvironment,
  getReceiverName,
} from "./util";
import { multiStepInput } from "./multiStepInput";
import { readFileSync } from "fs";

interface IPickItem extends vscode.QuickPickItem {
  goImterface: fileServer.IInterface;
}

export function activate(context: vscode.ExtensionContext) {
  init();

  // trigger tips
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "go" },
      new Trigger(),
      {
        providedCodeActionKinds: Trigger.providedCodeActionKinds,
      }
    )
  );

  // implement command
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, async () => {
      fileServer.init();
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const document = editor.document;
      const range = editor.selection;

      if (!fileServer.isAtStartOfType(document, range)) {
        return;
      }
      vscode.workspace.workspaceFolders?.forEach((value) => {
        const fsPath = value.uri.fsPath;
        const gomodule = readFileSync(fsPath + "/go.mod");
        const gomoduleText = gomodule.toString();
        if (!gomoduleText) {
          return;
        }
        const lines = gomoduleText.split("\n");
        const firstLine = lines[0];
        const moduleName = firstLine.split(" ")[1];
        const basename = path.basename(fsPath);
        fileServer.viaDir(fsPath).forEach((url) => {
          const modulePath = url.split(basename)[1];
          const index = modulePath.lastIndexOf("/");
          const realPath = moduleName + modulePath.substring(0, index);

          fileServer.extractInterface({
            url,
            gopath: false,
            relativeInterfacePath: realPath,
          });
        });
      });

      const interfaceList = fileServer.getInterfaceList();
      const pickItemList: IPickItem[] = interfaceList.map<IPickItem>(
        (value) => {
          return {
            label: value.interfaceName,
            detail: "in " + value.path,
            goImterface: value,
          };
        }
      );

      const implementTypeStartLine = range.start.line;
      const implementTypeCurline = document.lineAt(implementTypeStartLine);
      const implementTypeCurlineText = fileServer
        .removeComment(implementTypeCurline.text)
        .trim();
      const match = implementTypeCurlineText.match(
        /(?<=type\s*)(\w+)\s(?!interface)/g
      );
      let receiver: string | null = "";
      let implementTypeName = "";
      if (match) {
        implementTypeName = match[0].trim();
        receiver = getReceiverName(
          implementTypeName,
          fileServer.removeComment(document.getText())
        );
      }
      const nextStep = receiver === null;
      const state = await multiStepInput(context, pickItemList, nextStep);
      if (nextStep) {
        receiver = state.receiverNamePair + implementTypeName;
      }
      const chiosInterface = state.resourceInterfaces;
      let implementInterface = chiosInterface.goImterface.fullInterfaceName;
      if (!chiosInterface.goImterface.gopath) {
        implementInterface =
          chiosInterface.goImterface.relativeInterfacePath +
          "." +
          chiosInterface.goImterface.interfaceName;
      }

      const text = document.getText();
      const arr = text.split("\n");

      let implementPosition: vscode.Position;
      if (implementTypeCurlineText.endsWith("{}")) {
        // type xxx struct{}
        implementPosition = new vscode.Position(implementTypeStartLine + 1, 0);
      } else if (!implementTypeCurlineText.endsWith("{")) {
        // type xxx int|string|boolean|...
        implementPosition = new vscode.Position(implementTypeStartLine + 1, 0);
      } else {
        // type xxx struct {
        //     xxx xxxxx
        //}
        arr.splice(0, implementTypeStartLine);
        for (let index = 0; index < arr.length; index++) {
          if (arr[index].startsWith("}")) {
            implementPosition = new vscode.Position(
              implementTypeStartLine + index + 1,
              0
            );
            break;
          }
        }
      }
      const args = [`${receiver}`, `${implementInterface}`];
      const goimpl = getBinPath("impl");
      const p = cp.execFile(
        goimpl,
        args,
        {
          env: toolExecutionEnvironment(document.uri),
          cwd: path.dirname(document.fileName),
        },
        async (err, stdout, stderr) => {
          if (err && (<any>err).code === "ENOENT") {
            return;
          }

          if (err) {
            console.error(err);
            vscode.window.showInformationMessage(
              `Cannot stub interface: ${stderr}`
            );
            return;
          }
          const res = await editor.edit((editBuilder) => {
            editBuilder.insert(implementPosition, "\n" + stdout);
          });
          if (res) {
            await document.save();
          }
        }
      );
      if (p.pid) {
        p.stdin?.end();
      }
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}

function init() {
  if (!process.env["GOROOT"] || !process.env["GOPATH"]) {
    const { binPath } = getBinPathWithExplanation("go", false);
    const goRuntimePath = binPath;

    if (!goRuntimePath || !path.isAbsolute(goRuntimePath)) {
      // getBinPath returns the absolute path to the tool if it exists.
      // Otherwise, it may return the tool name (e.g. 'go').
      suggestDownloadGo();
      return;
    }
    const p = cp.execFile(
      goRuntimePath,
      // -json is supported since go1.9
      ["env", "-json", "GOPATH", "GOROOT", "GOPROXY", "GOBIN", "GOMODCACHE"],
      { env: toolExecutionEnvironment(), cwd: getWorkspaceFolderPath() },
      (err, stdout, stderr) => {
        if (err || stderr) {
          vscode.window.showErrorMessage(
            `Failed to run '${goRuntimePath} env. The config change may not be applied correctly.`
          );
          return;
        }
        const envOutput = JSON.parse(stdout);
        for (const envName in envOutput) {
          if (
            !process.env[envName] &&
            envOutput[envName] &&
            envOutput[envName].trim()
          ) {
            process.env[envName] = envOutput[envName].trim();
          }
        }
        const goroot = process.env["GOROOT"]?.toString() + "/src";
        fileServer.clear();
        fileServer.viaDir(goroot).forEach((url) => {
          fileServer.extractInterface({
            url,
            gopath: true,
          });
        });
      }
    );
    if (p.pid) {
      p.stdin?.end();
    }
  }
}
