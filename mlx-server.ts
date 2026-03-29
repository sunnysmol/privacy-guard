/**
 * MLX-LM server manager.
 *
 * Preference order:
 *   1. omlx  (port 8123) — multi-model production server, if already running
 *   2. mlx_lm.server (port 8765) — single-model, started on-demand
 *
 * The manager exposes:
 *   - ensureRunning()  → resolves to { baseUrl, modelId } or throws
 *   - stop()           → kill any process we started
 *   - getStatus()      → "omlx" | "mlx_lm" | "starting" | "stopped"
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";

export type ServerStatus = "omlx" | "mlx_lm" | "starting" | "stopped";

const OMLX_URL = "http://127.0.0.1:8123/v1";
const MLX_URL  = "http://127.0.0.1:8765/v1";
const MLX_PORT = 8765;

// Preferred local models — default first, fallbacks after
const PREFERRED_MODELS = [
  "mlx-community/Qwen3.5-9B-MLX-8bit",        // 9.7 GB — default
  "mlx-community/Qwen3.5-4B-4bit",            // 2.9 GB
  "mlx-community/Qwen3-4B-4bit",              // 2.1 GB
  "mlx-community/Llama-3.2-3B-Instruct-4bit", // 1.7 GB
  "mlx-community/Llama-3.2-1B-Instruct-4bit", // 0.68 GB
  "mlx-community/Qwen3.5-0.8B-MLX-8bit",      // 0.98 GB — last resort
];

// Map HF repo id → local cache path
function hfCachePath(repoId: string): string {
  const name = "models--" + repoId.replace("/", "--");
  return `${process.env.HOME}/.cache/huggingface/hub/${name}`;
}

async function probe(url: string): Promise<{ modelId: string } | null> {
  try {
    const res = await fetch(`${url}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: string }[] };
    const first = json.data?.[0]?.id;
    return first ? { modelId: first } : null;
  } catch {
    return null;
  }
}

function pickLocalModel(): string | null {
  for (const model of PREFERRED_MODELS) {
    try {
      const path = hfCachePath(model);
      execSync(`test -d "${path}/snapshots"`, { stdio: "ignore" });
      return model;
    } catch {
      // not cached
    }
  }
  return null;
}

export class MlxServerManager {
  private proc: ChildProcess | null = null;
  private status: ServerStatus = "stopped";
  private activeModel: string | null = null;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  getStatus(): ServerStatus { return this.status; }
  getActiveModel(): string | null { return this.activeModel; }

  /**
   * Ensure a local MLX server is running.
   * Returns { baseUrl, modelId } when ready, throws on failure.
   */
  async ensureRunning(): Promise<{ baseUrl: string; modelId: string }> {
    // 1. Check omlx first (already running externally)
    const omlx = await probe(OMLX_URL);
    if (omlx) {
      this.status = "omlx";
      this.activeModel = omlx.modelId;
      this.log(`[privacy-guard] Using existing omlx server: ${omlx.modelId}`);
      return { baseUrl: OMLX_URL, modelId: omlx.modelId };
    }

    // 2. Check mlx_lm.server (maybe we started it earlier)
    const existing = await probe(MLX_URL);
    if (existing) {
      this.status = "mlx_lm";
      this.activeModel = existing.modelId;
      this.log(`[privacy-guard] Using existing mlx_lm server: ${existing.modelId}`);
      return { baseUrl: MLX_URL, modelId: existing.modelId };
    }

    // 3. Start mlx_lm.server ourselves
    const model = pickLocalModel();
    if (!model) {
      throw new Error(
        "No local MLX model found in HuggingFace cache. " +
        "Run: python3 -m mlx_lm.convert --hf-path mlx-community/Qwen3-4B-4bit -q"
      );
    }

    return this.startServer(model);
  }

  private async startServer(model: string): Promise<{ baseUrl: string; modelId: string }> {
    this.status = "starting";
    this.log(`[privacy-guard] Starting mlx_lm.server with ${model} on port ${MLX_PORT}…`);

    // Find mlx_lm.server executable
    let executable: string;
    try {
      executable = execSync("which mlx_lm.server", { encoding: "utf8" }).trim();
    } catch {
      // fallback: python -m mlx_lm.server
      executable = "python3";
    }

    const args = executable.endsWith("mlx_lm.server")
      ? ["--model", model, "--port", String(MLX_PORT), "--host", "127.0.0.1", "--log-level", "WARNING"]
      : ["-m", "mlx_lm.server", "--model", model, "--port", String(MLX_PORT), "--host", "127.0.0.1", "--log-level", "WARNING"];

    this.proc = spawn(executable, args, {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });

    this.proc.on("exit", (code) => {
      this.log(`[privacy-guard] mlx_lm.server exited (code ${code})`);
      this.proc = null;
      this.status = "stopped";
      this.activeModel = null;
    });

    // Poll until server responds (up to 60s — model load can take time)
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const up = await probe(MLX_URL);
      if (up) {
        this.status = "mlx_lm";
        this.activeModel = up.modelId;
        this.log(`[privacy-guard] mlx_lm.server ready: ${up.modelId}`);
        return { baseUrl: MLX_URL, modelId: up.modelId };
      }
    }

    this.proc.kill();
    this.proc = null;
    this.status = "stopped";
    throw new Error(`mlx_lm.server failed to start within 60s (model: ${model})`);
  }

  stop() {
    if (this.proc) {
      this.log("[privacy-guard] Stopping mlx_lm.server…");
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.status = "stopped";
    this.activeModel = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
