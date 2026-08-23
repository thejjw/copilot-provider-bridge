# Copilot Provider Bridge

Enables **VS Code Copilot AI features** for users via existing third-party AI coding plans and LLM subscriptions — without requiring a GitHub Copilot subscription. Builds on VS Code 1.122's stable **Custom Endpoint** BYOK provider (OpenAI Chat Completions / Anthropic Messages) and native Model Context Protocol (MCP) support.

## What it does

1. **Quick Setup Wizard**: On first install (or via Command Palette), guides you through selecting your coding plans and companion MCP tools in one streamlined flow.
2. **Language Models**: Wires Anthropic-Messages and OpenAI-compatible coding plans into VS Code Copilot Chat's model picker via `%APPDATA%\Code\User\chatLanguageModels.json` (Windows) / `~/.config/Code/User/chatLanguageModels.json` (Linux) / `~/Library/Application Support/Code/User/chatLanguageModels.json` (macOS).
3. **Built-in Vision Agent Tool**: Allows pure text-only models (like `GLM-5.3` and `DeepSeek V4 Pro`) to automatically delegate screenshot, UI mockup, and diagram inspection to any configured multimodal backend (`GLM-4.6V`, `GLM-5V-Turbo`, `Gemini 2.5 Flash`, `MiniMax M3`, `Kimi K3`, `Qwen 3.8 Max`).
4. **Companion MCP Tools**: Configures verified MCP tool presets (`web-search-prime`, `web-reader`, `zread`, `zai-mcp-server`, `minimax-mcp`) grouped by provider into user or workspace `mcp.json` with safe `inputs` array definitions.
5. **Status Bar Quota Indicator & Rich Dashboard Tooltip**:
   - **Status Bar**: Renders bundled offline **Datatype pie chart icons** with exact 1% granularity (`$(copilot-provider-bridge-p<pct>) <pct>%`) for percentage plans (Z.ai, Kimi) or exact balance (e.g. `¥123.45`) for currency models. The badge shows only the provider you **explicitly select** — VS Code exposes no API to detect which chat model is active, so there is deliberately no auto-select guessing. When no provider is selected, a neutral placeholder is shown and the hover tooltip still lists all configured plans.
   - **Hover Dashboard Tooltip**: Live Markdown dashboard with dynamic high-resolution SVG progress meters, multi-window reset countdowns (5-hour rolling window + weekly membership allowance), and clickable action triggers (`[🔄 Refresh]`, `[📌 Select / Clear]`, `[🔑 Configure Keys]`, `[🩺 Diagnostics]`).
6. **Diagnostics & Factory Reset**: Built-in connectivity testing command and a 1-click factory reset command (`Copilot Provider Bridge: Reset All Configuration & Clear Secrets`) to wipe extension secrets, reset global state, and purge bridge model/MCP configurations safely.

## Providers & Supported Models

| Provider | Plan Type | Protocol | Endpoint | Models | Context Window | Max Output | Thinking? | Vision? |
|---|---|---|---|---|---|---|---|---|
| **Z.ai GLM** | Coding Plan (Sub) | Anthropic | `https://api.z.ai/api/anthropic/v1/messages` | `glm-5.3` | 1,000,000 (1M) | 131,072 (128K) | `low`, `high`, `max` | No |
| **Z.ai GLM** | Coding Plan (Sub) | Anthropic | `https://api.z.ai/api/anthropic/v1/messages` | `glm-4.7` | 202,752 (~200K) | 65,535 (64K) | Forced Thinking | No |
| **Z.ai GLM** | Coding Plan (Sub) | OpenAI | `https://api.z.ai/api/coding/paas/v4/chat/completions` | `glm-5v-turbo` | 202,752 (~200K) | 131,072 (128K) | Dynamic Thinking | Yes |
| **DeepSeek** | Top-up / Payg | Anthropic | `https://api.deepseek.com/anthropic/v1/messages` | `deepseek-v4-pro`, `deepseek-v4-flash` | 1,000,000 (1M) | 393,216 (384K) | `low`, `medium`, `high` | No |
| **MiniMax** | Token Plan (Sub) | Anthropic | `https://api.minimax.io/anthropic/v1/messages` | `MiniMax-M3` | 1,000,000 (1M) | 131,072 (128K) | `low`, `medium`, `high` | Yes |
| **Kimi** | Code Plan (Sub) | Anthropic | `https://api.kimi.com/coding/v1/messages` | `k3` | 1,048,576 (1M) | 131,072 (128K) | `low`, `high`, `max` | Yes |
| **Kimi** | Code Plan (Sub) | Anthropic | `https://api.kimi.com/coding/v1/messages` | `k3-256k` | 262,144 (256K) | 65,536 (64K) | `low`, `high`, `max` | Yes |
| **Kimi** | Code Plan (Sub) | Anthropic | `https://api.kimi.com/coding/v1/messages` | `kimi-for-coding` | 262,144 (256K) | 65,536 (64K) | Forced Thinking | Yes |
| **Kimi** | Code Plan (Sub) | Anthropic | `https://api.kimi.com/coding/v1/messages` | `kimi-for-coding-highspeed` | 262,144 (256K) | 65,536 (64K) | Forced Thinking (6× Speed) | Yes |
| **Qwen Token Plan** | Token Plan (Sub) | Anthropic | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages` | `qwen3.8-max` | 1,000,000 (1M) | 131,072 (128K) | `low`, `medium`, `high` | Yes |
| **Qwen Token Plan** | Token Plan (Sub) | Anthropic | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages` | `qwen3.7-plus` | 262,144 (256K) | 32,768 (32K) | `low`, `medium`, `high` | Yes |
| **Qwen Token Plan** | Token Plan (Sub) | Anthropic | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages` | `qwen3.6-flash` | 128,000 (128K) | 16,384 (16K) | No | No |
| ~~**Google Gemini**~~ | ~~*Top-up / Payg*~~ | ~~*OpenAI*~~ | ~~`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`~~ | ~~`gemini-3.7-flash`, `gemini-2.5-flash`~~ | ~~1M~~ | ~~64K~~ | *Disabled for now — requires Google AI Studio billing quota* | ~~Yes~~ |
| **OpenRouter** | Router / Payg / Free | OpenAI | `https://openrouter.ai/api/v1/chat/completions` | `openrouter/free` (Zero-cost), `openrouter/auto` | 128K–200K | 16K | `low`, `medium`, `high` (auto) | Yes |
| **NVIDIA NIM** | API Plan / Payg | OpenAI | `https://integrate.api.nvidia.com/v1/chat/completions` | `meta/muse-glimmer-30b`, `z-ai/glm-5.2`, `thinkingmachines/inkling`, `poolside/laguna-xs-2.1`, `minimaxai/minimax-m3`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b` | 128K–1M | 16K–128K | `low`, `medium`, `high` (M3) | Yes (Muse, Inkling, M3) |

## Vision Agent Backends (Automatic Image Delegation)

When using a text-only model (like `GLM-5.3` or `DeepSeek V4 Pro`), the built-in **Vision Agent Tool** (`provider_bridge_analyze_visual`) delegates image analysis to any of the following multimodal backends:

| Backend Model | Provider | Type | Description |
|---|---|---|---|
| **GLM-4.6V** | Z.ai | OpenAI Chat | Dedicated OCR and diagram analysis model |
| **GLM-5V-Turbo** | Z.ai | OpenAI Chat | Frontier multimodal coding foundation model |
| ~~**Gemini 2.5 Flash**~~ | ~~Google~~ | ~~OpenAI Chat~~ | *Disabled for now — requires Google AI Studio billing quota* |
| ~~**Gemini 3.7 Flash**~~ | ~~Google~~ | ~~OpenAI Chat~~ | *Disabled for now — requires Google AI Studio billing quota* |
| **MiniMax M3** | MiniMax | OpenAI Chat | 1M context multimodal model |
| **Kimi K3** | Moonshot | Anthropic Messages | 1M context multimodal model |
| **Qwen 3.8 Max** | Alibaba | Anthropic Messages | Flagship multimodal model |
| **Muse Glimmer 30B** | NVIDIA / Meta | OpenAI Chat | High-speed 131K vision model on NVIDIA NIM |
| **Inkling** | NVIDIA / TM | OpenAI Chat | Vision and reasoning model on NVIDIA NIM |

Switch your preferred vision model at any time with **`Copilot Provider Bridge: Select Vision Agent Model`**.

## Companion MCP Tool Presets (Grouped by Provider)

| Provider | Tool Preset | Type | Endpoint / Command | Capability |
|---|---|---|---|---|
| **Z.ai** | **Web Search Prime** | HTTP SSE | `https://api.z.ai/api/mcp/web_search_prime/mcp` | Real-time web search for all models |
| **Z.ai** | **Web Reader** | HTTP SSE | `https://api.z.ai/api/mcp/web_reader/mcp` | URL-to-markdown and web page reading |
| **Z.ai** | **zread** | HTTP SSE | `https://api.z.ai/api/mcp/zread/mcp` | GitHub documentation & repo search |
| **Z.ai** | **Z.ai MCP Server** | stdio (npx) | `@z_ai/mcp-server` | Diagram understanding & OCR analysis |
| **MiniMax** | **MiniMax MCP** | stdio (uvx) | `minimax-coding-plan-mcp` | MiniMax search & image processing |

## Tool-Calling, Web Search & Vision Input Behavior

Copilot Provider Bridge configures models and tools for VS Code's native BYOK engine (`chatLanguageModels.json` and `mcp.json`). VS Code communicates directly with your providers without proxying. Tool execution and multimodal routing follow standard VS Code Copilot rules:

### 1. Web Search & Fetching
- **Built-in VS Code Web Tools (`#web`)**:
  - All capable models in the catalog are configured with `"toolCalling": true`, enabling VS Code Copilot Chat's tool integration.
  - When the built-in Web Search / Fetch tool is enabled in VS Code's **Configure Tools** (⚙️) menu, the model can emit standard tool calls to search the web or fetch URLs (autonomously or explicitly via `#web` in prompts).
  - The model emits a tool-call request, VS Code executes the web fetch in the background, feeds results back into the model's context window, and the model synthesizes the answer with citations.
- **Dedicated Companion MCP Search & Extraction Tools**:
  - Installing companion MCP tool presets via `Copilot Provider Bridge: Configure MCP Tools` adds direct-to-provider search pipelines:
    - `web-search-prime` & `minimax-mcp`: Direct provider search APIs authenticated via your own API keys.
    - `web-reader`: Deep web page reader that converts URLs into clean, LLM-friendly Markdown.
    - `zread`: Specialized documentation, issue, and GitHub repository search.

### 2. Vision & Multimodal Inputs (Text-Only vs. Multimodal Models)
- **Native Multimodal Models (`vision: true`)**:
  - Models like `glm-5v-turbo`, `MiniMax-M3`, `k3`, `qwen3.8-max`, `qwen3.7-plus`, `gemini-3.7-flash`, `gemini-2.5-pro`, and `gemini-2.5-flash` natively support image inputs.
  - You can drag-and-drop screenshots, mockups, and images directly into the chat prompt. The image payload is forwarded directly to the provider's multimodal endpoint.
- **Text-Only Coding Models (`vision: false`) + Vision Agent Tool**:
  - Frontier coding models like `glm-5.3`, `glm-4.7`, `deepseek-v4-pro`, `deepseek-v4-flash`, and `qwen3.6-flash` are text-specialized.
  - When visual analysis is needed (e.g. analyzing a UI screenshot, chart, or layout mockup), prompt the model with the image path or URL:
    > *"Inspect the UI screenshot in `./assets/mockup.png` and generate the matching Tailwind CSS components."*
  - The text-only model automatically invokes the built-in **Vision Agent Tool** (`provider_bridge_analyze_visual`), which queries your configured vision backend (`GLM-4.6V`, `Gemini 2.5 Flash`, etc.) and feeds structured OCR and layout analysis back into the coding session within its full context window (up to 1M on GLM-5.3 and DeepSeek V4 Pro, ~200K on GLM-4.7, 128K on Qwen 3.6 Flash).

## Editable Provider Catalog

The entire model catalog — providers, endpoints, token limits, vision backends, and MCP presets — can be overridden by a single user-editable file, so provider changes no longer wait on an extension release.

- **File**: `copilot-provider-bridge.jsonc` in your VS Code user directory (`%APPDATA%\Code\User\` on Windows, `~/.config/Code/User/` on Linux, `~/Library/Application Support/Code/User/` on macOS), next to `chatLanguageModels.json`.
- **Opt-in**: with no file present, bundled defaults are used. **`Copilot Provider Bridge: Customize Provider Catalog`** writes a commented template from those defaults and opens it; from then on the file wins.
- **Whole-section override**: each present top-level section (`providers`, `visionBackends`, `mcpPresets`) fully replaces the bundled defaults for that section; delete a section or the whole file to fall back. No deep merging happens.
- **Live reload**: the file is watched — save to apply changes without restarting VS Code. Invalid files are rejected with a warning (line/column reported) while the last-good catalog keeps serving.
- **IntelliSense**: a JSON Schema ships with the extension (`contributes.jsonValidation`), giving completions, hovers, and validation directly in the editor.
- **Derived fields**: `maxInputTokens = contextWindow - maxOutputTokens` and `secretInput = copilot-provider-bridge.<id>.apiKey` are computed when omitted. API keys are never stored in this file — they live in SecretStorage / `chatLanguageModels.json` exactly as before.
- **Usage tracking contract**: quota polling exists only for built-in ids with usage fetchers (`zai`, `deepseek`, `minimax`, `kimi`, `openrouter`) plus the NVIDIA stub. Custom providers serve models fine but show no quota badge; renaming a built-in `id` disables its usage tracking (renaming `name`/`description` is always safe).
- **Updates**: after updating the extension with an existing catalog file, a one-time notice points you to **Migrate Provider Catalog to Latest Defaults** — it backs up your file (newest 3 kept), regenerates a fresh template from the newest verified defaults, and opens both side-by-side for manual porting. No silent auto-merge ever touches your edits. **Reset Provider Catalog to Defaults** deletes the file for a clean restart.

## Commands

- **Copilot Provider Bridge: Quick Setup (Models & MCP Tools)** — run the first-time setup wizard to configure multiple providers and companion MCP tools in one pass.
- **Copilot Provider Bridge: Add Model** — pick a single provider, select models, and optionally install companion MCP tools.
- **Copilot Provider Bridge: Remove Model** — select an installed provider group and remove it.
- **Copilot Provider Bridge: List Models** — inspect installed models, endpoints, and token limits.
- **Copilot Provider Bridge: Configure MCP Tools** — select target (User Profile Global or Workspace `.vscode/mcp.json`) and choose MCP presets grouped by provider.
- **Copilot Provider Bridge: Remove MCP Server** — choose an MCP server to remove from configuration.
- **Copilot Provider Bridge: Configure Usage API Key** — securely store or update provider keys in extension SecretStorage for live status bar quota polling.
- **Copilot Provider Bridge: Select Status Bar Provider** — choose which provider's usage badge appears in the bottom status bar (or clear it for a neutral placeholder).
- **Copilot Provider Bridge: Refresh Plan Quotas & Balances** — query all active provider endpoints and update the status bar tooltip.
- **Copilot Provider Bridge: Select Vision Agent Model** — choose which multimodal model powers automatic visual analysis for text-only coding models.
- **Copilot Provider Bridge: Run Diagnostics & Connectivity Test** — test connectivity to all configured model endpoints and print a detailed report to the Output Channel.
- **Copilot Provider Bridge: Show Debug Output Logs** — open the dedicated Copilot Provider Bridge output log channel.
- **Copilot Provider Bridge: Toggle Debug Logging** — toggle verbose debug logging on or off.
- **Copilot Provider Bridge: Reset All Configuration & Clear Secrets** — reset all Copilot Provider Bridge settings, clear stored secrets in SecretStorage, and clean up bridge models and companion MCP servers.

- **Copilot Provider Bridge: Customize Provider Catalog (Editable Models & Endpoints)** — create (or recreate) the editable catalog file from the bundled defaults and open it.
- **Copilot Provider Bridge: Open Provider Catalog File** — reveal the catalog file, offering creation if absent.
- **Copilot Provider Bridge: Reload Provider Catalog** — force a re-read of the catalog file.
- **Copilot Provider Bridge: Migrate Provider Catalog to Latest Defaults** — back up the current file, regenerate from newest defaults, open both for manual porting.
- **Copilot Provider Bridge: Reset Provider Catalog to Defaults (Delete Customizations)** — delete the catalog file and revert to bundled defaults.

## Requirements

- **VS Code 1.122 or later** (Custom Endpoint provider went Stable May 28 2026).
- **GitHub Copilot Chat** extension installed.
- An API key for one of the providers above.

## Install (sideload)

```bash
git clone https://github.com/thejjw/copilot-provider-bridge
cd copilot-provider-bridge
npm install
npm run package
code --install-extension copilot-provider-bridge-0.1.7.vsix
```

### Upgrading from v0.1.0

Version 0.1.1 uses the new extension ID `thejjw.copilot-provider-bridge`. Before uninstalling the
former `thejjw.copilot-bridge` extension, run its **Reset All Configuration & Clear Secrets** command
to remove generated model/MCP configuration and stored keys. Install v0.1.1, then re-enter any API
keys because VS Code SecretStorage data is scoped to the extension ID.

## Security & Credential Storage Architecture

### 1. How Credentials Work in VS Code BYOK (Custom Endpoint)
- **Configuration Storage**: VS Code's native Custom Endpoint engine reads provider definitions and authentication headers directly from the user's private configuration file:
  - **Windows**: `%APPDATA%\Code\User\chatLanguageModels.json`
  - **macOS**: `~/Library/Application Support/Code/User/chatLanguageModels.json`
  - **Linux**: `~/.config/Code/User/chatLanguageModels.json`
- **Technical Constraint**: Because VS Code's Custom Endpoint system currently reads HTTP request headers directly from this user-scoped file without bridging across extension sandboxes, configured API keys are written into your personal `chatLanguageModels.json` (`Authorization: Bearer <key>`) so that Copilot Chat can dispatch model requests immediately.
- **File Scope & Access**:
  - `chatLanguageModels.json` resides exclusively within your local OS user profile, protected by standard OS user account access controls.
  - It is **never committed to any git repository** or shared workspace folder.

### 2. Extension SecretStorage & Privacy Safeguards
- **Encrypted Background Storage**: API keys validated during setup are concurrently stored in VS Code's encrypted `SecretStorage` (`context.secrets` via Windows DPAPI, macOS Keychain, or Linux Secret Service) for local quota polling, status bar usage indicators, and diagnostic connectivity probes.
- **Zero Intermediate Proxy / Zero-Telemetry**: Copilot Provider Bridge does not proxy, intercept, or relay your chat traffic. All chat requests travel directly from VS Code to official provider endpoints over encrypted HTTPS/TLS.
- **Log Sanitization**: All keys are automatically redacted in extension logs and Output Channel messages (`Logger.maskSecret()` $\rightarrow$ `1234...567`). Connectivity diagnostics proactively sanitize any reflected credentials from upstream error responses.
- **Factory Reset**: You can clear all extension secrets and purge bridge configurations at any time via the Command Palette: **`Copilot Provider Bridge: Reset All Configuration & Clear Secrets`**.

### 3. Known Limitations & Security Tradeoffs
- **Why Plaintext on Disk Is Required in Current VS Code**:
  - Standard VS Code releases (tested through 1.133) do not expose a public API for third-party extensions to deposit secrets into VS Code Core's internal Custom Endpoint vault, nor is there an extension-callable command to open a provider-specific secret seeding dialog.
  - Consequently, Copilot Provider Bridge writes credentials into `chatLanguageModels.json` to enable automated setup and immediate chat execution without manual JSON hacking.
- **Exposure Scope**:
  - Encrypted `SecretStorage` protects the extension's background fetcher copies, but **does not encrypt the working JSON file on disk**.
  - Any script, process, or application running under your local OS user account (as well as unencrypted user profile backups or roaming profile syncs) can read `chatLanguageModels.json`.
- **Security Best Practices & Key Rotation**:
  - Use scoped API keys with spending limits or coding-plan specific sub-keys when available from your provider.
  - If your workstation user profile or backup storage is ever exported or compromised, rotate your provider API keys immediately.
  - Use **`Copilot Provider Bridge: Reset All Configuration & Clear Secrets`** to purge all stored credentials and bridge definitions from your machine.
- **Future Roadmap**:
  - If VS Code introduces an extension-accessible secret bridge for Custom Endpoints, or if Copilot Provider Bridge implements an in-process `vscode.lm.registerLanguageModelChatProvider` runtime streaming provider, credentials can be held exclusively in memory and `context.secrets`.
  - **Status bar auto-select** (removed): the badge previously tried to guess the active provider from quota shape, which was deterministic-but-wrong (it always picked the first configured percentage plan). If VS Code ever exposes an API to observe the currently selected chat model (e.g. an `onDidChangeChatModel` event or a readable `chat.selectedModel` context), auto-select can return as a *true* active-model tracker rather than a heuristic.

## How it works

1. **Models**: Writes `chatLanguageModels.json` with `vendor: customendpoint`, verified token limits (`maxInputTokens + maxOutputTokens = contextWindow`), model-level thinking configuration, and model-level auth header overrides (`requestHeaders: { "Authorization": "Bearer <apiKey>" }`).
2. **MCP**: Writes `mcp.json` with top-level `inputs` array definitions and server maps, strictly preserving all existing top-level fields (such as `sandbox` or custom properties).
3. **Vision Agent**: Built-in Language Model Tool automatically delegates visual tasks from text-only models to your preferred multimodal model backend.
4. **Usage**: Securely manages keys in extension SecretStorage (`context.secrets`) to poll active quota endpoints in background (Z.ai, DeepSeek, MiniMax, Kimi) and updates the compact status bar item and hover tooltip.
5. **Diagnostics**: Validates endpoint connectivity and outputs diagnostic information to the Output Channel to help troubleshoot authorization and network issues.

## Acknowledgements & Font Credits

- Status bar visual quota indicators bundle [Datatype](https://franktisellano.github.io/datatype/) by [Frank Tisellano](https://github.com/franktisellano/datatype), licensed under the [SIL Open Font License 1.1](./media/fonts/OFL.txt).

## Support & Maintenance

This software is provided “as-is” without any express or implied warranty. The authors are not liable for any damages arising from its use.

This extension is developed and published primarily for personal use. The GitHub repository is provided as a public resource for transparency and reference only. While feedback, suggestions, and issue reports are welcome and appreciated, responses, active support, or ongoing maintenance are not guaranteed.

If you find this project helpful, feel free to support development:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/thejjw)

## License

See `LICENSE`.
