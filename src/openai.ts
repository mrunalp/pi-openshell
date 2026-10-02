import type { Provider } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createOpenShellFetch, type OpenShellFetchOptions } from "./inference.js";

export type OpenShellOpenAIProvider = Provider<"openai-responses"> & { cleanup(): Promise<void> };

/** OpenAI Responses via an attached OpenShell provider; no host API-key lookup. */
export function createOpenShellOpenAIProvider(
  options: Omit<OpenShellFetchOptions, "baseUrl"> & { baseUrl?: string },
): OpenShellOpenAIProvider {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const fetch = createOpenShellFetch({ ...options, baseUrl });
  const base = openaiProvider();
  // Pi distinguishes sk-* API keys from ChatGPT OAuth tokens. This value is
  // non-secret, discarded by the bridge, and never sent to the provider.
  const apiKey = "sk-openshell-placeholder";
  const requestOptions = <T>(options: T) => ({
    ...options,
    apiKey,
    fetch,
    transport: "sse" as const,
    maxRetries: 0,
  });
  return {
    ...base,
    baseUrl,
    auth: {
      apiKey: {
        name: "OpenShell attached provider",
        async resolve() {
          return { auth: { apiKey, baseUrl }, source: "OpenShell attached provider" };
        },
      },
    },
    getModels: () => base.getModels().map((model) => ({ ...model, baseUrl })),
    getAllModels: () => base.getModels().map((model) => ({ ...model, baseUrl })),
    stream: (model, context, options) => base.stream({ ...model, baseUrl }, context, requestOptions(options)),
    streamSimple: (model, context, options) =>
      base.streamSimple({ ...model, baseUrl }, context, requestOptions(options)),
    ...(base.fetchDeferred
      ? {
          fetchDeferred: (model, handle, options) =>
            base.fetchDeferred!({ ...model, baseUrl }, handle, requestOptions(options)),
        }
      : {}),
    ...(base.cancelDeferred
      ? {
          cancelDeferred: (model, handle, options) =>
            base.cancelDeferred!({ ...model, baseUrl }, handle, requestOptions(options)),
        }
      : {}),
    cleanup: () => fetch.cleanup(),
  };
}
