import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  envPath,
  fixDriveCasingInWindows,
  getBinPathWithPreferredGopathGorootWithExplanation,
  getCurrentGoRoot,
  getInferredGopath,
  resolveHomeDir,
} from "./utils/pathUtils";

const SECURITY_SENSITIVE_CONFIG: string[] = [
  "alternateTools",
  "gopath",
  "goroot",
  "inferGopath",
  "toolsGopath",
  "toolsEnvVars",
];

// wrappedConfiguration wraps vscode.WorkspaceConfiguration.
class WrappedConfiguration implements vscode.WorkspaceConfiguration {
  constructor(private readonly _wrapped: vscode.WorkspaceConfiguration) {
    // set getters for direct setting access (e.g. cfg.gopath), but don't overwrite _wrapped.
    const desc = Object.getOwnPropertyDescriptors(_wrapped);
    for (const prop in desc) {
      // TODO(hyangah): find a better way to exclude WrappedConfiguration's members.
      // These methods are defined by WrappedConfiguration.
      if (
        typeof prop === "string" &&
        !["get", "has", "inspect", "update", "_wrapped"].includes(prop)
      ) {
        const d = desc[prop];
        if (SECURITY_SENSITIVE_CONFIG.includes(prop)) {
          const inspect = this._wrapped.inspect(prop);
          if (inspect) {
            d.value = inspect.globalValue ?? inspect.defaultValue;
          }
        }
        Object.defineProperty(this, prop, desc[prop]);
      }
    }
  }

  public get(section: any, defaultValue?: any) {
    if (SECURITY_SENSITIVE_CONFIG.includes(section)) {
      const inspect = this._wrapped.inspect(section);
      if (inspect) {
        return inspect.globalValue ?? defaultValue ?? inspect.defaultValue;
      }
    }
    return this._wrapped.get(section, defaultValue);
  }
  public has(section: string) {
    return this._wrapped.has(section);
  }
  public inspect<T>(section: string) {
    return this._wrapped.inspect<T>(section);
  }
  public update(
    section: string,
    value: any,
    configurationTarget?: boolean | vscode.ConfigurationTarget,
    overrideInLanguage?: boolean
  ): Thenable<void> {
    return this._wrapped.update(
      section,
      value,
      configurationTarget,
      overrideInLanguage
    );
  }
}

// Go extension configuration for a workspace.
export class Configuration {
  constructor(
    private _workspaceIsTrusted = false,
    private getConfiguration = vscode.workspace.getConfiguration
  ) {}

  public toggleWorkspaceIsTrusted() {
    this._workspaceIsTrusted = !this._workspaceIsTrusted;
    return this._workspaceIsTrusted;
  }

  // returns a Proxied vscode.WorkspaceConfiguration, which prevents
  // from using the workspace configuration if the workspace is untrusted.
  public get(section: string, uri?: vscode.Uri): vscode.WorkspaceConfiguration {
    const cfg = this.getConfiguration(section, uri);
    if (section !== "go" || this._workspaceIsTrusted) {
      return cfg;
    }
    return new WrappedConfiguration(cfg);
  }

  public workspaceIsTrusted(): boolean {
    return this._workspaceIsTrusted;
  }
}

class VSCodeConfiguration {
  public toggleWorkspaceIsTrusted() {
    /* no-op */
  }
  public get(section: string, uri?: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(section, uri);
  }
  public workspaceIsTrusted(): boolean {
    return !!(vscode.workspace as any).isTrusted;
  }
}

// Set true only if the vscode is the recent version that has the workspace trust API AND
// if the security.workspace.trust is enabled. Change of this configuration requires restart
// of VSCode, so we don't need to set up the configuration change listener.
// TODO(hyangah): remove this and Configuration & WrappedConfiguration when we update
// our extension to require 2021 June VSCode engine.
const isVscodeWorkspaceTrustAPIAvailable =
  "boolean" === typeof (vscode.workspace as any).isTrusted &&
  vscode.workspace
    .getConfiguration("security.workspace.trust")
    ?.get("enabled") === true;

const defaultConfig = isVscodeWorkspaceTrustAPIAvailable
  ? new VSCodeConfiguration()
  : new Configuration();

function getConfig(section: string, uri?: vscode.Uri) {
  if (!uri) {
    if (vscode.window.activeTextEditor) {
      uri = vscode.window.activeTextEditor.document.uri;
    } else {
      uri = null as any;
    }
  }
  return defaultConfig.get(section, uri);
}

// getGoConfig is declared as an exported const rather than a function, so it can be stubbbed in testing.
export const getGoConfig = (uri?: vscode.Uri) => {
  return getConfig("go", uri);
};

// getBinPath returns the path to the tool.
export function getBinPath(tool: string, useCache = true): string {
  const r = getBinPathWithExplanation(tool, useCache);
  return r.binPath;
}

// getBinPathWithExplanation returns the path to the tool, and the explanation on why
// the path was chosen. See getBinPathWithPreferredGopathGorootWithExplanation for details.
export function getBinPathWithExplanation(
  tool: string,
  useCache = true
): { binPath: string; why?: string } {
  const cfg = getGoConfig();
  const alternateTools: { [key: string]: string } = cfg.get(
    "alternateTools"
  ) as any;
  const alternateToolPath: string = alternateTools[tool];

  const gorootInSetting = resolvePath(cfg.get("goroot")!!);

  let selectedGoPath: string | undefined;
  if (tool === "go" && !gorootInSetting) {
    selectedGoPath = getFromWorkspaceState("selectedGo")?.binpath;
  }

  return getBinPathWithPreferredGopathGorootWithExplanation(
    tool,
    tool === "go" ? [] : [getToolsGopath(), getCurrentGoPath()],
    tool === "go" ? gorootInSetting : undefined,
    selectedGoPath ?? resolvePath(alternateToolPath),
    useCache
  );
}

/**
 * Expands ~ to homedir in non-Windows platform and resolves ${workspaceFolder} or ${workspaceRoot}
 */
export function resolvePath(
  inputPath: string,
  workspaceFolder?: string
): string {
  if (!inputPath || !inputPath.trim()) {
    return inputPath;
  }

  if (!workspaceFolder && vscode.workspace.workspaceFolders) {
    workspaceFolder = getWorkspaceFolderPath(
      vscode.window.activeTextEditor &&
        vscode.window.activeTextEditor.document.uri
    );
  }

  if (workspaceFolder) {
    inputPath = inputPath.replace(
      /\${workspaceFolder}|\${workspaceRoot}/g,
      workspaceFolder
    );
  }
  return resolveHomeDir(inputPath);
}

export function getWorkspaceFolderPath(
  fileUri?: vscode.Uri
): string | undefined {
  if (fileUri) {
    const workspace = vscode.workspace.getWorkspaceFolder(fileUri);
    if (workspace) {
      return fixDriveCasingInWindows(workspace.uri.fsPath);
    }
  }

  // fall back to the first workspace
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) {
    return fixDriveCasingInWindows(folders[0].uri.fsPath);
  }
  return undefined;
}

let toolsGopath: string;

export function getToolsGopath(useCache = true): string {
  if (!useCache || !toolsGopath) {
    toolsGopath = resolveToolsGopath();
  }
  return toolsGopath;
}

function resolveToolsGopath(): string {
  let toolsGopathForWorkspace = substituteEnv(
    getGoConfig()["toolsGopath"] || ""
  );

  // In case of single root
  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length <= 1
  ) {
    return resolvePath(toolsGopathForWorkspace);
  }

  // In case of multi-root, resolve ~ and ${workspaceFolder}
  if (toolsGopathForWorkspace.startsWith("~")) {
    toolsGopathForWorkspace = path.join(
      os.homedir(),
      toolsGopathForWorkspace.substr(1)
    );
  }
  if (
    toolsGopathForWorkspace &&
    toolsGopathForWorkspace.trim() &&
    !/\${workspaceFolder}|\${workspaceRoot}/.test(toolsGopathForWorkspace)
  ) {
    return toolsGopathForWorkspace;
  }

  if (defaultConfigFunc().workspaceIsTrusted() === false) {
    return toolsGopathForWorkspace;
  }

  // If any of the folders in multi root have toolsGopath set and the workspace is trusted, use it.
  for (const folder of vscode.workspace.workspaceFolders) {
    const value = getGoConfig(folder.uri).inspect(
      "toolsGopath"
    )?.workspaceFolderValue;
    let toolsGopathFromConfig = <string>value;
    toolsGopathFromConfig = resolvePath(
      toolsGopathFromConfig,
      folder.uri.fsPath
    );
    if (toolsGopathFromConfig) {
      return toolsGopathFromConfig;
    }
  }
  return toolsGopathForWorkspace;
}

// Returns the workspace Configuration used by the extension.
export function defaultConfigFunc() {
  return defaultConfig;
}

export function getFromWorkspaceState(key: string, defaultValue?: any) {
  if (!workspaceState) {
    return defaultValue;
  }
  return workspaceState.get(key, defaultValue);
}

let workspaceState: vscode.Memento;

let currentGopath = "";
export function getCurrentGoPath(workspaceUri?: vscode.Uri): string {
  const activeEditorUri =
    vscode.window.activeTextEditor &&
    vscode.window.activeTextEditor.document.uri;
  const value = activeEditorUri && activeEditorUri.fsPath;
  const currentFilePath = fixDriveCasingInWindows(value as string);
  const currentRoot =
    (workspaceUri && workspaceUri.fsPath) ||
    (getWorkspaceFolderPath(activeEditorUri) as string);
  const config = getGoConfig(workspaceUri || activeEditorUri);

  // Infer the GOPATH from the current root or the path of the file opened in current editor
  // Last resort: Check for the common case where GOPATH itself is opened directly in VS Code
  let inferredGopath: string = "";
  if (config["inferGopath"] === true) {
    inferredGopath =
      getInferredGopath(currentRoot) || getInferredGopath(currentFilePath);
    if (!inferredGopath) {
      try {
        if (fs.statSync(path.join(currentRoot, "src")).isDirectory()) {
          inferredGopath = currentRoot;
        }
      } catch (e) {
        // No op
      }
    }
    if (
      inferredGopath &&
      process.env["GOPATH"] &&
      inferredGopath !== process.env["GOPATH"]
    ) {
      inferredGopath += path.delimiter + process.env["GOPATH"];
    }
  }

  const configGopath = config["gopath"]
    ? resolvePath(substituteEnv(config["gopath"]), currentRoot)
    : "";
  currentGopath = inferredGopath
    ? inferredGopath
    : configGopath || (process.env["GOPATH"] as string);
  return currentGopath;
}

export function substituteEnv(input: string): string {
  return input.replace(/\${env:([^}]+)}/g, (match, capture) => {
    return process.env[capture.trim()] || "";
  });
}

let suggestedDownloadGo = false;

export async function suggestDownloadGo() {
  const msg =
    `Failed to find the "go" binary in either GOROOT(${getCurrentGoRoot()}) or PATH(${envPath}).` +
    "Check PATH, or Install Go and reload the window. " +
    "If PATH isn't what you expected, see https://github.com/golang/vscode-go/issues/971";
  if (suggestedDownloadGo) {
    vscode.window.showErrorMessage(msg);
    return;
  }

  const choice = await vscode.window.showErrorMessage(
    msg,
    "Go to Download Page"
  );
  if (choice === "Go to Download Page") {
    vscode.env.openExternal(vscode.Uri.parse("https://golang.org/dl/"));
  }
  suggestedDownloadGo = true;
}

// toolExecutionEnvironment returns the environment in which tools should
// be executed. It always returns a new object.
export function toolExecutionEnvironment(
  uri?: vscode.Uri
): NodeJS.Dict<string> {
  const env = newEnvironment();
  const gopath = getCurrentGoPath(uri);
  if (gopath) {
    env["GOPATH"] = gopath;
  }

  // Remove json flag (-json or --json=<any>) from GOFLAGS because it will effect to result format of the execution
  if (env["GOFLAGS"] && env["GOFLAGS"].includes("-json")) {
    env["GOFLAGS"] = env["GOFLAGS"].replace(/(^|\s+)-?-json[^\s]*/g, "");
  }
  return env;
}

function newEnvironment(): NodeJS.Dict<string> {
  const toolsEnvVars = getGoConfig()["toolsEnvVars"];
  const env = Object.assign({}, process.env, toolsEnvVars);
  if (toolsEnvVars && typeof toolsEnvVars === "object") {
    Object.keys(toolsEnvVars).forEach(
      (key) =>
        (env[key] =
          typeof toolsEnvVars[key] === "string"
            ? resolvePath(toolsEnvVars[key])
            : toolsEnvVars[key])
    );
  }

  // The http.proxy setting takes precedence over environment variables.
  const httpProxy = vscode.workspace
    .getConfiguration("http", null)
    .get("proxy");
  if (httpProxy && typeof httpProxy === "string") {
    env["http_proxy"] = httpProxy;
    env["HTTP_PROXY"] = httpProxy;
    env["https_proxy"] = httpProxy;
    env["HTTPS_PROXY"] = httpProxy;
  }
  return env;
}

// -----------
// xxxx.......
// -----------
export function getReceiverName(typ: string, text: string): string | null {
  const arr = text.split("\n");
  const searchKey = `${typ})`;
  const searchLine = arr.find((line) => {
    if (line) {
      return line.indexOf(searchKey) !== -1;
    }
  });
  if (!searchLine) {
    return null;
  }
  const match = searchLine?.match(/(?<=func\s*\()[^)]*(?=\s*\))/g);
  if (!match) {
    return null;
  }

  return match[0];
}
