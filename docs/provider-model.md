# Provider model

## Portability boundary

Agent definitions describe organizational roles and permissions, not an SDK's agent object. The core `AgentProvider` port exposes provider-neutral operations:

```ts
interface AgentProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  createSession(context: TrustedSessionContext): Promise<ProviderSession>;
  execute(session: ProviderSession, request: AgentExecutionRequest): Promise<ProviderTurnResult>;
  closeSession(session: ProviderSession): Promise<void>;
}
```

An execution result is either a list of neutral tool calls or a completed structured value. Provider session internals remain inside the adapter. The runtime never imports provider SDK request, response, tool, usage, or session types.

## Capabilities

V0 represents unequal providers with a boolean capability map covering:

`textGeneration`, `structuredOutput`, `toolCalling`, `subagents`, `mcp`, `shell`, `filesystem`, `codeExecution`, `streaming`, `reasoning`, and `imageInput`.

Workflows declare required capabilities. The runtime rejects an incompatible adapter before a session is created. V0 does not rank or route among multiple compatible providers.

Provider capability declarations describe adapter/API support. They do not grant tool permission. For example, `OpenAIProvider` can support tool calling while the Developer receives only the filesystem tools declared by its role.

## MockProvider

`MockProvider` implements the same two-turn tool protocol as a real model adapter. In the demonstration it deterministically requests:

- a file write as Developer;
- the fixed sample test command as Tester;
- Git status, Git diff, and file read as Reviewer.

It then references the receipt IDs returned by the runtime. This makes the demonstration deterministic without letting the mock mutate files or invent trusted evidence.

## OpenAIProvider

`OpenAIProvider` is the first real adapter. It uses the official OpenAI TypeScript SDK and Responses API only inside `packages/providers`. It maps:

- neutral session state to Responses `previous_response_id`;
- neutral tool specifications to strict function tools;
- provider function calls back to neutral calls;
- runtime tool results to `function_call_output` items;
- neutral expected-output JSON Schema to Responses structured output;
- provider usage metadata to neutral token fields.

The implementation follows the official [OpenAI Responses API TypeScript reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create). The default model is `gpt-5.4-mini`, overridable with `AGENT_ORG_OPENAI_MODEL`.

The CLI loads `OPENAI_API_KEY` from `.env.local` only when the OpenAI adapter is selected. The key is never copied into a task, prompt, event, artifact, receipt, or ledger.

## Adding another provider

An Anthropic, local-model, Cursor, Copilot, or Windsurf adapter should:

1. implement `AgentProvider` in `packages/providers`;
2. translate its native session, tool, and structured-output semantics internally;
3. declare capabilities honestly;
4. return only neutral calls and values;
5. add deterministic adapter contract tests with a fake native client;
6. remain optional at runtime and be injected by the CLI or a future routing layer.

No task, authorization, review, artifact, tool, or persistence code should change merely to add an adapter.

## Provider diversity

The ledger already records the provider and model for every agent run. A future policy can require `implementation provider != review provider` for high-risk tasks. V0 enforces identity and role diversity but uses one provider instance for all stages so the deterministic demo needs no paid services.
