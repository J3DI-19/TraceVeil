import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { phase3Api, type SmtpConfiguration } from "../../api/phase3";
import { SmtpSettingsPanel } from "./SmtpSettingsPanel";

vi.mock("../../api/phase3", () => ({
  phase3Api: {
    emailDeliveryConfiguration: vi.fn(),
    updateEmailDeliveryConfiguration: vi.fn(),
  },
}));

const initial: SmtpConfiguration = {
  host: "", port: 1025, starttls: false, username: "", password_set: false,
  from_address: "traceveil@localhost", allowed_recipient_domains: ["example.test"], configured: false,
};

describe("SmtpSettingsPanel", () => {
  beforeEach(() => vi.resetAllMocks());

  it("saves SMTP settings without redisplaying the credential", async () => {
    vi.mocked(phase3Api.emailDeliveryConfiguration).mockResolvedValue(initial);
    vi.mocked(phase3Api.updateEmailDeliveryConfiguration).mockResolvedValue({
      host: "smtp.example.test", port: 587, starttls: true,
      username: "reports@example.test", password_set: true,
      from_address: "reports@example.test", allowed_recipient_domains: ["example.test"], configured: true,
    });
    render(<SmtpSettingsPanel />);
    expect(await screen.findByLabelText("SMTP host")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "smtp.example.test" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "587" } });
    fireEvent.click(screen.getByLabelText("Use STARTTLS"));
    fireEvent.change(screen.getByLabelText("Sender address"), { target: { value: "reports@example.test" } });
    fireEvent.change(screen.getByLabelText("SMTP username"), { target: { value: "reports@example.test" } });
    fireEvent.change(screen.getByLabelText("SMTP password"), { target: { value: "example-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(phase3Api.updateEmailDeliveryConfiguration).toHaveBeenCalledWith({
      host: "smtp.example.test", port: 587, starttls: true,
      username: "reports@example.test", password: "example-secret", clear_password: false,
      from_address: "reports@example.test", allowed_recipient_domains: ["example.test"],
    }));
    expect(await screen.findByText(/Email settings saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("SMTP password")).toHaveValue("");
    expect(screen.getByText(/A password is saved on this computer/)).toBeInTheDocument();
  });
});
