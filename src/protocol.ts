export interface WorkerError {
  code: string;
  message: string;
  path?: string;
  spillPath?: string;
}

export type Frame =
  | { version: 1; type: "ready" }
  | { version: 1; type: "reply"; value: unknown }
  | { version: 1; type: "watch"; value: unknown }
  | { version: 1; type: "http-response"; status: number; statusText: string; headers: [string, string][] }
  | { version: 1; type: "line"; data: string; terminated: boolean }
  | { version: 1; type: "output"; stream: "stdout" | "stderr"; data: string }
  | { version: 1; type: "spill"; path: string }
  | { version: 1; type: "result"; value: unknown }
  | { version: 1; type: "error"; error: WorkerError };

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid worker base64 payload");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Noncanonical worker base64 payload");
  return decoded;
}

export function parseFrame(text: string): Frame {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1) throw new Error("Invalid worker protocol version");
  switch (value.type) {
    case "ready":
      break;
    case "http-response":
      if (
        !Number.isInteger(value.status) ||
        (value.status as number) < 200 ||
        (value.status as number) > 599 ||
        typeof value.statusText !== "string" ||
        !Array.isArray(value.headers) ||
        !value.headers.every(
          (entry) =>
            Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"),
        )
      )
        throw new Error("Invalid worker HTTP response");
      break;
    case "line":
      decodeBase64(value.data);
      if (typeof value.terminated !== "boolean") throw new Error("Invalid worker line");
      break;
    case "output":
      decodeBase64(value.data);
      if (value.stream !== "stdout" && value.stream !== "stderr") throw new Error("Invalid worker stream");
      break;
    case "spill":
      if (typeof value.path !== "string") throw new Error("Invalid worker spill path");
      break;
    case "reply":
    case "watch":
    case "result":
      if (!("value" in value)) throw new Error("Missing worker result");
      break;
    case "error":
      if (
        !record(value.error) ||
        typeof value.error.code !== "string" ||
        typeof value.error.message !== "string"
      ) {
        throw new Error("Invalid worker error");
      }
      if (value.error.path !== undefined && typeof value.error.path !== "string")
        throw new Error("Invalid error path");
      if (value.error.spillPath !== undefined && typeof value.error.spillPath !== "string")
        throw new Error("Invalid error spill path");
      break;
    default:
      throw new Error("Unknown worker frame");
  }
  return value as Frame;
}
