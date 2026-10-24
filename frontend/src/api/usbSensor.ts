import { apiClient } from "./batch";

export interface UsbSensorStatus {
  state: "idle" | "connecting" | "flashing" | "waiting" | "capturing" | "stopped" | "error";
  message: string; port: string | null; case_id: number | null; session_id: string | null;
  last_reading_at: string | null; readings: number;
}
export const usbSensorApi = {
  status(signal?: AbortSignal) { return apiClient.request<UsbSensorStatus>("/usb-sensor/status", { signal }); },
  ports(signal?: AbortSignal) { return apiClient.request<{ items: { port: string; description: string }[] }>("/usb-sensor/ports", { signal }); },
  start(caseId: number | null, name: string, port: string | null) {
    return apiClient.request<UsbSensorStatus>("/usb-sensor/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: caseId, name, port }) });
  },
  stop() { return apiClient.request<UsbSensorStatus>("/usb-sensor/stop", { method: "POST" }); },
};
