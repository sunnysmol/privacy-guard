# privacy-guard

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that automatically routes prompts containing personal/sensitive data to a **local model** instead of a cloud provider — keeping your PII off the internet.

## How it works

When you send a prompt, privacy-guard scans it for PII before it reaches the LLM. If anything sensitive is detected, the extension silently switches to a local model for that turn, then restores your original cloud model afterwards.

```
user prompt (contains PII)
  → scanner detects PII
  → switch to local model
  → local model generates response   ← cloud never sees your data
  → restore original cloud model
user sees response
```

The output is rendered **entirely locally** — the PII prompt and the response never leave your machine.

## Fallback chain

The extension tries backends in order, using the first one available:

| Priority | Backend | Port | Platform |
|----------|---------|------|----------|
| 1 | omlx server | 8123 | macOS / Apple Silicon |
| 2 | mlx_lm.server (started on-demand) | 8765 | macOS / Apple Silicon |
| 3 | Ollama | 11434 | **Any OS** (Linux, Windows, macOS) |

If no local backend is available, a warning is shown and the prompt proceeds to the cloud model unchanged.

## What gets detected

**HIGH confidence** (🔴) — always redirected to local:
- Email addresses
- Social Security Numbers (SSN)
- Credit / debit card numbers
- Private keys (`-----BEGIN ... PRIVATE KEY-----`)
- Password literals (`password=`, `passwd:`, `pwd=`)
- API keys / secrets / access tokens
- AWS access key IDs (`AKIA...`)
- US phone numbers
- Private IP addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x)

**MEDIUM confidence** (🟡) — also redirected to local:
- Street addresses / "my home address"
- Date of birth / DOB / birthday
- Passport / national ID / driver's licence
- Medical records / prescriptions / health insurance
- Bank accounts / routing numbers / IBAN / salary
- Login credentials / username / sign-in details
- Biometrics (fingerprint, Face ID, Touch ID)

## Installation

### Via pi (recommended)

```bash
pi install npm:@sunnysmol/privacy-guard
```

> **Note:** This package is published on GitHub Packages. You need to authenticate with GitHub first:
> ```bash
> npm login --registry https://npm.pkg.github.com
> # username: your GitHub username
> # password: a GitHub token with read:packages scope
> ```

Then restart pi or run `/reload`.

### Via git (no auth needed)

```bash
pi install git:github.com/sunnysmol/privacy-guard
```

### Manual

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/sunnysmol/privacy-guard
cd privacy-guard
npm install
```

Then restart pi or run `/reload`.

## Local model setup

### macOS / Apple Silicon (MLX)

Install [mlx-lm](https://github.com/ml-explore/mlx-examples/tree/main/llms) and download a model:

```bash
pip install mlx-lm
python3 -m mlx_lm.convert --hf-path mlx-community/Qwen3-4B-4bit -q
```

Or use [omlx](https://github.com/badlogic/omlx) for a multi-model server — if it's running on port 8123, privacy-guard will use it automatically.

Preferred MLX models (default → fallback):

| Model | Size |
|-------|------|
| mlx-community/Qwen3.5-9B-MLX-8bit | ~9.7 GB |
| mlx-community/Qwen3.5-4B-4bit | ~2.9 GB |
| mlx-community/Qwen3-4B-4bit | ~2.1 GB |
| mlx-community/Llama-3.2-3B-Instruct-4bit | ~1.7 GB |
| mlx-community/Llama-3.2-1B-Instruct-4bit | ~0.7 GB |
| mlx-community/Qwen3.5-0.8B-MLX-8bit | ~1.0 GB |

### Any OS (Ollama)

Install [Ollama](https://ollama.com) and pull a model:

```bash
ollama pull qwen3.5:4b   # or any model from the list below
ollama serve             # starts the server on port 11434
```

Preferred Ollama models (default → fallback):

| Model | Notes |
|-------|-------|
| qwen3.5:9b | Best quality |
| qwen3.5:4b | Good balance |
| qwen3.5:0.8b | Fastest / smallest |
| qwen2.5:7b | |
| qwen2.5:3b | |
| qwen2.5:1.5b | |
| llama3.2:3b | |
| llama3.2:1b | Minimum footprint |

Any other locally-installed Ollama model will be used as a last resort (cloud/remote models are excluded).

## Commands

| Command | Description |
|---------|-------------|
| `/privacy` | Show current status (backend, model, enabled state) |
| `/privacy on` | Enable the guard |
| `/privacy off` | Disable the guard (cloud sees all data) |
| `/privacy models` | List available local models for both MLX and Ollama |
| `/privacy reload` | Re-probe servers and re-register provider |

## Running tests

```bash
npm test
```

106 tests across 4 files:
- `scanner.test.ts` — PII pattern detection (HIGH/MEDIUM tiers, edge cases)
- `mlx-server.test.ts` — MLX server manager (probe, spawn, model discovery, stop)
- `ollama-server.test.ts` — Ollama server manager (model selection, filtering, lifecycle)
- `index.test.ts` — Extension hook logic (routing decisions, model restore, commands)

## License

MIT
