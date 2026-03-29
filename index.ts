/**
 * privacy-guard — pi extension
 *
 * Automatically routes prompts containing personal/sensitive data to a
 * local model instead of a cloud provider.
 *
 * Fallback chain (first available wins):
 *   1. omlx server (port 8123) — if already running          [macOS / MLX]
 *   2. mlx_lm.server (port 8765) — started on-demand         [macOS / MLX]
 *   3. Ollama (port 11434) — cross-platform, user-managed     [any OS]
 *
 * Commands:
 *   /privacy          — show current status
 *   /privacy on|off   — enable / disable the guard
 *   /privacy models   — list available local models
 *   /privacy reload   — re-probe servers & re-register provider
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { scanForPII } from "./scanner.js";
import { MlxServerManager } from "./mlx-server.js";
import { OllamaServerManager } from "./ollama-server.js";

const PROVIDER_MLX    = "privacy-guard-mlx";
const PROVIDER_OLLAMA = "privacy-guard-ollama";
const STATUS_ID       = "privacy-guard";

type Backend = "mlx" | "ollama" | null;

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let serverReady = false;
  let activeBackend: Backend = null;
  let startupPromise: Promise<void> | null = null;

  // Per-turn routing state
  let savedProvider: string | null = null;
  let savedModelId:  string | null = null;
  let routedToLocal = false;

  const mlx    = new MlxServerManager((msg) => console.error(msg));
  const ollama = new OllamaServerManager((msg) => console.error(msg));

  // ── Register local provider ──────────────────────────────────────────────────

  async function registerLocalProvider(ctx?: ExtensionContext): Promise<boolean> {
    // 1. Try MLX (omlx → mlx_lm.server)
    try {
      const { baseUrl, modelId } = await mlx.ensureRunning();

      pi.registerProvider(PROVIDER_MLX, {
        baseUrl,
        apiKey: "local",
        api: "openai-chat",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: modelId,
            name: `${modelId} (local MLX 🔒)`,
            reasoning: false,
            input: ["text"] as ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      });

      serverReady   = true;
      activeBackend = "mlx";
      const src = mlx.getStatus() === "omlx" ? "omlx" : "mlx_lm.server";
      ctx?.ui.notify(`[privacy-guard] Local MLX ready via ${src}: ${modelId}`, "info");
      return true;
    } catch (_mlxErr) {
      // MLX not available — fall through to Ollama
    }

    // 2. Try Ollama (cross-platform fallback)
    try {
      const { baseUrl, modelId } = await ollama.ensureRunning();

      pi.registerProvider(PROVIDER_OLLAMA, {
        baseUrl,
        apiKey: "local",
        api: "openai-chat",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: modelId,
            name: `${modelId} (Ollama 🔒)`,
            reasoning: false,
            input: ["text"] as ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      });

      serverReady   = true;
      activeBackend = "ollama";
      ctx?.ui.notify(`[privacy-guard] Ollama ready: ${modelId}`, "info");
      return true;
    } catch (ollamaErr) {
      serverReady   = false;
      activeBackend = null;
      ctx?.ui.notify(
        `[privacy-guard] No local backend available (MLX + Ollama both failed): ${ollamaErr}`,
        "warning"
      );
      return false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function activeProviderId(): string | null {
    if (activeBackend === "mlx")    return PROVIDER_MLX;
    if (activeBackend === "ollama") return PROVIDER_OLLAMA;
    return null;
  }

  function activeModelId(): string | null {
    if (activeBackend === "mlx")    return mlx.getActiveModel();
    if (activeBackend === "ollama") return ollama.getActiveModel();
    return null;
  }

  function backendLabel(): string {
    if (activeBackend === "mlx") {
      const src = mlx.getStatus() === "omlx" ? "omlx" : "mlx_lm.server";
      return `MLX (${src})`;
    }
    if (activeBackend === "ollama") return "Ollama";
    return "none";
  }

  // ── Startup ──────────────────────────────────────────────────────────────────

  startupPromise = registerLocalProvider().then(() => {
    startupPromise = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    await registerLocalProvider(ctx);
  });

  // ── Main hook: intercept prompt ──────────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;

    if (startupPromise) await startupPromise;

    if (!serverReady) {
      serverReady = await registerLocalProvider(ctx);
      if (!serverReady) return;
    }

    const scan = scanForPII(event.prompt);
    if (!scan.hasPII) return;

    const current = ctx.model;
    const providerId = activeProviderId();
    if (!providerId || current.provider === providerId) return;

    const localModelId = activeModelId();
    if (!localModelId) return;
    const localModel = ctx.modelRegistry.find(providerId, localModelId);
    if (!localModel) return;

    savedProvider = current.provider;
    savedModelId  = current.id;
    routedToLocal = true;

    const success = await pi.setModel(localModel);
    if (!success) {
      savedProvider = null;
      savedModelId  = null;
      routedToLocal = false;
      ctx.ui.notify("[privacy-guard] Failed to switch to local model", "error");
      return;
    }

    const emoji = scan.tier === "high" ? "🔴" : "🟡";
    const label = scan.reasons.join(", ");
    ctx.ui.setStatus(STATUS_ID, `${emoji} ${backendLabel()} — ${label}`);
    ctx.ui.notify(
      `🔒 Privacy Guard: routing to ${backendLabel()} — detected: ${label}`,
      "warning"
    );
  });

  // ── Restore original model after turn ───────────────────────────────────────

  pi.on("turn_end", async (_event, ctx) => {
    if (!routedToLocal || !savedProvider || !savedModelId) return;

    const original = ctx.modelRegistry.find(savedProvider, savedModelId);

    routedToLocal = false;
    savedProvider = null;
    savedModelId  = null;

    if (original) {
      await pi.setModel(original);
      ctx.ui.setStatus(STATUS_ID, undefined);
    }
  });

  // ── Shutdown ─────────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    mlx.stop();
    ollama.stop();
  });

  // ── Commands ─────────────────────────────────────────────────────────────────

  pi.registerCommand("privacy", {
    description: "Privacy Guard: show status, toggle on/off, list models, reload",
    handler: async (args, ctx) => {
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

      if (cmd === "reload") {
        serverReady   = false;
        activeBackend = null;
        mlx.stop();
        ollama.stop();
        await registerLocalProvider(ctx);
        return;
      }

      if (cmd === "models") {
        const lines = [
          "── MLX models (macOS / Apple Silicon) ──────────────────",
          "  mlx-community/Qwen3.5-9B-MLX-8bit       (~9.7 GB) ← default",
          "  mlx-community/Qwen3.5-4B-4bit           (~2.9 GB)",
          "  mlx-community/Qwen3-4B-4bit             (~2.1 GB)",
          "  mlx-community/Llama-3.2-3B-Instruct-4bit (~1.7 GB)",
          "  mlx-community/Llama-3.2-1B-Instruct-4bit (~0.7 GB)",
          "  mlx-community/Qwen3.5-0.8B-MLX-8bit     (~1 GB)",
          "",
          "── Ollama models (cross-platform fallback) ─────────────",
          "  qwen3.5:9b   qwen3.5:4b   qwen3.5:0.8b",
          "  qwen2.5:7b   qwen2.5:3b   qwen2.5:1.5b",
          "  llama3.2:3b  llama3.2:1b",
          "  (any model installed via: ollama pull <name>)",
          "",
          `Active backend : ${backendLabel()}`,
          `Active model   : ${activeModelId() ?? "none"}`,
          `Guard enabled  : ${enabled}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // Default: show status
      ctx.ui.notify(
        [
          `Privacy Guard  : ${enabled ? "✅ ON" : "⏸ OFF"}`,
          `Active backend : ${backendLabel()}`,
          `Active model   : ${activeModelId() ?? "not loaded"}`,
          `Server ready   : ${serverReady}`,
          "",
          "Commands: /privacy on | off | reload | models",
        ].join("\n"),
        "info"
      );
    },
  });
}
