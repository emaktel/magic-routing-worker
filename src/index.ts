/**
 * Magic Routing Worker
 *
 * Receives call context from the FreeSWITCH Lua script, fetches the
 * customer's routing code from PostgREST, loads it as a Dynamic Worker,
 * and returns the routing decision.
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
				route(ctx: CallContext): Promise<RoutingDecision>;
			};
		};
	};
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

interface RoutingDecision {
	app: string;
	data?: string;
	continue_routing?: boolean;
	error?: string;
}

interface RouteRequest {
	block_id: string;
	call_context: CallContext;
}

interface MagicRoutingBlock {
	id: string;
	code: string;
	domain_uuid?: string;
	enabled?: boolean;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// only accept POST to /route
		const url = new URL(request.url);
		if (url.pathname !== "/route" || request.method !== "POST") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}

		// authenticate
		const apiKey = request.headers.get("X-API-Key");
		if (!apiKey || apiKey !== env.MAGIC_ROUTING_API_KEY) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		try {
			const body = (await request.json()) as RouteRequest;
			const { block_id, call_context } = body;

			if (!block_id) {
				return Response.json({ error: "Missing block_id" }, { status: 400 });
			}

			// fetch the customer's code from PostgREST
			const code = await fetchRoutingCode(env, block_id);
			if (!code) {
				return Response.json({ error: "Routing block not found" }, { status: 404 });
			}

			// wrap customer code in a Dynamic Worker module
			const workerCode = buildWorkerModule(code);

			// load and execute the Dynamic Worker
			const worker = env.LOADER.load({
				compatibilityDate: "2026-03-01",
				mainModule: "magic.js",
				modules: { "magic.js": workerCode },
				// allow outbound fetch so customer code can call external APIs
				globalOutbound: undefined,
			});

			const result = await worker.getEntrypoint().route(call_context);

			// validate the response
			if (!result || !result.app) {
				return Response.json({ error: "Invalid routing decision returned" }, { status: 500 });
			}

			const allowed = ["transfer", "bridge", "playback", "set", "hangup"];
			if (!allowed.includes(result.app)) {
				return Response.json(
					{ error: `Disallowed app: ${result.app}` },
					{ status: 400 }
				);
			}

			return Response.json({
				app: result.app,
				data: result.data || "",
				continue_routing: result.continue_routing || false,
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Unknown error";
			console.error("[magic-routing] Error:", message);
			return Response.json({ error: message }, { status: 500 });
		}
	},
};

/**
 * Fetch the customer's routing code from PostgREST.
 *
 * Expects a table like:
 *   magic_routing(magic_routing_uuid uuid PK, code text, domain_uuid uuid, enabled bool)
 */
async function fetchRoutingCode(env: Env, blockId: string): Promise<string | null> {
	const url = `${env.POSTGREST_URL}/magic_routing?magic_routing_uuid=eq.${encodeURIComponent(blockId)}&enabled=eq.true&select=code&limit=1`;

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
	if (!rows || rows.length === 0) {
		return null;
	}

	return rows[0].code;
}

/**
 * Wraps the customer's code in a Dynamic Worker module.
 *
 * The customer writes a `route(ctx)` function that receives call context
 * and returns { app, data, continue_routing? }.
 *
 * Example customer code:
 *
 *   async function route(ctx) {
 *     const weather = await fetch("https://api.weather.com/...");
 *     const data = await weather.json();
 *     if (data.condition === "sunny") {
 *       return { app: "transfer", data: "100 XML default" };
 *     }
 *     return { app: "transfer", data: "200 XML default" };
 *   }
 */
function buildWorkerModule(customerCode: string): string {
	return `
// Customer-defined routing logic
${customerCode}

// Dynamic Worker entrypoint
export default {
	async route(ctx) {
		if (typeof route !== "function") {
			return { error: "No route() function defined" };
		}
		try {
			const result = await route(ctx);
			return result;
		} catch (err) {
			return { error: err.message || "Routing code error" };
		}
	}
};
`;
}
