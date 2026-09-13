import { apiClient } from "./batch";

export type ServiceStatus = {
  status?: string;
  service: string;
  available?: boolean;
  server_running?: boolean;
  server_control_supported?: boolean;
  enabled?: boolean;
  ready?: boolean;
  model?: string;
  model_installed?: boolean;
  model_loaded?: boolean;
  provider?: string;
  family?: string | null;
  parameter_size?: string | null;
  quantization_level?: string | null;
  size_bytes?: number | null;
  max_context_length?: number | null;
  active_context_length?: number | null;
  size_vram_bytes?: number | null;
  expires_at?: string | null;
  capabilities?: string[];
  thinking_enabled?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  grounding_context_limit_bytes?: number;
  request_context_length?: number;
  keep_alive?: string;
  generation_timeout_seconds?: number;
  message?: string;
};

async function getHealth(path: string): Promise<ServiceStatus> {
  return apiClient.request<ServiceStatus>(path ? `/health/${path}` : "/health");
}

export async function getSystemStatus(): Promise<ServiceStatus[]> {
  const results = await Promise.allSettled([getHealth(""), getHealth("db"), getHealth("ai")]);
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { service: ["api", "database", "ollama"][index], status: "unavailable" },
  );
}

export function setAiEnabled(enabled: boolean): Promise<ServiceStatus> {
  return apiClient.request<ServiceStatus>("/health/ai", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function setOllamaRunning(running: boolean): Promise<ServiceStatus> {
  return apiClient.request<ServiceStatus>("/health/ai/server", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ running }),
  });
}
