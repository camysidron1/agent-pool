import { checkCodexCommandPolicy } from "./codex-policy";

export type CodexCommandSupervisorOptions = {
  readonly commandProfile: string;
  readonly expectedBranchName?: string | null;
};

export type CodexCommandSupervisorDecision =
  | {
      readonly kind: "allowed";
      readonly command: readonly string[];
      readonly commandText: string;
      readonly policy: string;
    }
  | {
      readonly kind: "denied";
      readonly command: readonly string[];
      readonly commandText: string;
      readonly policy: string;
      readonly reason: string;
    };

export class CodexCommandPolicyViolationError extends Error {
  readonly decision: Extract<CodexCommandSupervisorDecision, { readonly kind: "denied" }>;

  constructor(decision: Extract<CodexCommandSupervisorDecision, { readonly kind: "denied" }>) {
    super(`command policy denied: ${decision.reason}`);
    this.name = "CodexCommandPolicyViolationError";
    this.decision = decision;
  }
}

export type CodexCommandSupervisor = {
  readonly inspectChunk: (chunk: string) => readonly CodexCommandSupervisorDecision[];
  readonly flush: () => readonly CodexCommandSupervisorDecision[];
};

export function createCodexCommandSupervisor(options: CodexCommandSupervisorOptions): CodexCommandSupervisor {
  let buffer = "";

  return {
    inspectChunk(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      return lines.flatMap((line) => inspectCodexEventLine(line, options));
    },
    flush() {
      const line = buffer;
      buffer = "";
      return line.trim() ? inspectCodexEventLine(line, options) : [];
    },
  };
}

export function inspectCodexEventLine(
  line: string,
  options: CodexCommandSupervisorOptions,
): readonly CodexCommandSupervisorDecision[] {
  const event = parseJsonObject(line);
  if (!event) return [];
  const candidate = readCommandCandidate(event);
  if (!candidate) return [];
  if ("error" in candidate) {
    return [
      {
        kind: "denied",
        command: [],
        commandText: candidate.commandText,
        policy: options.commandProfile,
        reason: candidate.error,
      },
    ];
  }
  return [checkCommand(candidate, options)];
}

export function parseCommandText(commandText: string): readonly string[] | { readonly error: string } {
  const trimmed = commandText.trim();
  if (!trimmed) return { error: "empty_command" };
  if (/[;&|<>`]/.test(trimmed) || /\$\(|\n/.test(trimmed)) return { error: "compound_shell_forbidden" };

  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) return { error: "dangling_escape" };
  if (quote) return { error: "unclosed_quote" };
  if (current) parts.push(current);
  return parts.length ? parts : { error: "empty_command" };
}

function checkCommand(command: readonly string[], options: CodexCommandSupervisorOptions): CodexCommandSupervisorDecision {
  const commandText = command.join(" ");
  const policyCheck = checkCodexCommandPolicy(command, { expectedBranchName: options.expectedBranchName });
  if (policyCheck.allowed) {
    return { kind: "allowed", command, commandText, policy: options.commandProfile };
  }
  return {
    kind: "denied",
    command,
    commandText,
    policy: options.commandProfile,
    reason: policyCheck.reason,
  };
}

function parseJsonObject(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Readonly<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

function readCommandCandidate(
  event: Readonly<Record<string, unknown>>,
): readonly string[] | { readonly error: string; readonly commandText: string } | null {
  const type = readOptionalString(event.type ?? event.event ?? event.kind).toLowerCase();
  if (!/(command|exec|shell|terminal|process)/.test(type)) return null;
  const rawCommand = event.command ?? event.cmd ?? event.argv;
  if (Array.isArray(rawCommand) && rawCommand.every((part) => typeof part === "string")) return rawCommand;
  if (typeof rawCommand !== "string") return null;
  const parsed = parseCommandText(rawCommand);
  return "error" in parsed ? { error: parsed.error, commandText: rawCommand } : parsed;
}

function readOptionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
