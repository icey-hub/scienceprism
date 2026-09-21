# DeepSeek Harness Agent

SciencePrism can run the Agent `Tools` mode through the DeepSeek Harness TypeScript SDK.
The default runtime remains the existing LangChain agent.

## Enable

Open Workspace Settings and set `Agent Runtime` to `DeepSeek Harness`.

The backend auto-detects the local checkout at:

```text
~/Desktop/DeepSeek Harness/deepseek-harness/packages/sdk/client/lib/index.js
```

For another checkout, set:

```sh
SCIENCEPRISM_HARNESS_SDK=/absolute/path/to/packages/sdk/client/lib/index.js
```

The LLM API key is taken from the SciencePrism LLM setting, or from
`DEEPSEEK_API_KEY`. The model and endpoint are passed to the Harness SDK as the
provider/model route.

## Safety boundary

Each request is executed in a temporary copy of the SciencePrism project. Harness
may use its configured tools inside that copy, but SciencePrism never exposes the
original project directory to the Harness process. When the run finishes,
SciencePrism converts text-file changes into pending patches. The original project
is changed only after the user applies the Diff.

The temporary workspace is removed after each attempt, while Run metadata,
events, errors, output validation, and proposed patches remain queryable in
`.scienceprism/harness-runs.json`. Pausing and resuming starts a new attempt;
the SDK process itself is not treated as durable state.

The Runtime grants `project.read` and `patch.propose` by default. Network,
direct writes, Shell, experiment execution, sensitive files, and paths outside
the project constraint scope are denied. See [Harness Runtime](./harness-runtime.md)
for the capability file and HTTP lifecycle Interface.

If the Harness SDK cannot start or the model turn fails, SciencePrism falls back
to the existing LangChain agent by default. Set
`SCIENCEPRISM_HARNESS_FALLBACK=false` to fail closed instead.

When the endpoint field is left at SciencePrism's default OpenAI URL, an existing
`DEEPSEEK_BASE_URL` environment variable takes precedence; if neither is set,
the Harness provider uses its public default. Otherwise the configured endpoint
is normalized to a provider base URL.

## Runtime options

These environment variables are optional:

```text
SCIENCEPRISM_HARNESS_PROFILE=sdk
SCIENCEPRISM_HARNESS_DSH_BIN=/absolute/path/to/dsh
SCIENCEPRISM_HARNESS_PROVIDER=deepseek-official
SCIENCEPRISM_HARNESS_MAX_TOKENS=49152
SCIENCEPRISM_HARNESS_TIMEOUT_MS=600000
```
