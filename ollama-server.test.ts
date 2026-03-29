import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mock global fetch before importing the module
// ─────────────────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { OllamaServerManager } from "./ollama-server.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function modelsResponse(...ids: string[]) {
  return {
    ok: true,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  };
}

function failResponse() {
  return { ok: false, json: async () => ({}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("OllamaServerManager — initial state", () => {
  it("starts stopped with no active model", () => {
    const m = new OllamaServerManager(() => {});
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
    expect(m.getBaseUrl()).toContain("11434");
  });
});

describe("OllamaServerManager — ensureRunning()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("picks a preferred model when available", async () => {
    mockFetch.mockResolvedValueOnce(
      modelsResponse("qwen3.5:0.8b", "qwen3.5:9b", "llama3.2:1b")
    );
    const m = new OllamaServerManager(() => {});
    const result = await m.ensureRunning();

    // qwen3.5:9b is preferred over qwen3.5:0.8b
    expect(result.modelId).toBe("qwen3.5:9b");
    expect(result.baseUrl).toContain("11434");
    expect(m.getStatus()).toBe("running");
    expect(m.getActiveModel()).toBe("qwen3.5:9b");
  });

  it("picks the highest-priority model in preference order", async () => {
    // Only llama3.2:1b and qwen2.5:3b available
    mockFetch.mockResolvedValueOnce(modelsResponse("llama3.2:1b", "qwen2.5:3b"));
    const m = new OllamaServerManager(() => {});
    const result = await m.ensureRunning();
    // qwen2.5:3b comes before llama3.2:3b in preference list
    expect(result.modelId).toBe("qwen2.5:3b");
  });

  it("falls back to any non-cloud model when none in preference list", async () => {
    mockFetch.mockResolvedValueOnce(
      modelsResponse("custom-model:latest", "minimax-m2.5:cloud")
    );
    const m = new OllamaServerManager(() => {});
    const result = await m.ensureRunning();
    // cloud model is filtered; custom-model:latest is used
    expect(result.modelId).toBe("custom-model:latest");
    expect(m.getStatus()).toBe("running");
  });

  it("throws when Ollama returns no models", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    const m = new OllamaServerManager(() => {});
    await expect(m.ensureRunning()).rejects.toThrow(/no models/i);
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });

  it("throws when Ollama returns only cloud/remote models", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("minimax-m2.5:cloud", "other:remote"));
    const m = new OllamaServerManager(() => {});
    await expect(m.ensureRunning()).rejects.toThrow(/no usable/i);
    expect(m.getStatus()).toBe("stopped");
  });

  it("throws when Ollama is not running (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const m = new OllamaServerManager(() => {});
    await expect(m.ensureRunning()).rejects.toThrow(/not running/i);
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });

  it("throws when fetch returns non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(failResponse());
    const m = new OllamaServerManager(() => {});
    await expect(m.ensureRunning()).rejects.toThrow();
    expect(m.getStatus()).toBe("stopped");
  });

  it("throws on timeout", async () => {
    const err = new Error("The operation was aborted");
    err.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(err);
    const m = new OllamaServerManager(() => {});
    await expect(m.ensureRunning()).rejects.toThrow();
  });

  it("logs the chosen model", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("qwen3.5:4b"));
    const log = vi.fn();
    const m = new OllamaServerManager(log);
    await m.ensureRunning();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("qwen3.5:4b")
    );
  });
});

describe("OllamaServerManager — stop()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets state to stopped", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("qwen3.5:9b"));
    const m = new OllamaServerManager(() => {});
    await m.ensureRunning();
    expect(m.getStatus()).toBe("running");

    m.stop();
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });

  it("is safe to call when already stopped", () => {
    const m = new OllamaServerManager(() => {});
    expect(() => m.stop()).not.toThrow();
    expect(m.getStatus()).toBe("stopped");
  });

  it("can ensureRunning again after stop()", async () => {
    mockFetch
      .mockResolvedValueOnce(modelsResponse("qwen3.5:9b"))
      .mockResolvedValueOnce(modelsResponse("qwen3.5:4b"));

    const m = new OllamaServerManager(() => {});
    await m.ensureRunning();
    m.stop();

    const result = await m.ensureRunning();
    expect(result.modelId).toBe("qwen3.5:4b");
    expect(m.getStatus()).toBe("running");
  });
});

describe("OllamaServerManager — cloud/remote model filtering", () => {
  beforeEach(() => vi.clearAllMocks());

  it("excludes models with ':cloud' in the name", async () => {
    mockFetch.mockResolvedValueOnce(
      modelsResponse("minimax-m2.5:cloud", "qwen3.5:0.8b")
    );
    const m = new OllamaServerManager(() => {});
    const result = await m.ensureRunning();
    expect(result.modelId).toBe("qwen3.5:0.8b");
  });

  it("excludes models with 'remote' in the name", async () => {
    mockFetch.mockResolvedValueOnce(
      modelsResponse("some-remote-model", "llama3.2:1b")
    );
    const m = new OllamaServerManager(() => {});
    const result = await m.ensureRunning();
    expect(result.modelId).toBe("llama3.2:1b");
  });
});
