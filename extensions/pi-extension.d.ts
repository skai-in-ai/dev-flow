declare module "@earendil-works/pi-coding-agent" {
  export function defineTool<T>(tool: T): T;
  export interface ExtensionAPI {
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void;
    registerTool(tool: { name: string; label: string; description: string; parameters: unknown; execute: (id: string, params: any, signal: AbortSignal, update: unknown, ctx: { cwd: string; sessionManager: { getSessionId(): string }; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> }): void;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
    on(event: "before_agent_start", handler: (event: { prompt: string }, ctx: { sessionManager: { getSessionId(): string } }) => Promise<void> | void): void;
    on(event: "agent_end", handler: (event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => Promise<void> | void): void;
  }
  export interface ExtensionCommandContext {
    cwd: string;
    sessionManager: { getSessionId(): string };
    isIdle(): boolean;
    ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  }
}

declare module "@earendil-works/pi-ai" {
  export const Type: { Object(value: Record<string, unknown>): unknown; String(options?: Record<string, unknown>): unknown; Array(item: unknown): unknown; Optional(item: unknown): unknown; Union(items: unknown[]): unknown; Literal(value: string): unknown };
}
