#!/usr/bin/env node
/**
 * End-to-end stress harness for the Obsidian MCP plugin.
 *
 * Drives a real client session against a running plugin instance: opens
 * /sse, captures the session id from the first `endpoint` event, sends
 * JSON-RPC requests via POST /messages, and correlates responses streamed
 * back over the SSE channel by request id.
 *
 * Configuration (via env or CLI):
 *   MCP_TOKEN   bearer token (required)
 *   MCP_URL     base URL, default http://localhost:48888 (test vault port)
 *   SCRATCH     scratch folder name in the vault, default __scratch__
 *
 *   Or as positional args: stress.mjs <token> [base-url]
 *
 * Tests are scoped to SCRATCH/. The harness will not touch any path
 * outside that folder, so it's safe to run against the fixture vault
 * (or any vault, in principle).
 */

import http from "node:http";
import { performance } from "node:perf_hooks";

const TOKEN = process.env.MCP_TOKEN || process.argv[2];
const BASE_URL = process.env.MCP_URL || process.argv[3] || "http://localhost:48888";
const SCRATCH = process.env.SCRATCH || "__scratch__";

if (!TOKEN) {
	console.error(
		"usage: MCP_TOKEN=... node tests/integration/stress.mjs [base-url]\n" +
			"   or: node tests/integration/stress.mjs <token> [base-url]"
	);
	process.exit(1);
}

const baseUrl = new URL(BASE_URL);
const HOST = baseUrl.hostname;
const PORT = Number(baseUrl.port) || 80;

// ──────────────────────────────────────────────────────────────────────
// SSE client + JSON-RPC dispatcher

const pending = new Map(); // id → { resolve, reject, ts }
let sessionId = null;
let nextId = 1;
let sseReq;

function openSession() {
	return new Promise((resolve, reject) => {
		sseReq = http.request(
			{
				hostname: HOST,
				port: PORT,
				path: "/sse",
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					Authorization: `Bearer ${TOKEN}`,
				},
			},
			(res) => {
				if (res.statusCode !== 200) {
					reject(new Error(`SSE failed: ${res.statusCode}`));
					return;
				}
				res.setEncoding("utf8");
				let buf = "";
				res.on("data", (chunk) => {
					buf += chunk;
					let idx;
					while ((idx = buf.indexOf("\n\n")) !== -1) {
						const raw = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						handleEvent(raw, resolve);
					}
				});
				res.on("end", () => console.error("[sse] stream ended"));
				res.on("error", (err) => console.error("[sse] error", err));
			}
		);
		sseReq.on("error", reject);
		sseReq.end();
	});
}

function handleEvent(raw, openSessionResolve) {
	const lines = raw.split("\n");
	let event = "message";
	let data = "";
	for (const line of lines) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) data += line.slice(5).trim();
	}
	if (event === "endpoint") {
		const m = data.match(/session_id=([0-9a-f-]+)/);
		if (m) {
			sessionId = m[1];
			openSessionResolve();
		}
		return;
	}
	if (event === "ping") return;
	if (event !== "message") return;

	let payload;
	try {
		payload = JSON.parse(data);
	} catch {
		return;
	}
	const handler = pending.get(payload.id);
	if (!handler) return;
	pending.delete(payload.id);
	const elapsed = performance.now() - handler.ts;
	if (payload.error) handler.reject({ ...payload.error, elapsed });
	else handler.resolve({ result: payload.result, elapsed });
}

function call(method, params) {
	return new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject, ts: performance.now() });

		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const req = http.request(
			{
				hostname: HOST,
				port: PORT,
				path: `/messages?session_id=${sessionId}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				if (res.statusCode !== 202) {
					pending.delete(id);
					reject(new Error(`POST returned ${res.statusCode}`));
				}
				res.resume();
			}
		);
		req.on("error", (err) => {
			pending.delete(id);
			reject(err);
		});
		req.write(body);
		req.end();

		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`timeout: ${method}`));
			}
		}, 10000);
	});
}

const callTool = (name, args) => call("tools/call", { name, arguments: args });
const textOf = (r) =>
	typeof r?.content?.[0]?.text === "string"
		? r.content[0].text
		: JSON.stringify(r);
const fmt = (n) => `${n.toFixed(1)}ms`;

// ──────────────────────────────────────────────────────────────────────
// Test plan

const log = (...a) => console.log(...a);
let warnings = 0;
const warn = (msg) => {
	warnings++;
	console.log(`  ⚠ ${msg}`);
};

// `obsidian_api` runs in a `new Function()` body — no top-level await.
// Wrap callers' code in an async IIFE that returns a promise; the handler
// awaits any thenable result automatically.
const apiCall = (body) =>
	callTool("obsidian_api", { functionBody: `return (async () => { ${body} })();` });

async function ensureFolder(p) {
	await apiCall(`
		const folder = ${JSON.stringify(p)};
		const existing = app.vault.getAbstractFileByPath(folder);
		if (!existing) await app.vault.createFolder(folder);
	`);
}

async function clearScratch() {
	// Wipe SCRATCH/ contents but keep the folder itself.
	await apiCall(`
		const root = ${JSON.stringify(SCRATCH)};
		const folder = app.vault.getAbstractFileByPath(root);
		if (!folder || folder.children === undefined) return { skipped: true };
		for (const child of [...folder.children]) {
			await app.vault.delete(child, true);
		}
		return { cleared: true };
	`);
}

async function main() {
	log("→ opening SSE session…");
	await openSession();
	log(`✓ session: ${sessionId}\n`);

	log("─── handshake ───────────────────────────────────────────────");
	const init = await call("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "stress", version: "1.0.0" },
	});
	log(
		`initialize → protocol=${init.result.protocolVersion} version=${init.result.serverInfo.version} (${fmt(init.elapsed)})`
	);
	const caps = Object.keys(init.result.capabilities);
	log(`  capabilities: [${caps.join(", ")}]`);
	for (const stale of ["roots", "prompts", "resources"]) {
		if (caps.includes(stale)) warn(`stale capability '${stale}' advertised`);
	}

	const tools = await call("tools/list");
	log(`tools/list → ${tools.result.tools.length} tools (${fmt(tools.elapsed)})`);
	const toolNames = tools.result.tools.map((t) => t.name).sort();
	log(`  ${toolNames.join(", ")}\n`);
	for (const removed of ["readFile", "writeFile", "listFiles", "getOpenFiles"]) {
		if (toolNames.includes(removed)) warn(`legacy tool '${removed}' still registered`);
	}

	log("─── notification (no JSON-RPC reply expected) ──────────────");
	await new Promise((resolve, reject) => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		const r = http.request(
			{
				hostname: HOST,
				port: PORT,
				path: `/messages?session_id=${sessionId}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				log(`  notifications/initialized → HTTP ${res.statusCode}`);
				res.resume();
				res.on("end", resolve);
			}
		);
		r.on("error", reject);
		r.write(body);
		r.end();
	});
	log("");

	log("─── stress read (parallel) ─────────────────────────────────");
	const filesRes = await callTool("get_workspace_files", {});
	const fileList = textOf(filesRes.result)
		.split("\n")
		.slice(1)
		.filter((l) => l.endsWith(".md") && !l.startsWith(SCRATCH + "/"));
	log(`  vault contains ${fileList.length} fixture .md files`);

	const SAMPLE = Math.min(20, fileList.length);
	const sample = [];
	for (let i = 0; i < SAMPLE; i++) {
		sample.push(fileList[Math.floor(Math.random() * fileList.length)]);
	}
	const t0 = performance.now();
	const reads = await Promise.allSettled(
		sample.map((p) => callTool("view", { path: p }))
	);
	const t1 = performance.now();
	const ok = reads.filter((r) => r.status === "fulfilled").length;
	const fail = reads.filter((r) => r.status === "rejected").length;
	log(`  ${SAMPLE} parallel reads: ${ok} ok, ${fail} fail, total ${fmt(t1 - t0)}`);
	const lat = reads
		.filter((r) => r.status === "fulfilled")
		.map((r) => r.value.elapsed)
		.sort((a, b) => a - b);
	if (lat.length) {
		log(
			`  per-call latency: p50=${fmt(lat[Math.floor(lat.length * 0.5)])} ` +
				`p95=${fmt(lat[Math.floor(lat.length * 0.95)])} ` +
				`max=${fmt(lat[lat.length - 1])}\n`
		);
	}

	log("─── scratch reset ──────────────────────────────────────────");
	await ensureFolder(SCRATCH);
	await clearScratch();
	log(`  ${SCRATCH}/ reset to empty\n`);

	log("─── create / write ─────────────────────────────────────────");
	const indexPath = `${SCRATCH}/index.md`;
	const childA = `${SCRATCH}/notes/alpha.md`;
	const childB = `${SCRATCH}/notes/beta.md`;
	// Intentionally NOT pre-creating `${SCRATCH}/notes` — the `create` tool
	// is expected to auto-mkdir parent folders. If this errors with ENOENT,
	// the auto-mkdir fix has regressed.

	const stamp = new Date().toISOString();
	const seeds = [
		[indexPath, `# Stress Index\n\nGenerated ${stamp}\n\n- [[notes/alpha]]\n- [[notes/beta]]\n`],
		[childA, `# alpha\n\nLine 1\nLine 2\nLine 3\n`],
		[childB, `# beta\n\nLine 1\nLine 2\nLine 3\n`],
	];
	for (const [p, content] of seeds) {
		const r = await callTool("create", { path: p, file_text: content });
		log(`  create ${p} → ok (${fmt(r.elapsed)})`);
	}

	log("\n─── view back ──────────────────────────────────────────────");
	const viewIndex = await callTool("view", { path: indexPath });
	const indexText = textOf(viewIndex.result);
	const indexHasStamp = indexText.includes(stamp);
	if (!indexHasStamp) warn("created file did not contain the stamp on read-back");
	log(`  view ${indexPath} → ${indexText.split("\n").length} lines, contains stamp=${indexHasStamp} (${fmt(viewIndex.elapsed)})`);

	log("\n─── str_replace ────────────────────────────────────────────");
	const sr = await callTool("str_replace", {
		path: childA,
		old_str: "Line 2",
		new_str: `Line 2 (edited at ${stamp})`,
	});
	log(`  str_replace ${childA} → ok (${fmt(sr.elapsed)})`);

	log("\n─── insert ─────────────────────────────────────────────────");
	const ins = await callTool("insert", {
		path: childB,
		insert_line: 1,
		new_str: `Inserted (${stamp})`,
	});
	log(`  insert ${childB}@1 → ok (${fmt(ins.elapsed)})`);

	log("\n─── directory listing ──────────────────────────────────────");
	const ls = await callTool("view", { path: SCRATCH });
	const lsText = textOf(ls.result);
	log(`  view ${SCRATCH}/:`);
	for (const line of lsText.split("\n")) log(`    ${line}`);
	// Post-fix expectation: the listing must include the `notes/` subfolder
	// alongside any direct files. Old code returned only direct files.
	if (!/\bnotes\/?\b/.test(lsText)) {
		warn("directory listing did not surface the 'notes' subfolder (regression of PR B.0 fix)");
	}

	log("\n─── edge-case reads ────────────────────────────────────────");
	const edges = [
		"edges/file with spaces.md",
		"edges/unicode-ファイル.md",
		"edges/empty.md",
		"nested/deep/three/levels.md",
	];
	for (const p of edges) {
		try {
			const r = await callTool("view", { path: p });
			const t = textOf(r.result);
			log(`  view ${p} → ${t.split("\n").length} lines (${fmt(r.elapsed)})`);
		} catch (err) {
			warn(`view ${p} → ERROR ${err.code}: ${err.message}`);
		}
	}

	log("\n─── metadata tools (PR B) ──────────────────────────────────");
	// Expectations come from test-fixtures/README.md. If you change the
	// fixture topology there, update both the file *and* these assertions.

	// get_frontmatter — basics/with-frontmatter.md has known YAML
	{
		const r = await callTool("get_frontmatter", {
			path: "basics/with-frontmatter.md",
		});
		try {
			const fm = JSON.parse(textOf(r.result));
			const ok =
				fm?.title === "Note With Frontmatter" &&
				Array.isArray(fm.tags) &&
				fm.tags.includes("yaml-tag-one");
			log(
				`  get_frontmatter basics/with-frontmatter.md → ${ok ? "ok" : "MISMATCH"} (${fmt(r.elapsed)})`
			);
			if (!ok) warn(`frontmatter parse mismatch: ${JSON.stringify(fm)}`);
		} catch (err) {
			warn(`frontmatter parse error: ${err}`);
		}
	}

	// get_backlinks — leaf-a is linked from hub AND leaf-c (per fixtures)
	{
		const r = await callTool("get_backlinks", { path: "links/leaf-a.md" });
		const text = textOf(r.result);
		const hasHub = text.includes("links/hub.md");
		const hasLeafC = text.includes("links/leaf-c.md");
		log(
			`  get_backlinks links/leaf-a.md → hub=${hasHub} leaf-c=${hasLeafC} (${fmt(r.elapsed)})`
		);
		if (!hasHub || !hasLeafC) {
			warn(
				"backlinks for leaf-a should include both hub AND leaf-c per fixture topology"
			);
		}
	}

	// get_outgoing_links — hub links to leaf-a, leaf-b, leaf-c
	{
		const r = await callTool("get_outgoing_links", { path: "links/hub.md" });
		const text = textOf(r.result);
		const targets = ["leaf-a", "leaf-b", "leaf-c"];
		const missing = targets.filter((t) => !text.includes(t));
		log(
			`  get_outgoing_links links/hub.md → ${targets.length - missing.length}/${targets.length} expected targets (${fmt(r.elapsed)})`
		);
		if (missing.length) warn(`hub.md missing outgoing links: ${missing.join(", ")}`);
	}

	// list_tags — fixture has #alpha, #beta, #project/april
	{
		const r = await callTool("list_tags", {});
		const text = textOf(r.result);
		const expected = ["#alpha", "#beta", "#project/april"];
		const missing = expected.filter((t) => !text.includes(t));
		log(
			`  list_tags → ${expected.length - missing.length}/${expected.length} expected tags present (${fmt(r.elapsed)})`
		);
		if (missing.length) warn(`list_tags missing: ${missing.join(", ")}`);
	}

	// find_by_tag — #project should match #project/april via nested matching
	{
		const r = await callTool("find_by_tag", {
			tag: "project",
			nested: true,
		});
		const text = textOf(r.result);
		const found = text.includes("basics/with-tags.md");
		log(
			`  find_by_tag project (nested) → matches with-tags.md=${found} (${fmt(r.elapsed)})`
		);
		if (!found) warn("find_by_tag with nested=true should match #project/april");
	}

	// find_by_tag — #project with nested=false should NOT match
	{
		const r = await callTool("find_by_tag", {
			tag: "project",
			nested: false,
		});
		const text = textOf(r.result);
		const found = text.includes("basics/with-tags.md");
		log(
			`  find_by_tag project (exact) → matches with-tags.md=${found} (${fmt(r.elapsed)})`
		);
		if (found) {
			warn(
				"find_by_tag with nested=false should NOT match #project/april — only an exact #project tag"
			);
		}
	}

	// search_vault — "Three Levels Deep" appears only in nested/deep/three/levels.md
	{
		const r = await callTool("search_vault", { query: "Three Levels Deep" });
		const text = textOf(r.result);
		const hit = text.includes("nested/deep/three/levels.md");
		log(
			`  search_vault 'Three Levels Deep' → found in expected file=${hit} (${fmt(r.elapsed)})`
		);
		if (!hit) warn("search_vault failed to find 'Three Levels Deep' in fixture");
	}

	// search_vault — case-insensitive by default
	{
		const r = await callTool("search_vault", { query: "THREE LEVELS DEEP" });
		const text = textOf(r.result);
		const hit = text.includes("nested/deep/three/levels.md");
		log(
			`  search_vault uppercase (case-insensitive default) → found=${hit} (${fmt(r.elapsed)})`
		);
		if (!hit) warn("search_vault should be case-insensitive by default");
	}

	log("\n─── streamable HTTP transport (PR C — /mcp) ────────────────");
	// New endpoint sits alongside /sse + /messages. Drives a parallel
	// session over the modern transport. If anything diverges between the
	// two (tool count, session handling, error shapes), we want to know.
	{
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json",
		};
		// Auto-inject MCP-Protocol-Version on post-init requests (anything
		// carrying a session id and not calling `initialize`). The server
		// rejects post-init calls without it; tests of header validation
		// should pass extra={MCP-Protocol-Version: ""} to opt out.
		const postMcp = (body, extra = {}) =>
			new Promise((resolve, reject) => {
				const isInit = Array.isArray(body)
					? body.some((m) => m?.method === "initialize")
					: body?.method === "initialize";
				const finalExtra = { ...extra };
				if (
					!isInit &&
					finalExtra["Mcp-Session-Id"] &&
					finalExtra["MCP-Protocol-Version"] === undefined
				) {
					finalExtra["MCP-Protocol-Version"] = "2024-11-05";
				}
				const data = JSON.stringify(body);
				const r = http.request(
					{
						hostname: HOST,
						port: PORT,
						path: "/mcp",
						method: "POST",
						headers: { ...headers, ...finalExtra, "Content-Length": Buffer.byteLength(data) },
					},
					(res) => {
						const chunks = [];
						res.on("data", (c) => chunks.push(c));
						res.on("end", () =>
							resolve({
								status: res.statusCode,
								headers: res.headers,
								body: Buffer.concat(chunks).toString("utf8"),
							})
						);
					}
				);
				r.on("error", reject);
				r.write(data);
				r.end();
				setTimeout(() => r.destroy(new Error("mcp timeout")), 10000);
			});

		// initialize → expect 200 + Mcp-Session-Id header
		const init = await postMcp({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "stress-mcp", version: "1.0.0" },
			},
		});
		const mcpSid = init.headers["mcp-session-id"];
		const initOk =
			init.status === 200 && typeof mcpSid === "string" && mcpSid.length > 0;
		log(`  POST /mcp initialize → status=${init.status} session=${initOk ? "ok" : "MISSING"}`);
		if (!initOk) warn("Streamable HTTP initialize did not return Mcp-Session-Id");

		// tools/list with the session header → expect same 13 tools as the SSE path
		const list = await postMcp(
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{ "Mcp-Session-Id": mcpSid }
		);
		const listPayload = JSON.parse(list.body);
		const mcpToolCount = listPayload.result?.tools?.length ?? 0;
		log(
			`  POST /mcp tools/list → ${mcpToolCount} tools (legacy /sse reported ${tools.result.tools.length})`
		);
		if (mcpToolCount !== tools.result.tools.length) {
			warn("tools/list count differs between /mcp and /sse transports");
		}

		// A read-only tool call to prove the dispatch chain works end-to-end
		const callRes = await postMcp(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "get_workspace_files", arguments: {} },
			},
			{ "Mcp-Session-Id": mcpSid }
		);
		const callPayload = JSON.parse(callRes.body);
		const callOk =
			callRes.status === 200 &&
			callPayload.result?.content?.[0]?.text?.includes(".md");
		log(
			`  POST /mcp tools/call(get_workspace_files) → ${callOk ? "ok" : "FAIL"}`
		);
		if (!callOk) warn("tools/call over /mcp did not return expected content");

		// notification → expect 202 Accepted, empty body
		const notif = await postMcp(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ "Mcp-Session-Id": mcpSid }
		);
		const notifOk = notif.status === 202 && notif.body === "";
		log(
			`  POST /mcp notifications/initialized → status=${notif.status}${notif.body ? " (body present!)" : ""}`
		);
		if (!notifOk) warn("Streamable HTTP notification handling broken");

		// Wrong session id → 404
		const bad = await postMcp(
			{ jsonrpc: "2.0", id: 4, method: "tools/list" },
			{ "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000" }
		);
		log(`  POST /mcp with bogus session → status=${bad.status} (expect 404)`);
		if (bad.status !== 404) warn("Bogus session id was not rejected with 404");

		// DELETE /mcp → 204; subsequent request should 404
		const del = await new Promise((resolve, reject) => {
			const r = http.request(
				{
					hostname: HOST,
					port: PORT,
					path: "/mcp",
					method: "DELETE",
					headers: {
						Authorization: `Bearer ${TOKEN}`,
						"Mcp-Session-Id": mcpSid,
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode));
				}
			);
			r.on("error", reject);
			r.end();
			setTimeout(() => r.destroy(new Error("delete timeout")), 5000);
		});
		log(`  DELETE /mcp → status=${del} (expect 204)`);
		if (del !== 204) warn("DELETE /mcp did not return 204");
	}

	log("\n─── negative tests ─────────────────────────────────────────");
	try {
		await callTool("view", { path: "../etc/passwd" });
		warn("path traversal NOT blocked!");
	} catch (err) {
		log(`  view ../etc/passwd → blocked (${err.code}: ${err.message})`);
	}
	try {
		await callTool("nonexistent_tool", {});
		warn("unknown tool returned success!");
	} catch (err) {
		log(`  unknown tool → ${err.code}: ${err.message}`);
	}
	try {
		await callTool("create", { path: indexPath, file_text: "x" });
		warn("create on existing file did not error!");
	} catch (err) {
		log(`  create existing → ${err.code}: ${err.message}`);
	}

	log("\n─── summary ────────────────────────────────────────────────");
	if (warnings === 0) {
		log("✓ stress test complete with no warnings");
	} else {
		log(`✓ stress test complete with ${warnings} warning(s) above`);
	}
	sseReq?.destroy();
	// Exit non-zero on any warning. Past versions intentionally exited 0
	// because some warnings tracked known-bug behavior we hadn't fixed
	// yet — those bugs are now fixed, so any warning here is a real
	// regression and should fail CI / show up in shell exit codes.
	process.exit(warnings === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("FATAL", err);
	sseReq?.destroy();
	process.exit(1);
});
