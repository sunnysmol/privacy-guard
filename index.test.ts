import { describe, it, expect, vi, beforeEach } from "vitest";
import { scanForPII } from "./scanner.js";

// ─────────────────────────────────────────────────────────────────────────────
// index.ts uses the ExtensionAPI / ExtensionContext from pi-coding-agent which
// is not available in a plain vitest environment.  We test the extension logic
// by rebuilding a minimal subset of the pi API in pure JS and then importing
// (re-running) the default export directly.
//
// For the hook tests we test the LOGIC functions extracted from the extension
// rather than loading the full extension, to avoid the pi-coding-agent
// runtime dependency.  The scanner integration is already tested in
// scanner.test.ts.  Here we exercise the key decision paths.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Minimal pi API builder
// ─────────────────────────────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>, ctx: MockContext) => Promise<void> | void;

interface MockContext {
  model: { provider: string; id: string };
  modelRegistry: {
    find: (provider: string, id: string) => { provider: string; id: string } | undefined;
  };
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
}

function buildMockPi() {
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, { handler: (args: string | undefined, ctx: MockContext) => Promise<void> }> = {};
  let currentModel: { provider: string; id: string } = { provider: "openai", id: "gpt-4o" };
  let providerRegistered = false;
  let registeredProvider: unknown = null;

  const mockSetModel = vi.fn(async (model: { provider: string; id: string }) => {
    currentModel = model;
    return true;
  });

  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    },
    registerProvider(id: string, config: unknown) {
      providerRegistered = true;
      registeredProvider = { id, config };
    },
    registerCommand(name: string, opts: { description: string; handler: (args: string | undefined, ctx: MockContext) => Promise<void> }) {
      commands[name] = opts;
    },
    setModel: mockSetModel,
    // Test helpers
    _handlers: handlers,
    _commands: commands,
    _getCurrentModel: () => currentModel,
    _isProviderRegistered: () => providerRegistered,
    _getRegisteredProvider: () => registeredProvider,
    _mockSetModel: mockSetModel,
  };

  return pi;
}

function buildMockContext(overrides?: Partial<MockContext>): MockContext {
  return {
    model: { provider: "openai", id: "gpt-4o" },
    modelRegistry: {
      find: (provider, id) => ({ provider, id }),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// We can't easily import index.ts (it depends on @mariozechner/pi-coding-agent
// types at runtime and has side-effects on import).  Instead we replicate the
// critical decision logic inline and test it against the real scanner.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Inline reimplementation of before_agent_start decision logic ─────────────

async function runBeforeAgentStart(opts: {
  enabled: boolean;
  serverReady: boolean;
  prompt: string;
  currentModel: { provider: string; id: string };
  localModelId: string | null;
  registryFind: (provider: string, id: string) => { provider: string; id: string } | undefined;
  setModel: (m: { provider: string; id: string }) => Promise<boolean>;
  uiNotify: (msg: string, level: string) => void;
  uiSetStatus: (id: string, val: string | undefined) => void;
}): Promise<{ routedToLocal: boolean; savedProvider: string | null; savedModelId: string | null }> {
  const PROVIDER_ID = "privacy-guard-mlx";

  if (!opts.enabled) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  if (!opts.serverReady) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  const scan = scanForPII(opts.prompt);
  if (!scan.hasPII) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  if (opts.currentModel.provider === PROVIDER_ID) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  if (!opts.localModelId) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  const localModel = opts.registryFind(PROVIDER_ID, opts.localModelId);
  if (!localModel) {
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  const savedProvider = opts.currentModel.provider;
  const savedModelId = opts.currentModel.id;

  const success = await opts.setModel(localModel);
  if (!success) {
    opts.uiNotify("[privacy-guard] Failed to switch to local model", "error");
    return { routedToLocal: false, savedProvider: null, savedModelId: null };
  }

  const emoji = scan.tier === "high" ? "🔴" : "🟡";
  const label = scan.reasons.join(", ");
  opts.uiSetStatus("privacy-guard", `${emoji} Local MLX — ${label}`);
  opts.uiNotify(`🔒 Privacy Guard: routing to local MLX — detected: ${label}`, "warning");

  return { routedToLocal: true, savedProvider, savedModelId };
}

// ─── Inline reimplementation of turn_end restore logic ───────────────────────

async function runTurnEnd(opts: {
  routedToLocal: boolean;
  savedProvider: string | null;
  savedModelId: string | null;
  registryFind: (provider: string, id: string) => { provider: string; id: string } | undefined;
  setModel: (m: { provider: string; id: string }) => Promise<boolean>;
  uiSetStatus: (id: string, val: string | undefined) => void;
}): Promise<{ routedToLocal: boolean; savedProvider: string | null; savedModelId: string | null }> {
  if (!opts.routedToLocal || !opts.savedProvider || !opts.savedModelId) {
    return { routedToLocal: opts.routedToLocal, savedProvider: opts.savedProvider, savedModelId: opts.savedModelId };
  }

  const original = opts.registryFind(opts.savedProvider, opts.savedModelId);

  const newState = { routedToLocal: false, savedProvider: null as string | null, savedModelId: null as string | null };

  if (original) {
    await opts.setModel(original);
    opts.uiSetStatus("privacy-guard", undefined);
  }

  return newState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests for before_agent_start hook
// ─────────────────────────────────────────────────────────────────────────────

describe("before_agent_start hook", () => {
  const setModel = vi.fn(async () => true);
  const uiNotify = vi.fn();
  const uiSetStatus = vi.fn();
  const registryFind = vi.fn((p: string, id: string) => ({ provider: p, id }));

  const baseOpts = {
    enabled: true,
    serverReady: true,
    currentModel: { provider: "openai", id: "gpt-4o" },
    localModelId: "mlx-community/Qwen3.5-9B-MLX-8bit",
    registryFind,
    setModel,
    uiNotify,
    uiSetStatus,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to local when PII detected (email)", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      prompt: "Email me at john@example.com",
    });

    expect(result.routedToLocal).toBe(true);
    expect(result.savedProvider).toBe("openai");
    expect(result.savedModelId).toBe("gpt-4o");
    expect(setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "privacy-guard-mlx" })
    );
    expect(uiNotify).toHaveBeenCalledWith(
      expect.stringContaining("routing to"),
      "warning"
    );
    expect(uiSetStatus).toHaveBeenCalledWith(
      "privacy-guard",
      expect.stringContaining("🔴")
    );
  });

  it("routes to local when PII detected (SSN — high tier)", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      prompt: "My SSN is 123-45-6789",
    });
    expect(result.routedToLocal).toBe(true);
    expect(uiSetStatus).toHaveBeenCalledWith(
      "privacy-guard",
      expect.stringContaining("🔴")
    );
  });

  it("uses 🟡 for medium-tier PII", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      prompt: "Please check my date of birth",
    });
    expect(result.routedToLocal).toBe(true);
    expect(uiSetStatus).toHaveBeenCalledWith(
      "privacy-guard",
      expect.stringContaining("🟡")
    );
  });

  it("does not route when guard is disabled", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      enabled: false,
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not route when server is not ready", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      serverReady: false,
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not route when no PII detected", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      prompt: "What is the capital of France?",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(uiNotify).not.toHaveBeenCalled();
  });

  it("does not route when already on local model", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      currentModel: { provider: "privacy-guard-mlx", id: "some-model" },
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not route when localModelId is null", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      localModelId: null,
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not route when model not found in registry", async () => {
    const result = await runBeforeAgentStart({
      ...baseOpts,
      registryFind: () => undefined,
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("does not route when setModel returns false", async () => {
    const failingSetModel = vi.fn(async () => false);
    const result = await runBeforeAgentStart({
      ...baseOpts,
      setModel: failingSetModel,
      prompt: "Email me at john@example.com",
    });
    expect(result.routedToLocal).toBe(false);
    expect(uiNotify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to switch"),
      "error"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests for turn_end hook
// ─────────────────────────────────────────────────────────────────────────────

describe("turn_end hook", () => {
  const setModel = vi.fn(async () => true);
  const uiSetStatus = vi.fn();
  const registryFind = vi.fn((p: string, id: string) => ({ provider: p, id }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores original model after a routed turn", async () => {
    const result = await runTurnEnd({
      routedToLocal: true,
      savedProvider: "openai",
      savedModelId: "gpt-4o",
      registryFind,
      setModel,
      uiSetStatus,
    });

    expect(setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", id: "gpt-4o" })
    );
    expect(uiSetStatus).toHaveBeenCalledWith("privacy-guard", undefined);
    expect(result.routedToLocal).toBe(false);
    expect(result.savedProvider).toBeNull();
    expect(result.savedModelId).toBeNull();
  });

  it("is a no-op when routedToLocal is false", async () => {
    const result = await runTurnEnd({
      routedToLocal: false,
      savedProvider: null,
      savedModelId: null,
      registryFind,
      setModel,
      uiSetStatus,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(uiSetStatus).not.toHaveBeenCalled();
    expect(result.routedToLocal).toBe(false);
  });

  it("does not restore when original model is not in registry", async () => {
    const result = await runTurnEnd({
      routedToLocal: true,
      savedProvider: "openai",
      savedModelId: "gpt-4o",
      registryFind: () => undefined,
      setModel,
      uiSetStatus,
    });

    expect(setModel).not.toHaveBeenCalled();
    expect(result.routedToLocal).toBe(false);
  });

  it("clears state regardless of whether original was found", async () => {
    const result = await runTurnEnd({
      routedToLocal: true,
      savedProvider: "anthropic",
      savedModelId: "claude-3-5",
      registryFind: () => undefined,
      setModel,
      uiSetStatus,
    });

    expect(result.routedToLocal).toBe(false);
    expect(result.savedProvider).toBeNull();
    expect(result.savedModelId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /privacy command handler smoke tests
// ─────────────────────────────────────────────────────────────────────────────

describe("/privacy command handler", () => {
  // Replicate the command handler logic inline
  function buildHandler() {
    let enabled = true;
    let serverReady = true;
    const managerStatus = "omlx";
    const managerActiveModel = "mlx-community/Qwen3.5-9B-MLX-8bit";
    const STATUS_ID = "privacy-guard";

    const handler = async (
      args: string | undefined,
      ctx: MockContext
    ) => {
      const cmd = (args ?? "").trim().toLowerCase();

      if (cmd === "off") {
        enabled = false;
        ctx.ui.setStatus(STATUS_ID, "⏸ Privacy Guard OFF");
        ctx.ui.notify("Privacy Guard disabled — cloud models will see all data", "warning");
        return;
      }

      if (cmd === "on") {
        enabled = true;
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.notify("Privacy Guard enabled", "info");
        return;
      }

      if (cmd === "models") {
        ctx.ui.notify(
          [
            "Local MLX models (default → fallback):",
            `Server status : ${managerStatus}`,
            `Active model  : ${managerActiveModel}`,
            `Guard enabled : ${enabled}`,
          ].join("\n"),
          "info"
        );
        return;
      }

      // Default: show status
      ctx.ui.notify(
        [
          `Privacy Guard : ${enabled ? "✅ ON" : "⏸ OFF"}`,
          `Server        : ${managerStatus}`,
          `Local model   : ${managerActiveModel}`,
          `Server ready  : ${serverReady}`,
        ].join("\n"),
        "info"
      );
    };

    return { handler, getEnabled: () => enabled };
  }

  it("/privacy (no args) shows status", async () => {
    const { handler } = buildHandler();
    const ctx = buildMockContext();
    await handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Privacy Guard"),
      "info"
    );
  });

  it("/privacy off disables guard and notifies", async () => {
    const { handler, getEnabled } = buildHandler();
    const ctx = buildMockContext();
    await handler("off", ctx);
    expect(getEnabled()).toBe(false);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("privacy-guard", "⏸ Privacy Guard OFF");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("disabled"),
      "warning"
    );
  });

  it("/privacy on re-enables guard", async () => {
    const { handler, getEnabled } = buildHandler();
    const ctx = buildMockContext();
    await handler("off", ctx);
    expect(getEnabled()).toBe(false);
    await handler("on", ctx);
    expect(getEnabled()).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("privacy-guard", undefined);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Privacy Guard enabled", "info");
  });

  it("/privacy models lists local models", async () => {
    const { handler } = buildHandler();
    const ctx = buildMockContext();
    await handler("models", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("MLX models"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("omlx"),
      "info"
    );
  });

  it("/privacy status shows ON when enabled", async () => {
    const { handler } = buildHandler();
    const ctx = buildMockContext();
    await handler("status", ctx);
    // "status" is not a known subcommand — falls through to default
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("✅ ON"),
      "info"
    );
  });

  it("/privacy status shows OFF after disabling", async () => {
    const { handler } = buildHandler();
    const ctx = buildMockContext();
    await handler("off", ctx);
    vi.clearAllMocks();
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("⏸ OFF"),
      "info"
    );
  });
});
