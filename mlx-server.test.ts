import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// We mock node:child_process and node:fs before importing the module.
// ─────────────────────────────────────────────────────────────────────────────

// Mock execSync to simulate model discovery / executable lookup
const mockExecSync = vi.fn();
// Mock spawn to simulate process management
const mockSpawn = vi.fn();
// Mock fetch globally
const mockFetch = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Replace global fetch
vi.stubGlobal("fetch", mockFetch);

// ─────────────────────────────────────────────────────────────────────────────
// Now import the module under test
// ─────────────────────────────────────────────────────────────────────────────
import { MlxServerManager } from "./mlx-server.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a mock EventEmitter-style child process */
function makeMockProc() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(cb);
      return proc;
    },
    kill: vi.fn((signal?: string) => {
      // Simulate the 'exit' event synchronously
      handlers["exit"]?.forEach((cb) => cb(0, signal ?? "SIGTERM"));
    }),
    _emit(event: string, ...args: unknown[]) {
      handlers[event]?.forEach((cb) => cb(...args));
    },
  };
  return proc;
}

/** Build a successful fetch response for /v1/models */
function modelsResponse(modelId: string) {
  return {
    ok: true,
    json: async () => ({ data: [{ id: modelId }] }),
  };
}

/** Build a failed fetch response */
function failResponse() {
  return { ok: false, json: async () => ({}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MlxServerManager — getStatus / getActiveModel initial state", () => {
  it("starts in stopped state with no active model", () => {
    const m = new MlxServerManager(() => {});
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });
});

describe("MlxServerManager — probe() via ensureRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses omlx (port 8123) when it responds", async () => {
    // omlx responds, mlx_lm doesn't
    mockFetch.mockResolvedValueOnce(modelsResponse("mlx-community/Qwen3.5-9B-MLX-8bit"));

    const m = new MlxServerManager(() => {});
    const result = await m.ensureRunning();

    expect(result.baseUrl).toContain("8123");
    expect(result.modelId).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");
    expect(m.getStatus()).toBe("omlx");
    expect(m.getActiveModel()).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");
  });

  it("falls back to mlx_lm (port 8765) when omlx is down", async () => {
    // omlx fails, mlx_lm responds
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))  // omlx probe fails
      .mockResolvedValueOnce(modelsResponse("mlx-community/Qwen3-4B-4bit")); // mlx_lm responds

    const m = new MlxServerManager(() => {});
    const result = await m.ensureRunning();

    expect(result.baseUrl).toContain("8765");
    expect(result.modelId).toBe("mlx-community/Qwen3-4B-4bit");
    expect(m.getStatus()).toBe("mlx_lm");
  });

  it("probe returns null when response is not ok — falls through to startServer", async () => {
    // omlx returns 500, mlx_lm returns 500 → neither probe succeeds → startServer called
    // Use mockImplementation to track call sequence (mockResolvedValue may not intercept poll)
    let callCount = 0;
    mockFetch.mockImplementation(async (_url: string) => {
      callCount++;
      if (callCount <= 2) return failResponse(); // first 2 probes fail
      return modelsResponse("mlx-community/Qwen3.5-9B-MLX-8bit"); // poll succeeds
    });

    // execSync: "which mlx_lm.server" throws (python3 fallback), cache checks succeed
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which mlx_lm.server")) throw new Error("not found");
      return ""; // model cache dirs exist
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    const m = new MlxServerManager(() => {});
    const result = await m.ensureRunning();

    expect(mockSpawn).toHaveBeenCalled();
    expect(result.modelId).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");
    expect(m.getStatus()).toBe("mlx_lm");
  }, 10000);

  it("probe returns null on network timeout — falls through to startServer", async () => {
    // Both initial probes reject (simulating timeout/network error)
    let callCount = 0;
    mockFetch.mockImplementation(async (_url: string) => {
      callCount++;
      if (callCount <= 2) {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        throw err;
      }
      return modelsResponse("mlx-community/Qwen3-4B-4bit");
    });

    // execSync: "which mlx_lm.server" throws (python3 fallback), cache checks succeed
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which mlx_lm.server")) throw new Error("not found");
      return ""; // model cache dirs exist
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    const m = new MlxServerManager(() => {});
    const result = await m.ensureRunning();

    expect(mockSpawn).toHaveBeenCalled();
    expect(result.modelId).toBe("mlx-community/Qwen3-4B-4bit");
    expect(m.getStatus()).toBe("mlx_lm");
  }, 10000);
});

describe("MlxServerManager — pickLocalModel() via ensureRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("picks the first model found in HuggingFace cache", async () => {
    // Both probes fail
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // First preferred model succeeds, rest not checked
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which mlx_lm.server")) return "/usr/local/bin/mlx_lm.server\n";
      if (cmd.includes("Qwen3.5-9B-MLX-8bit")) return ""; // model exists
      throw new Error("not found");
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    // Simulate server coming up after one poll
    let pollCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("8765")) {
        pollCount++;
        if (pollCount >= 1) return modelsResponse("mlx-community/Qwen3.5-9B-MLX-8bit");
      }
      return failResponse();
    });

    const m = new MlxServerManager(console.error);
    const result = await m.ensureRunning();

    expect(result.modelId).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");
    expect(m.getStatus()).toBe("mlx_lm");
  });

  it("falls back to a later model if the preferred one is not cached", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // Only the 3rd model (Qwen3-4B-4bit) is cached
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which mlx_lm.server")) return "/usr/local/bin/mlx_lm.server\n";
      if (
        cmd.includes("Qwen3.5-9B") ||
        cmd.includes("Qwen3.5-4B")
      ) {
        throw new Error("not found");
      }
      // Qwen3-4B-4bit and beyond succeed
      return "";
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    let pollCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("8765")) {
        pollCount++;
        if (pollCount >= 1) return modelsResponse("mlx-community/Qwen3-4B-4bit");
      }
      return failResponse();
    });

    const m = new MlxServerManager(console.error);
    const result = await m.ensureRunning();

    expect(result.modelId).toBe("mlx-community/Qwen3-4B-4bit");
  });

  it("throws when server fails to start within timeout (simulated)", async () => {
    // Both probes fail so we go to spawn path
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // execSync: "which" succeeds, model cache check succeeds
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which")) return "/usr/local/bin/mlx_lm.server\n";
      return ""; // model found
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    // All subsequent fetch calls to port 8765 fail permanently
    mockFetch.mockResolvedValue(failResponse());

    const m = new MlxServerManager(() => {});

    // Mock Date.now to immediately exceed the 60s deadline
    const realDateNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      if (callCount === 1) return realDateNow();
      return realDateNow() + 65_000; // exceed deadline immediately
    };

    try {
      await expect(m.ensureRunning()).rejects.toThrow(/failed to start/);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe("MlxServerManager — stop()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kills the managed process and resets state", async () => {
    // Get to mlx_lm state via ensureRunning with spawn
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which")) return "/usr/local/bin/mlx_lm.server\n";
      return ""; // model cached
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    let pollCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("8765")) {
        pollCount++;
        if (pollCount >= 1) return modelsResponse("mlx-community/Qwen3.5-9B-MLX-8bit");
      }
      return failResponse();
    });

    const m = new MlxServerManager(() => {});
    await m.ensureRunning();

    expect(m.getStatus()).toBe("mlx_lm");
    expect(m.getActiveModel()).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");

    m.stop();

    expect(mockProc.kill).toHaveBeenCalled();
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });

  it("is safe to call when no process is running", () => {
    const m = new MlxServerManager(() => {});
    expect(() => m.stop()).not.toThrow();
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });

  it("resets state to stopped even when using omlx", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("some-model"));

    const m = new MlxServerManager(() => {});
    await m.ensureRunning();
    expect(m.getStatus()).toBe("omlx");

    m.stop();

    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });
});

describe("MlxServerManager — getStatus / getActiveModel lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports omlx status when omlx server responds", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("qwen-model"));
    const m = new MlxServerManager(() => {});
    await m.ensureRunning();
    expect(m.getStatus()).toBe("omlx");
    expect(m.getActiveModel()).toBe("qwen-model");
  });

  it("reports mlx_lm status when mlx_lm responds", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(modelsResponse("llama-model"));
    const m = new MlxServerManager(() => {});
    await m.ensureRunning();
    expect(m.getStatus()).toBe("mlx_lm");
    expect(m.getActiveModel()).toBe("llama-model");
  });

  it("status goes back to stopped after stop()", async () => {
    mockFetch.mockResolvedValueOnce(modelsResponse("some-model"));
    const m = new MlxServerManager(() => {});
    await m.ensureRunning();
    m.stop();
    expect(m.getStatus()).toBe("stopped");
    expect(m.getActiveModel()).toBeNull();
  });
});

describe("MlxServerManager — spawn fallback (python3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to python3 when mlx_lm.server executable not found", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which mlx_lm.server")) throw new Error("not found");
      return ""; // model cached
    });

    const mockProc = makeMockProc();
    mockSpawn.mockReturnValue(mockProc);

    let pollCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("8765")) {
        pollCount++;
        if (pollCount >= 1) return modelsResponse("mlx-community/Qwen3.5-9B-MLX-8bit");
      }
      return failResponse();
    });

    const m = new MlxServerManager(() => {});
    const result = await m.ensureRunning();

    // Should have spawned with "python3"
    expect(mockSpawn).toHaveBeenCalled();
    const [exe, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(exe).toBe("python3");
    expect(args[0]).toBe("-m");
    expect(args[1]).toBe("mlx_lm.server");

    expect(result.modelId).toBe("mlx-community/Qwen3.5-9B-MLX-8bit");
  });
});
