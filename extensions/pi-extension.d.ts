declare module "@earendil-works/pi-coding-agent" {
  export function defineTool<T>(tool: T): T;
  export interface ExtensionAPI {
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void;
    registerTool(tool: { name: string; label: string; description: string; parameters: unknown; execute: (id: string, params: any, signal: AbortSignal, update: unknown, ctx: { cwd: string; sessionManager: { getSessionId(): string } }) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> }): void;
  }
  export interface ExtensionCommandContext {
    cwd: string;
    sessionManager: { getSessionId(): string };
    ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  }
}

declare module "@earendil-works/pi-ai" {
  export const Type: { Object(value: Record<string, unknown>): unknown; String(options?: Record<string, unknown>): unknown; Array(item: unknown): unknown; Union(items: unknown[]): unknown; Literal(value: string): unknown };
}
