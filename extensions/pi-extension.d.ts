declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI { registerCommand(name: string, options: { description: string; handler: (args: string, ctx: { ui: { notify(message: string, level: "info" | "error"): void } }) => Promise<void> | void }): void; }
}
