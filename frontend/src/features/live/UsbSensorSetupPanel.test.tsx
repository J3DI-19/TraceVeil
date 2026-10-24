import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiCase } from "../../api/batch";
import { usbSensorApi, type UsbSensorStatus } from "../../api/usbSensor";
import { UsbSensorSetupPanel } from "./UsbSensorSetupPanel";

const idle: UsbSensorStatus = { state: "idle", message: "Connect your board.", port: null, case_id: null, session_id: null, last_reading_at: null, readings: 0 };
const cases = [{ id: 8, name: "Yesterday's case" }] as ApiCase[];
afterEach(() => vi.restoreAllMocks());

describe("USB sensor setup", () => {
  it("defaults to a new case and switches only after a real reading is confirmed", async () => {
    let status = idle;
    vi.spyOn(usbSensorApi, "status").mockImplementation(async () => status);
    vi.spyOn(usbSensorApi, "ports").mockResolvedValue({ items: [{ port: "COM7", description: "CP2102" }] });
    const start = vi.spyOn(usbSensorApi, "start").mockImplementation(async () => {
      status = { ...idle, state: "waiting", message: "Waiting for the first reading", case_id: 9, session_id: "usb-session", port: "COM7" };
      return status;
    });
    const ready = vi.fn();
    render(<UsbSensorSetupPanel cases={cases} onReady={ready}/>);
    expect(await screen.findByText("COM7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect & start" }));
    expect(await screen.findByText("Waiting for the first reading")).toBeInTheDocument();
    expect(start).toHaveBeenCalledWith(null, expect.stringContaining("ESP32 DHT22"), null);
    expect(ready).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Connect & start" })).not.toBeInTheDocument();
    status = { ...status, state: "capturing", message: "USB sensor connected", readings: 1 };
    await waitFor(() => expect(ready).toHaveBeenCalledWith(9, "usb-session"), { timeout: 2500 });
  });

  it("selects an existing case and exposes setup failures without claiming success", async () => {
    vi.spyOn(usbSensorApi, "status").mockResolvedValue(idle);
    vi.spyOn(usbSensorApi, "ports").mockResolvedValue({ items: [] });
    const start = vi.spyOn(usbSensorApi, "start").mockRejectedValue(new Error("No ESP32 found"));
    const ready = vi.fn();
    render(<UsbSensorSetupPanel cases={cases} onReady={ready}/>);
    fireEvent.change(screen.getByLabelText("USB capture case"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & start" }));
    expect(await screen.findByText("No ESP32 found")).toBeInTheDocument();
    expect(start).toHaveBeenCalledWith(8, expect.any(String), null);
    expect(ready).not.toHaveBeenCalled();
  });
});
