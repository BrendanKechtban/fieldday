import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpApp } from "../src/mcp/McpApp";
import { fakeHost, proposal } from "./fakeHost";

async function boot() {
  const h = fakeHost();
  h.handle((m) => { if (m.method === "ui/initialize") queueMicrotask(() => h.reply(m.id, {})); });
  const { container } = render(<McpApp transport={h.transport} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/waiting/i));
  act(() => h.push({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: proposal } }));
  return { h, container };
}

describe("MCP App status change", () => {
  it("shows the exact proposed change and reason, never the token", async () => {
    const { container } = await boot();
    expect(await screen.findByText("scheduled → delayed")).toBeInTheDocument();
    expect(screen.getByText("Thunderstorm forecast")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(proposal.token);
  });
  it("Confirm calls change_event_status with the bound arguments and reports success", async () => {
    const { h } = await boot();
    h.handle((m) => { if (m.method === "tools/call") queueMicrotask(() => h.reply(m.id, { content: [{ type: "text", text: "{}" }] })); });
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await screen.findByText(/Status is now delayed/);
    const call = h.sent.find((m) => m.method === "tools/call");
    expect(call.params).toEqual({ name: "change_event_status", arguments: { event_id: 7, new_status: "delayed", confirmation_token: proposal.token } });
  });
  it("shows the server's rejection (bad_confirmation) and offers no retry with the spent token", async () => {
    const { h, container } = await boot();
    const err = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "bad_confirmation", message: "Confirmation already used" } }) }] };
    h.handle((m) => { if (m.method === "tools/call") queueMicrotask(() => h.reply(m.id, err)); });
    await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer valid/);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(container.innerHTML).not.toContain(proposal.token);
  });
  it("Cancel sends no tool call", async () => {
    const { h } = await boot();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(h.sent.some((m) => m.method === "tools/call")).toBe(false);
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
  });
});
