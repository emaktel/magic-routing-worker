/**
 * Magic Routing Worker
 *
 * Receives call context from the FreeSWITCH Lua script, fetches the
 * customer's routing code from PostgREST, loads it as a Dynamic Worker,
 * and returns the routing decision.
 *
 * The worker injects logging utilities into the sandbox so customer code
 * can call log() and all fetch() calls are automatically tracked. Logs
 * are returned in the response and broadcast via WebSocket for live testing.
 */

interface Env {
	LOADER: {
		load(options: {
			compatibilityDate: string;
			mainModule: string;
			modules: Record<string, string>;
			env?: Record<string, unknown>;
			globalOutbound?: Fetcher | null;
		}): {
			getEntrypoint(): {
				route(ctx: CallContext): Promise<RoutingResult>;
			};
		};
	};
	WEBSOCKET_WORKER: Fetcher;
	POSTGREST_URL: string;
	POSTGREST_API_KEY: string;
	MAGIC_ROUTING_API_KEY: string;
}

interface CallContext {
	uuid?: string;
	direction?: string;
	caller_id_number?: string;
	caller_id_name?: string;
	destination_number?: string;
	domain_name?: string;
	domain_uuid?: string;
	context?: string;
	accountcode?: string;
	start_epoch?: string;
	answered_epoch?: string;
	network_addr?: string;
	sip_from_user?: string;
	sip_to_user?: string;
	sip_req_user?: string;
	sip_contact_user?: string;
	sip_user_agent?: string;
	toll_free?: string;
	dialed_extension?: string;
	effective_caller_id_number?: string;
	timezone?: string;
	[key: string]: string | undefined;
}

interface RoutingResult {
	app: string;
	data?: string;
	continue_routing?: boolean;
	error?: string;
	/** Execution logs collected by the sandbox */
	_logs?: LogEntry[];
}

interface LogEntry {
	type: "log" | "fetch" | "decision" | "error";
	message: string;
	timestamp: number;
	data?: unknown;
}

interface RouteRequest {
	block_id: string;
	call_context: CallContext;
	test_user_uuid?: string;
	test_block_name?: string;
}

interface MagicRoutingBlock {
	id: string;
	code: string;
	domain_uuid?: string;
	enabled?: boolean;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/route" || request.method !== "POST") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}

		const apiKey = request.headers.get("X-API-Key");
		if (!apiKey || apiKey !== env.MAGIC_ROUTING_API_KEY) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const startTime = Date.now();

		try {
			const body = (await request.json()) as RouteRequest;
			const { block_id, call_context, test_user_uuid, test_block_name } = body;

			if (!block_id) {
				return Response.json({ error: "Missing block_id" }, { status: 400 });
			}

			const code = await fetchRoutingCode(env, block_id);
			if (!code) {
				const logs: LogEntry[] = [{ type: "error", message: "Routing block not found or disabled", timestamp: Date.now() }];
				if (test_user_uuid || call_context.domain_uuid) {
					await broadcastTestResult(env, { userUuid: test_user_uuid, domainUuid: call_context.domain_uuid }, {
						block_id, block_name: test_block_name, success: false,
						error: "Routing block not found or disabled",
						logs, call_context, duration_ms: Date.now() - startTime, timestamp: Date.now(),
					});
				}
				return Response.json({ error: "Routing block not found" }, { status: 404 });
			}

			// Build the instrumented worker module with logging
			const workerCode = buildWorkerModule(code);

			const worker = env.LOADER.load({
				compatibilityDate: "2026-03-01",
				mainModule: "magic.js",
				modules: { "magic.js": workerCode },
				globalOutbound: undefined,
			});

			const result = await worker.getEntrypoint().route(call_context);

			// Extract logs from the result
			const logs: LogEntry[] = result._logs || [];

			if (!result || !result.app) {
				logs.push({ type: "error", message: result?.error || "Invalid routing decision returned", timestamp: Date.now() });
				if (test_user_uuid || call_context.domain_uuid) {
					await broadcastTestResult(env, { userUuid: test_user_uuid, domainUuid: call_context.domain_uuid }, {
						block_id, block_name: test_block_name, success: false,
						error: result?.error || "Invalid routing decision",
						logs, call_context, duration_ms: Date.now() - startTime, timestamp: Date.now(),
					});
				}
				return Response.json({ error: "Invalid routing decision returned" }, { status: 500 });
			}

			const allowed = ["transfer", "bridge", "playback", "set", "hangup"];
			if (!allowed.includes(result.app)) {
				logs.push({ type: "error", message: `Disallowed app: ${result.app}`, timestamp: Date.now() });
				if (test_user_uuid || call_context.domain_uuid) {
					await broadcastTestResult(env, { userUuid: test_user_uuid, domainUuid: call_context.domain_uuid }, {
						block_id, block_name: test_block_name, success: false,
						error: `Disallowed app: ${result.app}`,
						logs, call_context, duration_ms: Date.now() - startTime, timestamp: Date.now(),
					});
				}
				return Response.json({ error: `Disallowed app: ${result.app}` }, { status: 400 });
			}

			const decision = {
				app: result.app,
				data: result.data || "",
				continue_routing: result.continue_routing || false,
			};

			// Add the final decision as a log entry
			logs.push({ type: "decision", message: `Routing decision: ${decision.app} → ${decision.data}`, timestamp: Date.now(), data: decision });

			// Broadcast result via WebSocket
			if (test_user_uuid || call_context.domain_uuid) {
				await broadcastTestResult(env, { userUuid: test_user_uuid, domainUuid: call_context.domain_uuid }, {
					block_id,
					block_name: test_block_name,
					success: true,
					decision,
					logs,
					call_context,
					duration_ms: Date.now() - startTime,
					timestamp: Date.now(),
				});
			}

			return Response.json(decision);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error";
			console.error("[magic-routing] Error:", message);
			return Response.json({ error: message }, { status: 500 });
		}
	},
};

// ─── WebSocket Broadcast ─────────────────────────────────────────────────────

async function broadcastTestResult(
	env: Env,
	targeting: { userUuid?: string; domainUuid?: string },
	data: Record<string, unknown>
): Promise<void> {
	try {
		const body: Record<string, unknown> = {
			type: "magic_routing_test_result",
			data,
		};
		if (targeting.userUuid) {
			body.userUuid = targeting.userUuid;
		} else if (targeting.domainUuid) {
			body.domainUuid = targeting.domainUuid;
		} else {
			return;
		}
		await env.WEBSOCKET_WORKER.fetch("https://internal/broadcast", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (err) {
		console.error("[magic-routing] Failed to broadcast test result:", err);
	}
}

// ─── PostgREST ───────────────────────────────────────────────────────────────

async function fetchRoutingCode(env: Env, blockId: string): Promise<string | null> {
	const url = `${env.POSTGREST_URL}/magic_routing?id=eq.${encodeURIComponent(blockId)}&enabled=eq.true&select=code&limit=1`;
	const resp = await fetch(url, {
		headers: {
			"Authorization": `Bearer ${env.POSTGREST_API_KEY}`,
			"Accept": "application/json",
		},
	});
	if (!resp.ok) {
		console.error("[magic-routing] PostgREST error:", resp.status, await resp.text());
		return null;
	}
	const rows = (await resp.json()) as MagicRoutingBlock[];
	if (!rows || rows.length === 0) return null;
	return rows[0].code;
}

// ─── Dynamic Worker Module Builder ───────────────────────────────────────────

/**
 * Wraps the customer's code with:
 * - A log() function that collects debug messages
 * - A wrapped fetch() that auto-logs API calls and responses
 * - Collects all logs and returns them alongside the routing decision
 */
function buildWorkerModule(customerCode: string): string {
	return `
// ─── Instrumentation Layer ───────────────────────────────────────────────────
const __logs = [];
const __startTime = Date.now();

function log(message, data) {
	__logs.push({
		type: "log",
		message: String(message),
		timestamp: Date.now(),
		data: data !== undefined ? data : undefined
	});
}

// Wrap the global fetch to auto-log API calls
const __originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
	const url = typeof input === "string" ? input : input.url;
	const method = init?.method || "GET";
	const fetchStart = Date.now();

	log("API call: " + method + " " + url);

	try {
		const response = await __originalFetch(input, init);
		const duration = Date.now() - fetchStart;

		// Clone response so we can read the body for logging without consuming it
		const cloned = response.clone();
		let responsePreview = "";
		try {
			const text = await cloned.text();
			responsePreview = text.length > 500 ? text.substring(0, 500) + "..." : text;
		} catch {}

		__logs.push({
			type: "fetch",
			message: method + " " + url + " → " + response.status + " (" + duration + "ms)",
			timestamp: Date.now(),
			data: {
				url,
				method,
				status: response.status,
				duration_ms: duration,
				response_preview: responsePreview
			}
		});

		return response;
	} catch (err) {
		__logs.push({
			type: "fetch",
			message: method + " " + url + " → FAILED: " + (err.message || err),
			timestamp: Date.now(),
			data: { url, method, error: err.message || String(err) }
		});
		throw err;
	}
};

// ─── Customer Code ───────────────────────────────────────────────────────────
${customerCode}

// ─── Entrypoint ──────────────────────────────────────────────────────────────
export default {
	async route(ctx) {
		if (typeof route !== "function") {
			return { error: "No route() function defined", _logs: __logs };
		}
		try {
			const result = await route(ctx);
			return { ...result, _logs: __logs };
		} catch (err) {
			__logs.push({
				type: "error",
				message: "Routing code error: " + (err.message || err),
				timestamp: Date.now()
			});
			return { error: err.message || "Routing code error", _logs: __logs };
		}
	}
};
`;
}
