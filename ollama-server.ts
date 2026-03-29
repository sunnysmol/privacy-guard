/**
 * Ollama server manager.
 *
 * Ollama speaks the OpenAI-compatible chat API at http://127.0.0.1:11434/v1.
 * It runs as an always-on daemon managed by the user — we never start or stop it.
 *
 * Preferred local models (first match wins):
 *   - qwen3.5:9b   — best quality, ~6.6 GB
 *   - qwen3.5:4b
 *   - qwen3.5:0.8b
 *   - qwen2.5:7b
 *   - qwen2.5:3b
 *   - qwen2.5:1.5b
 *   - llama3.2:3b
 *   - llama3.2:1b
 *   - (any other model returned by Ollama as fallback)
 */

export type OllamaStatus = "running" | "stopped";

const OLLAMA_URL = "http://127.0.0.1:11434/v1";

// Ordered preference list — first available model wins.
// Model names must exactly match what `ollama list` / GET /v1/models returns.
const PREFERRED_MODELS = [
  "qwen3.5:9b",
  "qwen3.5:4b",
  "qwen3.5:0.8b",
  "qwen2.5:7b",
  "qwen2.5:3b",
  "qwen2.5:1.5b",
  "llama3.2:3b",
  "llama3.2:1b",
];

async function listModels(): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: string }[] };
    return json.data?.map((m) => m.id) ?? null;
  } catch {
    return null;
  }
}

function pickModel(available: string[]): string | null {
  // Try preferred models in order
  for (const preferred of PREFERRED_MODELS) {
    if (available.includes(preferred)) return preferred;
  }
  // Fallback: use whatever Ollama has, skipping cloud/remote models
  // (remote models have size 0 or no gguf format — filter them out heuristically
  // by avoiding models whose name contains ":cloud" or "remote")
  const local = available.filter(
    (id) => !id.includes(":cloud") && !id.includes("remote")
  );
  return local[0] ?? null;
}

export class OllamaServerManager {
  private status: OllamaStatus = "stopped";
  private activeModel: string | null = null;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  getStatus(): OllamaStatus { return this.status; }
  getActiveModel(): string | null { return this.activeModel; }
  getBaseUrl(): string { return OLLAMA_URL; }

  /**
   * Check if Ollama is running and pick the best available model.
   * Returns { baseUrl, modelId } or throws if Ollama is not available.
   */
  async ensureRunning(): Promise<{ baseUrl: string; modelId: string }> {
    const models = await listModels();

    if (!models || models.length === 0) {
      this.status = "stopped";
      this.activeModel = null;
      throw new Error(
        "Ollama is not running or has no models. " +
        "Start it with: ollama serve"
      );
    }

    const model = pickModel(models);
    if (!model) {
      this.status = "stopped";
      this.activeModel = null;
      throw new Error("Ollama has no usable local models.");
    }

    this.status = "running";
    this.activeModel = model;
    this.log(`[privacy-guard] Using Ollama model: ${model}`);
    return { baseUrl: OLLAMA_URL, modelId: model };
  }

  /** Reset state (no process to kill — Ollama is user-managed). */
  stop() {
    this.status = "stopped";
    this.activeModel = null;
  }
}
