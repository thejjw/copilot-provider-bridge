# Sealed credentials for Custom Endpoint models: feasibility and plan

Status: analysis complete, implementation not started.
Branch: `feat/sealed-credential-helper`.
Baseline: `copilot-provider-bridge` 0.4.0, VS Code 1.143.1 (Electron 43.7.7), Windows 11 x64.
Source baseline for VS Code claims: `microsoft/vscode` tag `1.143.1` (commit `e646868227`),
matching the installed build.

## Merge policy (read before merging)

This document is branch-only. It, the original workspace plan, and any spike scripts or notes
must NOT reach `main`. They exist to justify and sequence the code, not to ship.

Before the final merge:

- Remove `docs/plans/` (and any other analysis files) in a final commit, or squash-merge only the
  code, test, and user-facing documentation commits.
- Do not merge downloaded helper binaries, test DB copies, local profiles, or logs.
- Keep `README.md` / `CHANGELOG.md` changes; those are product documentation.

## Verdict

The feature is feasible on Windows x64 stable VS Code, with one assumption disproven and one
earlier retest corrected:

1. **Detached-child survival holds under controlled conditions.** A first single run suggested
   the child died at quit, but that harness passed a poorly quoted command to `cmd /c`. Controlled
   reruns fixed the harness: the no-quit run wrote both the start and final markers; the quit run
   wrote the final marker 40 s after every test editor process was gone, while the extension host
   reported `IsProcessInJob=true`. Job membership alone does not predict death on this build.
   WMI-created children also survived. The original detach-and-wait design is therefore viable;
   keep WMI/named-pipe and live-write as ranked fallbacks if another build or endpoint agent
   behaves differently.
2. **A secret row written into the live `state.vscdb` is not overwritten on shutdown.** The
   original plan's gate-2 assumption ("the storage cache flushes over it") is false. `Storage`
   loads all rows once at startup and flushes only pending keys on close. A live external insert
   survived a graceful quit and decrypted correctly afterwards. A synchronous helper is viable as
   a fallback, at the cost of a live DB write and a forced restart.
3. **Unknown top-level fields do not survive "Update API Key".** Core rebuilds the group from
   `{ name, vendor, ...resolvedConfiguration, settings }`, so a third marker such as
   `"copilotProviderBridge": {...}` is dropped. Sealed detection must rely on the `apiKey`
   placeholder plus the existing display-name fallback.

Recommended v1: keep the original sealed JSON shape and stable `cpb-<providerId>` secret ids;
spawn the helper detached with `unref()` and the JSON payload on stdin, have it wait for editor
exit, then write. Keep the out-of-job launch and the synchronous live-write mode as fallbacks.

## What the machine showed

All checks ran against the real installed build; no secret values were printed.

| Check | Result |
|---|---|
| `Local State` -> `os_crypt.encrypted_key` | 283 bytes, starts with the five bytes `DPAPI`; `app_bound_encryption` absent |
| OSCrypt key derivation | DPAPI unprotect yields a 32-byte key |
| Existing secret ciphertext | `v10` + 12-byte nonce + ciphertext + 16-byte GCM tag; decrypts with the derived key |
| Probe written with the same layout | Encrypt/decrypt roundtrip succeeds |
| Secret storage location | `%APPDATA%\Code\User\globalStorage\state.vscdb`, table `ItemTable (key TEXT UNIQUE, value BLOB)` |
| Stored value shape | `JSON.stringify(Buffer)` i.e. `{"type":"Buffer","data":[...]}` |
| Scope/target | `StorageScope.APPLICATION`, `StorageTarget.MACHINE`; existing secret rows are marked `1` in `__$__targetStorageMarker` |
| Journal mode | `delete`, not WAL |
| Existing BYOK rows | None (`chat.lm.secret.*` absent); extension secrets are present and decrypt |
| Live DB insert while running | Succeeded with `busy_timeout`; row survived graceful quit; decrypted afterwards |
| Detached child, no-quit control | Child wrote the immediate start marker and the delayed final marker |
| Detached child, quit run | Start marker existed; final marker was written 40 s after all test editor processes were gone |
| Extension host job membership | `IsProcessInJob` returned true; the detached child still outlived the editor |
| WMI-created child | Survived quit |
| Externally seeded extension secret | `context.secrets.get` returned 15 bytes and matched the seeded value on the next launch |
| `chatLanguageModels.json` | 7 `customendpoint` groups, plaintext `apiKey` and rendered `Authorization` headers |

The absence of a real `chat.lm.secret.*` row is the one remaining gate item. An externally
seeded extension secret was read back by the real `context.secrets` path
(`BaseSecretStorageService` plus `EncryptionMainService.decrypt`), so row acceptance is proven.
Core secrets use the same service with the raw id instead of the extension-namespace id; capture
one row created by "Update API Key" as the final one-minute confirmation.

## Grounded behavior (VS Code 1.143.1)

All line numbers below were checked against the `1.143.1` tag, matching the installed build.

- Core secret ids are stored as `secret://<id>` and read with
  `BaseSecretStorageService.get(id)` (`src/vs/platform/secrets/common/secrets.ts:19,139-160`).
  Scope is application, target machine (`:203-223`). Extension secrets are namespaced separately
  as `secret://{"extensionId":...,"key":...}`
  (`src/vs/workbench/api/browser/mainThreadSecretState.ts:90-91`); core BYOK ids are not.
- `EncryptionMainService.encrypt` returns `JSON.stringify(safeStorage.encryptString(value))`
  (`src/vs/platform/encryption/electron-main/encryptionMainService.ts:34-43`); decrypt parses
  `data` into a Buffer (`:46-60`).
- Application storage is `<profile>/globalStorage/state.vscdb`
  (`src/vs/platform/storage/electron-main/storageMain.ts:285-292`); schema and optional WAL are in
  `src/vs/base/parts/storage/node/storage.ts:337-352`. Core does not enable WAL here.
- `Storage.init()` loads every row into its cache; `set`/`delete` queue pending keys; `close()`
  flushes only pending (`src/vs/base/parts/storage/common/storage.ts:199-214,331-378`).
  This is why a live external insert survives shutdown.
- BYOK resolution: `decodeSecretKey` takes the text between `:` and the trailing `}`
  (`src/vs/workbench/contrib/chat/common/languageModels.ts:2468-2472`) and `_resolveConfiguration`
  calls the core secret service for schema properties marked `secret` (`:2494-2512`). Only the
  top-level group fields are resolved; `models[].requestHeaders` are left untouched.
- `${apiKey}` in a custom header is interpolated by the in-repo Copilot extension at request time
  (`extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts:327-335`, tested
  at `.../test/customEndpointProvider.spec.ts:713-730`), and a user-supplied `Authorization`
  suppresses the inferred default header (`:235-243,312`).
- "Update API Key" rebuilds the group and preserves only `settings`
  (`src/vs/workbench/contrib/chat/common/languageModels.ts:1977-2003`). It also mints a new random
  `chat.lm.secret.<hash>` (`:2524`), then deletes the previously referenced secret
  (`_deleteSecretsInConfiguration`, `:2534`). An official rotation therefore removes our `cpb-`
  row automatically; chat keeps working.
- Core rewrites the whole file with tabs on any group update
  (`src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts:232`). Do not
  depend on formatting or unknown fields.

## Grounded behavior (bridge 0.4.0)

- `providerToConfig` already defaults `apiKey` to `${input:<secretInput>}`
  (`src/config.ts:107-115`), and `modelToConfig` only replaces `${apiKey}` when a key is passed
  (`:91-105`). Sealed rendering therefore means "call the renderer without a key".
- `findGroupIndex` recognizes the plaintext marker `${EXTENSION_MARKER}${providerId}.` and a
  catalog display-name match (`src/config.ts:118-126`); `EXTENSION_MARKER` is
  `copilot-provider-bridge.` (`src/providers.ts:18`).
- Marker checks are duplicated across consumers, not just `findGroupIndex`:
  `hasAnyBridgeGroup` (`src/config.ts:127-129`), `removeModelCommand` and `listModelsCommand`
  filters (`src/commands/removeProvider.ts:12-31`, `src/commands/listProviders.ts:8-22`),
  diagnostics group-to-provider mapping (`src/commands/diagnostics.ts:68`), and the reset filter
  (`src/commands/resetConfiguration.ts:70-80`). All of them go blind in sealed mode unless the
  match is centralized.
- Reset deletes extension secrets keyed `copilot-provider-bridge.<id>.apiKey`
  (`src/commands/resetConfiguration.ts:32-44`) and rewrites the JSON itself.
- `userSettingsDir()` and `codeFlavor()` already resolve the `User` directory and distinguish
  `Code - Insiders` (`src/utils/userPaths.ts`).
- Quick Setup and Add Model pass the raw key into `providerToConfig` and write the file
  (`src/commands/setup.ts:207-220`, `src/commands/addProvider.ts:120-140`).

## Sealed representation

```json
{
  "name": "Z.ai GLM Coding Plan",
  "vendor": "customendpoint",
  "apiType": "messages",
  "apiKey": "${input:chat.lm.secret.cpb-zai}",
  "models": [
    {
      "id": "glm-5.3",
      "requestHeaders": { "Authorization": "Bearer ${apiKey}" }
    }
  ]
}
```

The secret row is `secret://chat.lm.secret.cpb-zai`, value
`{"type":"Buffer","data":[118,49,48,...]}` where the buffer is
`"v10" | nonce(12) | AES-256-GCM ciphertext | tag(16)`, encrypted with the OSCrypt key from
`%APPDATA%\Code\Local State`.

`findGroupIndex` must also recognize `chat.lm.secret.cpb-<providerId>`, and all other consumers
must use one shared matcher:

```ts
// Returns the provider id for a group written by this extension, in either mode.
function providerIdForGroup(group: ConfigGroup): ProviderId | undefined
```

Match order: plaintext marker, sealed placeholder, catalog display name. Do not add a third
marker field.

## Helper design

### Operations

JSON lines on stdin/stdout. The helper accepts only ids with the `chat.lm.secret.cpb-` prefix,
refuses to list or decrypt any other `secret://` row, and never writes the key to argv, logs, or
temporary files.

```json
{"op":"apply","userDir":"C:\\Users\\...\\AppData\\Roaming\\Code\\User","config":"<full json>","configSha256":"<hash>","secrets":{"zai":"<key>"}}
{"op":"delete","userDir":"...","ids":["chat.lm.secret.cpb-zai"]}
```

`apply` steps, in order:

1. Validate ids and the `DPAPI` prefix of `<userDir>/../Local State` `os_crypt.encrypted_key`.
   Abort with a message if app-bound encryption or an unknown format is detected.
2. Wait until the editor for that user-data dir has released the database. Prefer "acquire
   `BEGIN IMMEDIATE`, then rollback" with a retry loop; optionally also require that no main
   `Code.exe` exists with a matching image path. Timeout around ten minutes; on timeout exit
   nonzero and change nothing.
3. In one transaction: insert/replace each `secret://chat.lm.secret.cpb-<id>` row and merge the
   key into `__$__targetStorageMarker` with value `1` (machine). Use `busy_timeout`; leave the
   journal mode alone.
4. Re-read `chatLanguageModels.json`, verify `configSha256`, and atomically replace it only after
   every row committed. A mismatch leaves the previous file untouched.
5. Write a result file under `globalStorage` so the next session can report the outcome, then
   optionally relaunch `code` if the request asked for it.

`delete` removes only `cpb-` rows and their marker entries. It never edits the JSON.

### Launching the helper

- Primary, validated on this build: `spawn(helper, args, { detached: true, windowsHide: true,
  stdio: ['pipe', 'pipe', 'ignore'] })`, write the JSON payload to stdin, end stdin, and read one
  acknowledgement line before asking the user to quit. Then `unref()`. The controlled test showed
  the detached child outliving every editor process, even though the extension host was in a job
  object. If the helper exits nonzero before the acknowledgement, leave the JSON untouched.
- Re-run the controlled survival test on each release build and with the target endpoint agent.
  If a build kills the child, fall back in this order:
  1. WMI/CIM `Win32_Process.Create` with a named-pipe payload (proven survivor);
  2. a one-shot Task Scheduler task with a named-pipe payload;
  3. a synchronous helper while VS Code is alive, followed by a required full quit/reopen
     (live-write persistence is proven).
- For the pipe fallbacks, pass only non-secret arguments (pipe name, user dir); the command line
  must never contain a key.
- Do not infer survival from `IsProcessInJob`. Test with an immediate start marker, a delayed
  final marker, and a timestamped "all editor processes gone" file.
- Preflight before any write: refuse on `process.platform !== 'win32'`, `process.arch !== 'x64'`,
  non-empty `vscode.env.remoteName`, or `codeFlavor() === 'Code - Insiders'`.

### Integrity and availability

- Resolve the helper from `copilotProviderBridge.credentialHelper.path` after a hash check, or
  download `credential-helper-win32-x64.exe` into `globalStorage`, verify a SHA-256 pinned in the
  extension, and strip `Zone.Identifier`. The pin lives in the extension, never beside the binary.
- Say in the prompt that an unsigned helper can trigger SmartScreen once.
- If the helper is missing or the hash fails, leave plaintext behavior untouched and show the
  error.

## Extension behavior

- Default stays exactly as today: no download, no spawn, plaintext headers.
- New setting `copilotProviderBridge.credentialStorage`: `plaintext` (default) or `sealed`.
- New command: **Seal Model API Keys (Optional, Windows x64)**, visible only under the
  preflight conditions above. It explains the trade, lists providers without an extension secret
  (skipped), renders the next file in memory, launches the helper, and asks the user to quit.
- On the next startup, read the result file: success sets the setting to `sealed` and reports
  which providers moved; failure leaves plaintext and shows the helper error.
- While `sealed`, Quick Setup and Add Model render the sealed group and send the new key through
  the helper instead of writing it to JSON. Turning the setting off only stops routing new keys
  through the helper; it does not fabricate plaintext.
- Reset deletes extension secrets and bridge groups immediately and queues helper `delete` calls
  for `cpb-` rows. A leftover encrypted row is harmless; a leftover plaintext file is not.
- Diagnostics gain one line per provider: `sealed`, `plaintext`, or `extension secret only`.
- `hasAnyBridgeGroup`, remove/list/diagnostics/reset filters, and the new command all use the
  shared matcher.

## Implementation phases

1. **Pure rendering and matching (no helper).** Add `sealedSecretId`, the shared matcher, and a
   sealed render path. Route every existing marker consumer through the matcher. Tests:
   - sealed JSON never contains the key; `Authorization` stays `Bearer ${apiKey}`;
   - `apiKey` is exactly `${input:chat.lm.secret.cpb-<id>}`;
   - matcher finds plaintext, sealed, and name-fallback groups; reset/remove/list/diagnostics see
     sealed groups;
   - `hasAnyBridgeGroup` returns true for a sealed-only file.
2. **Helper `apply`/`delete` and OSCrypt writer.** Fixture DB created from the documented schema.
   Tests: protocol rejects non-`cpb-` ids and unknown ops; marker merge; JSON hash mismatch aborts;
   row value decrypts with a fixture key; journal mode unchanged; no argv/log leakage.
3. **Launch and integration.** Detached stdin launcher, wait-for-lock, result file; WMI/pipe and
   synchronous fallbacks. Manual gate on Windows: seal one provider, quit, reopen, chat works;
   JSON contains `${input:chat.lm.secret.cpb-zai}` and `Bearer ${apiKey}` and no key; rotate;
   delete; reset.
4. **Commands and UX.** Setting, command visibility, prompt copy, result reporting, diagnostics
   lines, sealed Quick Setup/Add Model, reset cleanup.
5. **Docs and merge hygiene.** Threat model in the credential section (sealed JSON, same-user
   DPAPI, Windows x64 only, internal-format risk, vscode#326434). Remove this plan and spike
   files before merging.

## Manual gate checklist (Windows x64)

1. Record `os_crypt.encrypted_key` prefix and the v10 layout of one "Update API Key" row on the
   target stable build.
2. Run the controlled survival test: start marker, delayed final marker, and a timestamp showing
   all editor processes gone before the final marker. Repeat with the endpoint agent enabled.
3. Seal one provider; confirm the helper survived quit and both the row and JSON changed.
4. Reopen; confirm the model appears and completes one request.
5. Rotate in Manage Language Models; confirm chat still works and the old `cpb-` row is gone.
6. Reset; confirm extension secrets, groups, and `cpb-` rows are gone and the file has no key.
7. Force the app-bound failure path (simulate a non-DPAPI key) and confirm no file change.
8. Force the out-of-job fallback (simulate a killed detached child); confirm the pipe launch and
   the synchronous mode both persist after restart.

## Risks and open questions

- **Child survival:** the detached child survived here despite job membership, but endpoint
  agents and future Electron builds can differ. The controlled test is part of the release gate;
  WMI/pipe, Task Scheduler, and live-write are the ranked fallbacks.
- **App-bound encryption:** current build is DPAPI, but a future Electron/VS Code may switch.
  Fail closed on any non-`DPAPI` prefix; pin the tested build range in the docs.
- **Marker overwrite:** if the live editor flushes a changed target marker on close, our merged
  entry can be lost. Row lookup by id still works; only `keys()` listing is affected. Applying
  after exit avoids it.
- **Live-write fallback:** SQLite contention and a broken current session until restart. Keep it
  behind a clear modal and a timeout.
- **Official updates:** "Update API Key" drops unknown fields and replaces the secret; sealed
  detection must stay on the `apiKey` value and the name fallback.
- **Availability:** default user-data dir only; Insiders, remote windows, ARM64, macOS, and Linux
  stay out of scope until their storage layouts are verified.
- **Security caveat:** sealing removes the key from the JSON file and its backups/sync only. A
  same-user process can still decrypt the DPAPI-protected row. State this in the user-facing docs.
