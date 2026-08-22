import { ApiError, api, authFetch } from "@/lib/api";

export interface PrivacyConsent {
  personalization_enabled: boolean;
  experiments_enabled: boolean;
  product_analytics_enabled: boolean;
  sensitive_inference_enabled: boolean;
  policy_version: string;
  updated_at: string | null;
  derived_data_erased?: boolean;
}

export type PrivacyPurpose =
  | "personalization_enabled"
  | "experiments_enabled"
  | "product_analytics_enabled"
  | "sensitive_inference_enabled";

export type ConsentPatch = Partial<Pick<PrivacyConsent, PrivacyPurpose>> & {
  erase_derived_data?: boolean;
  request_id?: string;
};

function exportFilename(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? `planpilot-data-export-${new Date().toISOString().slice(0, 10)}.json`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const privacyApi = {
  getConsent: () => api.get<PrivacyConsent>("/api/v1/privacy/consent"),
  updateConsent: (patch: ConsentPatch) =>
    api.patch<PrivacyConsent>("/api/v1/privacy/consent", patch),
  exportServerData: async () => {
    const response = await authFetch("/api/v1/privacy/export");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ detail: "完整数据导出失败" })) as { detail?: string };
      throw new ApiError(payload.detail ?? "完整数据导出失败", response.status);
    }
    const blob = await response.blob();
    downloadBlob(blob, exportFilename(response));
    return blob.size;
  },
  downloadLocalCache: (payload: Record<string, unknown>) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, `planpilot-local-cache-${new Date().toISOString().slice(0, 10)}.json`);
    return blob.size;
  },
};
