import {
  QuickPickItem,
  window,
  Disposable,
  QuickInputButton,
  QuickInput,
  ExtensionContext,
  QuickInputButtons,
} from "vscode";
import { fileServer } from "./fileserver";

interface IPickItem extends QuickPickItem {
  goImterface: fileServer.IInterface;
}

export async function multiStepInput(
  context: ExtensionContext,
  resourceGroups: IPickItem[],
  nextStep: boolean
) {
  interface State {
    title: string;
    step: number;
    totalSteps: number;
    resourceInterfaces: IPickItem;
    receiverNamePair: string; // eg: f *(ptr) or f
    name: string;
    runtime: IPickItem;
  }

  async function collectInputs() {
    const state = {} as Partial<State>;
    await MultiStepInput.run((input) => pickInterface(input, state));
    return state as State;
  }

  const title = "Generate Interface Stubs";

  async function pickInterface(input: MultiStepInput, state: Partial<State>) {
    const pick = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: "Input or choose interface to implement",
      items: resourceGroups,
      activeItem:
        typeof state.resourceInterfaces !== "string"
          ? state.resourceInterfaces
          : undefined,
      shouldResume: shouldResume,
    });
    state.resourceInterfaces = pick as IPickItem;
    if (!nextStep) {
      return;
    }
    return (input: MultiStepInput) => inputRecieverName(input, state);
  }

  async function inputRecieverName(
    input: MultiStepInput,
    state: Partial<State>
  ) {
    let namePair = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value:
        typeof state.resourceInterfaces === "string"
          ? state.resourceInterfaces
          : "",
      prompt: "Enter receiver(eg: f * or f) to implement.",
      validate: validateName,
      shouldResume: shouldResume,
    });
    namePair = namePair.trim();
    if (!namePair.endsWith("*")) {
      namePair += " ";
    }
    state.receiverNamePair = namePair;
  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateName(name: string) {
    // ...validate...
    name = name.trim();
    if (!name) {
      return "Enter receiver(eg: f * or f)";
    }
    const reg = /[*a-zA-Z0-9]+/g;
    if (!reg.test(name)) {
      return "Enter receiver(eg: f * or f)";
    }
    if (name.includes("*")) {
      const arr = name.split(/[ ]+/);
      if (arr.length !== 2) {
        return "Invalid receiver";
      }
      if (arr[1] !== "*") {
        return "Invalid receiver";
      }
    }

    return undefined;
  }

  const state = await collectInputs();
  return state;
}

// -------------------------------------------------------
// Helper code that wraps the API for the multi-step case.
// -------------------------------------------------------

class InputFlowAction {
  static back = new InputFlowAction();
  static cancel = new InputFlowAction();
  static resume = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface QuickPickParameters<T extends QuickPickItem> {
  title: string;
  step: number;
  totalSteps: number;
  items: T[];
  activeItem?: T;
  placeholder: string;
  buttons?: QuickInputButton[];
  shouldResume: () => Thenable<boolean>;
}

interface InputBoxParameters {
  title: string;
  step: number;
  totalSteps: number;
  value: string;
  prompt: string;
  validate: (value: string) => Promise<string | undefined>;
  buttons?: QuickInputButton[];
  shouldResume: () => Thenable<boolean>;
}

class MultiStepInput {
  static async run<T>(start: InputStep) {
    const input = new MultiStepInput();
    return input.stepThrough(start);
  }

  private current?: QuickInput;
  private steps: InputStep[] = [];

  private async stepThrough<T>(start: InputStep) {
    let step: InputStep | void = start;
    while (step) {
      this.steps.push(step);
      if (this.current) {
        this.current.enabled = false;
        this.current.busy = true;
      }
      try {
        step = await step(this);
      } catch (err) {
        if (err === InputFlowAction.back) {
          this.steps.pop();
          step = this.steps.pop();
        } else if (err === InputFlowAction.resume) {
          step = this.steps.pop();
        } else if (err === InputFlowAction.cancel) {
          step = undefined;
        } else {
          throw err;
        }
      }
    }
    if (this.current) {
      this.current.dispose();
    }
  }

  async showQuickPick<
    T extends QuickPickItem,
    P extends QuickPickParameters<T>
  >({
    title,
    step,
    totalSteps,
    items,
    activeItem,
    placeholder,
    buttons,
    shouldResume,
  }: P) {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<
        T | (P extends { buttons: (infer I)[] } ? I : never)
      >((resolve, reject) => {
        const input = window.createQuickPick<T>();
        input.title = title;
        input.step = step;
        input.totalSteps = totalSteps;
        input.placeholder = placeholder;
        input.items = items;
        if (activeItem) {
          input.activeItems = [activeItem];
        }
        input.buttons = [
          ...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
          ...(buttons || []),
        ];
        disposables.push(
          input.onDidTriggerButton((item) => {
            if (item === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>item);
            }
          }),
          input.onDidChangeSelection((items) => resolve(items[0])),
          input.onDidHide(() => {
            (async () => {
              reject(
                shouldResume && (await shouldResume())
                  ? InputFlowAction.resume
                  : InputFlowAction.cancel
              );
            })().catch(reject);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach((d) => d.dispose());
    }
  }

  async showInputBox<P extends InputBoxParameters>({
    title,
    step,
    totalSteps,
    value,
    prompt,
    validate,
    buttons,
    shouldResume,
  }: P) {
    const disposables: Disposable[] = [];
    try {
      return await new Promise<
        string | (P extends { buttons: (infer I)[] } ? I : never)
      >((resolve, reject) => {
        const input = window.createInputBox();
        input.title = title;
        input.step = step;
        input.totalSteps = totalSteps;
        input.value = value || "";
        input.prompt = prompt;
        input.buttons = [
          ...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
          ...(buttons || []),
        ];
        let validating = validate("");
        disposables.push(
          input.onDidTriggerButton((item) => {
            if (item === QuickInputButtons.Back) {
              reject(InputFlowAction.back);
            } else {
              resolve(<any>item);
            }
          }),
          input.onDidAccept(async () => {
            const value = input.value;
            input.enabled = false;
            input.busy = true;
            if (!(await validate(value))) {
              resolve(value);
            }
            input.enabled = true;
            input.busy = false;
          }),
          input.onDidChangeValue(async (text) => {
            const current = validate(text);
            validating = current;
            const validationMessage = await current;
            if (current === validating) {
              input.validationMessage = validationMessage;
            }
          }),
          input.onDidHide(() => {
            (async () => {
              reject(
                shouldResume && (await shouldResume())
                  ? InputFlowAction.resume
                  : InputFlowAction.cancel
              );
            })().catch(reject);
          })
        );
        if (this.current) {
          this.current.dispose();
        }
        this.current = input;
        this.current.show();
      });
    } finally {
      disposables.forEach((d) => d.dispose());
    }
  }
}
