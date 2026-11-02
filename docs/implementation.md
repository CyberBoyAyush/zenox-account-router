# Zenox Account Router — design and verification notes

`zenox-account-router` is a standalone OpenCode V2 companion for **Anthropic Claude subscriptions and OpenAI ChatGPT/Codex subscriptions**. Existing authentication plugins remain responsible for sign-in, refresh, and request compatibility. Building or testing this package never changes your live OpenCode configuration. For user-facing documentation see the [README](../README.md).

## Run from a checkout

Requires Node 22+, pnpm, and OpenCode V2 2.2.5 or newer. This package targets the 2.2.5 plugin contract.

```sh
pnpm install
pnpm check
node dist/cli.js setup
```

The wizard discovers accounts using `opencode auth list --format json`. Choose providers, participating OAuth accounts, an optional favorite, polling interval, and optional API-key fallback. Favorite means **preferred initial choice**, not permission to interrupt a healthy active selected account. Account IDs and display labels are saved; credentials are not.

Setup explains provider-global routing, HTTP transport, monitoring requests, and payment scope. Saving preferences and modifying OpenCode config require separate confirmations. Existing JSONC comments/settings/auth plugins are preserved, and a private backup is made before changing the OpenCode configuration. Cancel before confirmation makes no writes. Use `/reload` after changing preferences for an already installed router. If the current active account is outside the chosen set, switch to a selected account in OpenCode and reload; the router does not silently take over that account.

```sh
node dist/cli.js accounts
node dist/cli.js status
node dist/cli.js status --refresh
node dist/cli.js dry-run --refresh --json
```

`status` and `dry-run` read the saved local snapshot unless `--refresh` is supplied. Refresh respects the polling interval and monitoring backoff. Neither command activates accounts. `/router-status` writes a local synthetic status entry with `resume: false`, without starting inference. Saved sticky status is not a guarantee of the current active account after a manual switch; `accounts` reads the current OpenCode connection list.

Preferences default to `$XDG_CONFIG_HOME/opencode/account-router.json`, or `~/.config/opencode/account-router.json`. Sanitized state lives beside it as `account-router.state.json`. Custom `--config /path/profile.json` uses `/path/profile.state.json`. New directories use mode 0700 and files use 0600; symbolic-link paths are rejected. Do not point preference/state paths at authentication stores.

## npx onboarding

From npm:

```sh
npx zenox-account-router setup
```

When run from an npm/npx install, setup registers the package name `zenox-account-router` in OpenCode's `plugins` list (OpenCode installs it). When run from this checkout as the working directory, it registers the checkout path instead. Anywhere else, pass `--plugin <package-or-path>`.

To test a local tarball before publishing:

```sh
pnpm pack
npx --yes --package ./zenox-account-router-0.1.0.tgz zenox-account-router setup --plugin "$PWD"
```

`--plugin "$PWD"` points to the durable built checkout rather than a disposable npx cache. Setup also accepts `--config PATH` (recorded as the plugin's `configPath` option) and `--server URL` (used only by the CLI to list accounts from that OpenCode server). For a remote server, install the plugin and preferences on that server machine; the plugin always reads accounts from the OpenCode instance that loads it.

## Selection and retry policy

1. Preserve an already active selected OAuth account. Preserve an explicitly authorized active fallback key; never automatically switch back on a timer.
2. When an initial choice is needed, use an eligible favorite, otherwise prefer a fresh running five-hour window and then more weekly allowance remaining. Deterministic ties follow the selected account order. Unknown monitoring does not authorize payment.
3. Monitor actual outgoing HTTP authorization and, for OpenAI OAuth, workspace identity. Only a unique match to a selected credential is eligible for routing.
4. Inspect bounded clones of rejected primary HTTP responses. Match status and a digest of the response body to the retry error; consume rejection evidence once. Auxiliary, overlapping, stale, unrecognized, accepted-stream, authentication, temporary-capacity, and ambiguous errors do not trigger account rotation.
5. On confirmed relevant account quota exhaustion, record a cooldown and retry a different eligible selected OAuth account. An Anthropic auth-plugin diagnostic that lost the original restriction text requires rejected-window headers or a bounded fresh usage corroboration; generic `429` never suffices.
6. Activate a key only when every selected OAuth account has recent confirmed exhaustion, paid fallback was explicitly enabled, and the current exact model ID is in the operator's API model allowlist. A rounded percentage alone cannot authorize payment. Missing, expired, inaccessible, or unknown accounts do not count as exhausted. No model/provider substitutions are made.
7. Serialize switches process-wide and re-check the globally active ID immediately before activation. Honor another selected account's concurrent switch; suspend routing if the active account was changed to an unselected one. Bound account visits/retries; OpenCode's own retry ceiling also applies.

The operator must verify that API model IDs in the payment allowlist are actually available to the selected key; the router never sends paid compatibility probes. Model errors are surfaced, not silently substituted.

## Polling and credential safety

The default is one monitoring cycle per selected account every **10 minutes while active**, shared across location instances. There is no usage request for every message. A 30-second local scheduler only checks whether work is due; it makes no upstream request while idle or before the due time. Monitoring `429`/network errors back off exponentially and honor `Retry-After`. A canonical quota failure may request one corroborating probe, rate-limited separately to at most one per minute and still respecting upstream backoff.

Inside OpenCode, the plugin reads **only the selected accounts** (plus the paid key when fallback is authorized) through OpenCode's own `integration.connection.resolve`. OpenCode and the account's auth plugin own refresh; the router never calls a token endpoint itself, drops refresh tokens immediately, and keeps access tokens/key material in process memory only. This replaced an earlier read-only design: live checks showed idle backup tokens are usually expired, which would have made backups unmonitorable and blocked failover.

Refresh is kept deliberately rare:

- The first read after startup resolves each selected account once, which may let its owner refresh an expired idle token.
- After that, monitoring and request attribution reuse the last value for a token known to be expiring; only a **failover decision** asks the owner to refresh an idle backup again. Usage for such an idle backup may then show as expired/unknown until needed.
- A failed or timed-out (5 s) resolve is remembered for one polling interval, during which that account counts as needing sign-in and is not retried.
- Forced re-reads after an unattributable request happen at most once per 5 seconds, shared by concurrent requests.
- While routing is suspended (an unselected or unsupported account is active), the router performs no reads, monitoring or refreshes at all.

The standalone CLI (`status --refresh`, `dry-run --refresh`) uses `opencode auth export <provider>` through bounded, timed `execFile` without shell interpolation, and never refreshes; there, expired idle tokens appear as `expired`. Use `/router-status` inside OpenCode for fully monitored state. Credential diagnostics and raw response bodies are never printed or persisted. Monitoring API keys is unsupported; they do not have subscription percentages.

After activating an OpenAI account, the router waits (2.5 seconds overall, each check individually time-limited) for OpenCode's asynchronous provider reload to apply the new account's `chatgpt-account-id` workspace header **and** endpoint (ChatGPT Codex for subscriptions, the platform API for keys). If that cannot be confirmed in time, the retry is delayed by 3 seconds to give the reload more time rather than sent immediately; a mismatched request after that is unlikely but not impossible.

Only fixed provider usage origins are called with credentials, redirects are rejected, and response reads have byte/chunk/time bounds. Inference is never issued by setup, status, monitoring, or dry-run. Configured providers/models use **HTTP instead of WebSockets** so account/error attribution is observable in the tested SDK; this sacrifices OpenAI WebSocket continuation/reuse benefits. This change is provider-wide, including auxiliary requests.

## Known limits

- Account activation is **global per provider**, not per session. Paid consent is therefore provider-global: concurrent sessions and auxiliary requests may use a newly activated key. There is no session-isolated billing guarantee.
- Comparing then activating is not a database compare-and-swap. A plugin mutex cannot atomically coordinate manual changes, other controllers, or separate OpenCode processes. Use one routing controller/service; strict per-request binding needs core support.
- The companion must run after auth plugins. If another hook replaces a Request afterward, attribution fails closed. If another plugin changes the response body after this companion, body-digest matching may fail closed.
- Only rejected HTTP requests before output are recovered automatically. Accepted SSE/WebSocket error frames and refresh failures outside the retry boundary are not replayed; do not infer quota exhaustion from these.
- Provider usage endpoints are undocumented and can change. Parse failures and monitoring errors are reported as unknown/unavailable, not fabricated zero usage or permission to spend.
- Cached usage may lag inference; sticky routing maximizes cache opportunities but cannot prevent provider cache expiration or preserve an account's cache across an account switch.

## Implementation and verification

`src/providers/` contains independent quota readers/classifiers; `policy.ts` is pure initial selection; `controller.ts` owns evidence, cooldowns, polling and serialized switching; `index.ts` is the typed V2 integration; `setup.ts`, `config.ts`, `opencode.ts` and `cli.ts` implement onboarding, safe persistence, supported CLI access and diagnostics.

The pinned OpenCode SDK is a development/type dependency and optional peer supplied by the host. The emitted plugin is the same `{ id, setup }` contract returned by the SDK's identity `Plugin.define` function; it does not import the full SDK at runtime. This keeps npx onboarding small and avoids shipping unused SDK dependency trees.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm build
pnpm pack
```

Regression tests use synthetic accounts and intercepted HTTP, not real tokens or paid inference. They cover both providers, quota-versus-throttle distinctions, onboarding/payment consent, body preservation, error attribution, request overlap, revoked/rotated credentials, concurrent switches, cache/polling limits, symlink protection, package contracts and lifecycle cleanup. Temporary test directories are removed.

Three additional layers:

- **Real OpenCode core end-to-end** (`tests/e2e/`): the embedded `@opencode/sdk` 2.2.5 engine with an in-memory database, isolated temporary HOME/XDG directories, provider API-key environment variables removed, the real published `@ex-machina/opencode-anthropic-auth@2.0.0-next.6`, and OpenCode's built-in ChatGPT sign-in. Global `fetch` is replaced with a fake provider that fails closed for anything unrecognized, and raw sockets to non-loopback hosts are refused; every test asserts no unexpected requests and the exact number of token refreshes. Sessions run real prompts through OpenCode's actual hooks, retry loop, credential activation and provider reload. Scenarios for both providers: healthy sticky use, A→B quota failover then staying on B, temporary throttling (no switch), model/plan restriction (no switch), title-only quota (no switch, title request verified), paid key only after all subscriptions are exhausted and the model is allowlisted, error instead of payment when not authorized, unselected active account left alone with no monitoring or refresh, two concurrent sessions switching once, owner refresh of an expired backup token (both providers), a backup whose refresh keeps failing refreshed at most once across many prompts, router loaded before the auth plugin failing closed, favorite not interrupting a healthy active account, no replay after streamed output, and 15 repeated OpenAI failovers checking token/workspace pairing.
- **Property-based fuzzing** (`tests/fuzz.test.ts`, fast-check): arbitrary usage JSON never yields fabricated or out-of-range usage; generic errors are never classified as quota; explicit quota signals always are; bounded JSON reading under arbitrary chunking; configuration parsing never leaks input; initial choice is always an eligible selected OAuth account; random multi-session event interleavings never activate unselected accounts, never pay without authorization, never switch on generic errors and never persist secrets.
- **Real installed binary**: the built plugin loaded by the installed Bun-based `opencode` 2.2.5 in an isolated loopback server reports `active` and registers `/router-status` without errors.

### Verified on 2026-11-02

- Independent inspector: **PASS**; 283 tests, type-check, ESLint, build, production dependency audit, and packaged installation all passed.
- Measured coverage: 97.54% lines/statements, 90.56% branches. `src/cli.ts` is excluded from this coverage calculation; its compiled symlinked executable and installed npx entry were exercised separately.
- Installed tarball imports without the SDK runtime dependency. Installed-bin and npx help/account discovery work against a synthetic OpenCode executable. A real PTY setup cancellation returned cleanly without creating or changing files; full wizard choices are covered by injected-prompt tests.
- Read-only usage probes (first pass, using the CLI export path, which never refreshes) succeeded for the active Anthropic and OpenAI accounts; their expired inactive tokens were reported rather than refreshed. That observation drove the later switch to owner-managed refresh inside OpenCode. No real account activation, inference, paid API-key request, or live configuration installation was performed.
- Oracle's review was blocked by that reviewer's local-file-access restriction. A separate file-capable reviewer inspected the implementation, found no Critical/High issues and identified four Medium concurrency/payment-evidence issues; fixes and dedicated regression tests are included.
- The installed-bin test caught and fixed an npm symlink entry-point bug.
- Second, deeper pass: real-core end-to-end failover verified for both providers against intercepted provider traffic (see above). This found and fixed real-world gaps: expired idle backup tokens blocking failover, a possible OpenAI token/workspace race after a switch, and initialization polling before checking for suspension. Fuzzing found and fixed a zero-second reset edge case. A second file-capable review then found an unthrottled owner-refresh path on unattributable requests (High) plus Medium issues in the OpenAI settle bound/endpoint check, background refresh of idle backups, unsupported active connections, and weak test assertions; all were fixed with regression tests.
- Remaining unverified: failover against live Anthropic/OpenAI quota responses on your real accounts (it requires actually exhausting a subscription); a long-running real OpenCode session over hours; behavior under future OpenCode versions. Coverage of `tests/e2e` network isolation is for this process's `fetch` and TCP sockets, not every possible native transport.

## Source references

- [OpenCode V2 plugin guide](https://opencode.ai/v2/docs/build/plugins/) and [server hooks](https://opencode.ai/v2/docs/build/plugins/server/).
- [OpenCode v2.2.5 model dispatch](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/model-request.ts) and [retry](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/retry.ts).
- [Anthropic auth quota handler](https://github.com/ex-machina-co/opencode-anthropic-auth/blob/27e883afe139c1989bc1deb378fdba82f94dddf1/src/rate-limit.ts).
- [Official Codex usage client](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/backend-client/src/client/rate_limit_resets.rs), [backend models](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs), and [error classification](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/codex-api/src/api_bridge.rs).
- [OpenUsage Claude usage client](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Claude/ClaudeUsageClient.swift) and [Codex client](https://github.com/robinebers/openusage/blob/c5a2f410280ef2be7931929f0c5c03a0a2a5726f/Sources/OpenUsage/Providers/Codex/CodexUsageClient.swift).
- [CLIProxyAPI selectors](https://github.com/router-for-me/CLIProxyAPI/blob/7cad1cb7df48c6c5ffb7ff0b34ef8198806115bc/sdk/cliproxy/auth/selector.go).
