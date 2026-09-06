export {};

declare global {
  interface PlanPilotDesktopModel {
    id: string;
    name: string;
    path: string;
    sizeBytes: number;
    kind: "embedding" | "generation";
  }

  interface Window {
    planpilotDesktop?: {
      getEnvironment(): Promise<{ isDesktop: true; appVersion: string; installationId: string; deviceName: string; platform: string }>;
      getModelPreferences(): Promise<{ modelDirectory: string; selectedModel: string; models: PlanPilotDesktopModel[] }>;
      chooseModelDirectory(): Promise<{ modelDirectory: string; selectedModel: string; models: PlanPilotDesktopModel[] } | null>;
      selectModel(modelPath: string): Promise<{ modelDirectory: string; selectedModel: string; models: PlanPilotDesktopModel[] }>;
      downloadModel(sourceUrl: string): Promise<{ modelDirectory: string; selectedModel: string; models: PlanPilotDesktopModel[] }>;
      onModelDownloadProgress(callback: (value: { filename: string; receivedBytes: number; totalBytes: number }) => void): () => void;
      getPrivateSpacePreferences(): Promise<{ privateSpaceDirectory: string; privateSpaceId: string }>;
      preparePrivateSpace(name: string): Promise<{ manifest: { id: string; name: string; storageRoot: string; status: "prepared" } } | null>;
    };
  }
}
