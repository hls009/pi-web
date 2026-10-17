import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { PromptOptimizeError, runPromptOptimize } from "@/lib/prompt-optimize-run";

export const dynamic = "force-dynamic";

/** A composer draft, not a document: anything longer is not a request to rewrite. */
const MAX_BODY_CHARS = 20_000;
const MAX_COMMAND_CHARS = 200;

interface OptimizeRequestBody {
  body?: unknown;
  command?: unknown;
  commandDescription?: unknown;
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  search?: unknown;
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

// POST /api/prompt/optimize
// body: { body: string; command?: string; commandDescription?: string; cwd?: string;
//         provider: string; modelId: string; search?: boolean }
// Rewrites a composer draft through one model call (two with `search`). Creates
// nothing: no session, no file on disk. The rewritten text goes back to the
// browser, which decides whether to keep it.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let payload: OptimizeRequestBody;
  try {
    payload = await req.json() as OptimizeRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!body) return NextResponse.json({ error: "body is required" }, { status: 400 });
  if (body.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: `body must be at most ${MAX_BODY_CHARS} characters` }, { status: 400 });
  }

  const provider = optionalText(payload.provider, 200);
  const modelId = optionalText(payload.modelId, 200);
  if (!provider || !modelId) {
    return NextResponse.json({ error: "provider and modelId are required" }, { status: 400 });
  }

  const command = optionalText(payload.command, MAX_COMMAND_CHARS);
  const commandDescription = optionalText(payload.commandDescription, MAX_COMMAND_CHARS);
  const cwd = optionalText(payload.cwd, 4_096);

  try {
    const result = await runPromptOptimize({
      body,
      ...(command ? { command } : {}),
      ...(commandDescription ? { commandDescription } : {}),
      search: payload.search === true,
      ...(cwd ? { cwd } : {}),
      provider,
      modelId,
      signal: req.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PromptOptimizeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // A cancelled request has no one left to answer.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
