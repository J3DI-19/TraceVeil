import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";

afterEach(() => vi.unstubAllGlobals());

function responseFor(path: string, databaseStatus = "ok") {
  const body = path.endsWith("/ai")
    ? {
        service: "ollama", enabled: true, available: false, server_running: false,
        server_control_supported: true, ready: false,
        model: "qwen35-uncensored:latest", model_installed: false, model_loaded: false,
        provider: "Local Ollama", thinking_enabled: false, temperature: 0,
        max_output_tokens: 512, generation_timeout_seconds: 120,
      }
    : { service: path.endsWith("/db") ? "database" : "api", status: path.endsWith("/db") ? databaseStatus : "ok" };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("shared system health", () => {
  it("shows Ollama and Traceveil AI as separate services", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(responseFor(String(input)))));
    window.history.replaceState({}, "", "/status");
    render(<App/>);
    expect(await screen.findByRole("button", { name: "Platform health: operational" })).toBeInTheDocument();
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Waiting for Ollama").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ollama server").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Traceveil AI").length).toBeGreaterThan(0);
    expect(screen.queryByText("AI / Ollama")).not.toBeInTheDocument();
  });

  it("distinguishes database and backend outages", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(responseFor(String(input), "unavailable"))));
    window.history.replaceState({}, "", "/status");
    const { unmount } = render(<App/>);
    expect(await screen.findByRole("button", { name: "Platform health: database unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Evidence database unavailable");
    unmount();

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<App/>);
    expect(await screen.findByRole("button", { name: "Platform health: backend unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Backend API unavailable");
  });

  it("refreshes shared status without reloading the browser", async () => {
    let databaseChecks = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/db")) databaseChecks += 1;
      return Promise.resolve(responseFor(path, databaseChecks === 1 ? "unavailable" : "ok"));
    }));
    window.history.replaceState({}, "", "/status");
    render(<App/>);
    await screen.findByRole("button", { name: "Platform health: database unavailable" });
    fireEvent.click(screen.getByRole("button", { name: /Refresh status/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Platform health: operational" })).toBeInTheDocument());
  });

  it("toggles Traceveil AI without stopping core services", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/ai") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({
          service: "ollama", enabled: false, available: true, ready: false,
          model: "qwen35-uncensored:latest", model_installed: true, model_loaded: true,
          provider: "Local Ollama", family: "qwen3", parameter_size: "9.7B",
          quantization_level: "Q4_K_M", max_context_length: 262144,
          active_context_length: 32768, max_output_tokens: 512,
          grounding_context_limit_bytes: 24576,
          thinking_enabled: false, temperature: 0, generation_timeout_seconds: 120,
        }), { status: 200 }));
      }
      return Promise.resolve(responseFor(path));
    }));
    window.history.replaceState({}, "", "/status");
    render(<App/>);
    fireEvent.click(await screen.findByRole("button", { name: "Disable AI" }));
    expect(await screen.findByRole("button", { name: "Enable AI" })).toBeInTheDocument();
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(screen.getByText("32,768 tokens")).toBeInTheDocument();
    expect(screen.getByText("262,144 tokens")).toBeInTheDocument();
    expect(screen.getByText("24 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Platform health: operational" })).toBeInTheDocument();
  });

  it("starts the Ollama server independently from the AI preference", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/ai/server") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({
          service: "ollama", enabled: true, available: true, server_running: true,
          server_control_supported: true, ready: true, model: "qwen35-uncensored:latest",
          model_installed: true, model_loaded: false, provider: "Local Ollama",
        }), { status: 200 }));
      }
      return Promise.resolve(responseFor(path));
    }));
    window.history.replaceState({}, "", "/status");
    render(<App/>);
    fireEvent.click(await screen.findByRole("button", { name: "Start Ollama" }));
    expect(await screen.findByRole("button", { name: "Stop Ollama" })).toBeInTheDocument();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Disable AI" })).toBeInTheDocument();
  });
});
