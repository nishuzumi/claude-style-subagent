import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type DormantUiDelegate = Partial<
  Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor" | "custom" | "notify">
>;

export interface ForegroundAgentsApi {
  adopt(
    id: string,
    session: AgentSession,
    options?: { label?: string; dormantUi?: DormantUiDelegate },
  ): () => void;
  setForeground(id: string): Promise<void>;
  getForeground(): string;
  list(): Array<{ id: string; label?: string; isForeground: boolean }>;
}

export type RuntimePatchedAgentSession = AgentSession & {
  setExtensionUiContext(uiContext: ExtensionUIContext): void;
  readonly extensionUiContext: ExtensionUIContext | undefined;
};
