import * as vscode from "vscode";
import * as fs from "fs";

import * as path from "path";

import strip = require("strip-comments");

export namespace fileServer {
  export interface IInterface {
    packageName: string;
    path: string;
    interfaceName: string;
    fullInterfaceName: string;
    gopath: boolean;
    relativeInterfacePath?: string;
  }

  let interfaceList: IInterface[] = [];
  let gopathInterfaceList: IInterface[] = [];

  export function clear() {
    gopathInterfaceList = [];
    interfaceList = [];
  }

  export function init() {
    interfaceList = [];
  }

  export function getInterfaceByName(name: string): IInterface | undefined {
    return interfaceList.find(
      (value: IInterface) => value.interfaceName === name
    );
  }

  export function getInterfaceList(): IInterface[] {
    return [...interfaceList, ...gopathInterfaceList];
  }

  export function viaDir(url: string, list: string[] = []): string[] {
    const files = fs.readdirSync(url);
    files.forEach((value) => {
      const fullPath = path.join(url, value);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        viaDir(fullPath, list);
      } else if (
        stat.isFile() &&
        // TODO: bad code
        path.extname(fullPath) === ".go" &&
        fullPath.search("_test.go") === -1 &&
        fullPath.search("internal") === -1 &&
        fullPath.search("vendor") === -1 &&
        fullPath.search("issue") === -1 &&
        fullPath.search("testdata") === -1 &&
        fullPath.search("main.go") === -1 &&
        fullPath.search("cmd") === -1
      ) {
        list.push(fullPath);
      }
    });

    return list;
  }

  export interface GOProjectInfo {
    url: string;
    gopath: boolean;
    relativeInterfacePath?: string;
  }

  export function extractInterface(info: GOProjectInfo) {
    const url = info.url;
    const file = removeComment(readFile(url));
    if (!file) {
      return;
    }

    const mathes = file.match(/type\s*(\w+)\s*interface\s*{([^}]*)\s*}/g);
    if (mathes && mathes.length) {
      const packageName = extractPackageName(file);

      mathes.forEach((matchInterface) => {
        const iface: IInterface = {
          packageName: packageName,
          path: url,
          interfaceName: "",
          fullInterfaceName: packageName !== "builtin" ? packageName + "." : "",
          gopath: false,
        };

        const matchInterfaceName = matchInterface.match(
          /(?<=type\s*).*(?=\s*interface)/g
        );
        if (matchInterfaceName) {
          const interfaceName = matchInterfaceName[0].trim();
          // A-Z ASCII 65-90
          if (
            (interfaceName.charCodeAt(0) < 65 ||
              interfaceName.charCodeAt(0) > 90) &&
            packageName !== "builtin"
          ) {
            return;
          }
          iface.interfaceName = interfaceName;
          iface.fullInterfaceName += interfaceName;
        }

        if (info.gopath) {
          iface.gopath = true;
          gopathInterfaceList.push(iface);
        } else {
          iface.gopath = false;
          interfaceList.push(iface);
          iface.relativeInterfacePath = info.relativeInterfacePath;
        }
      });
    }
  }

  export function isAtStartOfType(
    document: vscode.TextDocument,
    range: vscode.Range
  ) {
    const line = document.lineAt(range.start.line);
    const match = line.text.match(/(?<=type\s*)(\w+)\s(?!interface)/g);
    return match ? true : false;
  }

  export function extractPackageName(text: string): string {
    const line = text
      .split("\n")
      .find((value) => value.startsWith("package") === true);
    const match = line?.match(/(?<=package\s*)(\w+)/g);
    if (match) {
      return match[0].trim();
    }
    return "";
  }

  export function extractModuleName(url: string): string {
    const text = readFile(url);
    if (!text) {
      return "";
    }
    const match = text.match(/(?<=module\s*)(\w+)/g);
    if (match) {
      return match[0].trim();
    }
    return "";
  }

  function readFile(url: string): string {
    if (!fs.existsSync(url)) {
      return "";
    }

    return fs.readFileSync(url, "utf-8");
  }

  export function removeComment(text: string): string {
    return strip(text);
  }
}
