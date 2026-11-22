/**
 * Self-check for the presets extension. Run: node test/main.mjs
 *
 * The extension imports getAgentDir/getPackageDir from the pi package, so every scenario copies
 * extensions/presets.ts into a temp dir with those imports replaced by fakes, then drives the real
 * command, shortcut and shutdown hook through a fake pi API.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = readFileSync(new URL("../extensions/presets.ts", import.meta.url), "utf8").replace(
	'import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";',
	'const getAgentDir = () => process.env.TEST_AGENT_DIR; const getPackageDir = () => ".";',
);
if (!SOURCE.includes("process.env.TEST_AGENT_DIR")) throw new Error("transform failed");

let failed = 0;
const ok = (label, cond) => {
	console.log((cond ? "PASS " : "FAIL ") + label);
	if (!cond) failed++;
};
const srcs = (list) => list.map((entry) => (typeof entry === "string" ? entry : entry.source));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function setup({ settings, presets, mcp, files = {}, reloadThrows = false, idle = true, hasUI = false, confirm }) {
	const dir = mkdtempSync(join(tmpdir(), "presets-test-"));
	process.env.TEST_AGENT_DIR = dir;
	const write = (name, value) =>
		writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
	write("settings.json", settings);
	if (presets !== undefined) write("presets.json", presets);
	if (mcp !== undefined) write("mcp.json", mcp);
	for (const [name, value] of Object.entries(files)) write(name, value);

	const harness = join(dir, "presets.mjs");
	writeFileSync(harness, SOURCE);
	const mod = await import(pathToFileURL(harness).href);

	let cmd, shortcut, shutdown;
	const sent = [];
	mod.default({
		registerCommand: (_name, options) => { cmd = options; },
		registerShortcut: (_key, options) => { shortcut = options; },
		on: (_event, handler) => { shutdown = handler; },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		sendUserMessage: (text, options) => sent.push([text, options]),
	});

	const notify = [];
	const asked = [];
	const ui = { notify: (message, type = "info") => notify.push(`${type}: ${message}`) };
	if (confirm !== undefined) {
		ui.confirm = async (title) => {
			asked.push(title);
			return typeof confirm === "function" ? confirm(title) : confirm;
		};
	}
	const ctx = {
		ui,
		hasUI,
		isIdle: () => idle,
		reload: async () => {
			if (reloadThrows) throw new Error("package load failed");
		},
	};

	return {
		cmd, shortcut, shutdown, ctx, notify, sent, asked,
		last: () => notify.at(-1) ?? "",
		read: (name) => JSON.parse(readFileSync(join(dir, name), "utf8")),
		text: (name) => readFileSync(join(dir, name), "utf8"),
		has: (name) => existsSync(join(dir, name)),
		write,
	};
}

// --- switch, snapshot, quit -------------------------------------------------
{
	const t = await setup({
		settings: { packages: ["npm:a"], defaultModel: "x" },
		presets: {
			active: "default",
			presets: {
				default: { packages: ["npm:a"] },
				web: { packages: ["npm:b", "npm:c"], mcp: { mcpServers: { srv: { command: "x" } } } },
			},
		},
		mcp: { mcpServers: { old: { command: "y" } } },
	});

	await t.cmd.handler("use web", t.ctx);
	ok("switch applies the preset", t.read("presets.json").active === "web" && same(srcs(t.read("settings.json").packages), ["npm:b", "npm:c"]));
	ok("switch writes the preset's mcp.json", same(Object.keys(t.read("mcp.json").mcpServers), ["srv"]));
	ok("backup keeps the previous settings", t.text("settings.json.web.bak").includes("npm:a"));
	ok("snapshot captured default's mcp", same(t.read("presets.json").presets.default.mcp, { mcpServers: { old: { command: "y" } } }));

	await t.shutdown({ reason: "reload" }, t.ctx);
	ok("reload does not reset to default", t.read("presets.json").active === "web");

	await t.shutdown({ reason: "quit" }, t.ctx);
	const cfg = t.read("presets.json");
	ok("quit restores the default preset", cfg.active === "default" && same(srcs(t.read("settings.json").packages), ["npm:a"]));
	ok("quit restores the default mcp", same(Object.keys(t.read("mcp.json").mcpServers), ["old"]));
	ok("switched preset kept its own mcp", same(cfg.presets.web.mcp, { mcpServers: { srv: { command: "x" } } }));
	ok("settings keep unrelated keys", t.read("settings.json").defaultModel === "x");
}

// --- grammar: help, add/remove, delete confirmation, default, Ctrl+S --------
{
	const t = await setup({
		settings: { packages: ["npm:a"], defaultModel: "x" },
		presets: { active: "default", presets: { default: { packages: ["npm:a"] }, web: { packages: ["npm:b"] } } },
	});
	const snapshot = () => JSON.stringify(t.read("settings.json"));

	await t.cmd.handler("default", t.ctx);
	ok("bare /preset default only reports", t.read("presets.json").default === undefined);

	await t.cmd.handler("default web", t.ctx);
	ok("default set to web", t.read("presets.json").default === "web");

	await t.cmd.handler("default nope", t.ctx);
	ok("unknown default rejected", t.read("presets.json").default === "web");

	t.shortcut.handler(t.ctx);
	ok("ctrl+s sets the active preset as default", t.read("presets.json").default === "default" && t.sent.length === 0);

	await t.cmd.handler("use web", t.ctx);
	ok("active is web", t.read("presets.json").active === "web");
	t.shortcut.handler({ ...t.ctx, isIdle: () => false });
	ok("ctrl+s works while busy (no reload)", t.read("presets.json").default === "web");

	await t.cmd.handler("web", t.ctx);
	ok("bare /preset <name> rejected with hint", t.last().startsWith('error: "web" is a preset, not an action.'));

	t.shortcut.handler(t.ctx);
	ok("ctrl+s never dispatches a command", t.sent.length === 0 && t.read("presets.json").default === "web");

	await t.cmd.handler("use default", t.ctx);
	const settingsBefore = snapshot();
	await t.cmd.handler("", t.ctx);
	ok("bare /preset prints help", t.last().includes("/preset use [name]") && t.last().includes("Presets:"));
	ok("help changed nothing", snapshot() === settingsBefore && t.read("presets.json").active === "default");

	const webBefore = srcs(t.read("presets.json").presets.web.packages);
	await t.cmd.handler("add web npm:new", t.ctx);
	ok("name+source edits that preset", same(srcs(t.read("presets.json").presets.web.packages), [...webBefore, "npm:new"]));
	ok("non-active edit leaves settings alone", snapshot() === settingsBefore);

	const activeBefore = srcs(t.read("settings.json").packages);
	await t.cmd.handler("add npm:solo", t.ctx);
	ok("source only edits active preset", same(srcs(t.read("settings.json").packages), [...activeBefore, "npm:solo"]));

	await t.cmd.handler("remove npm:solo", t.ctx);
	ok("plain remove hits active", same(srcs(t.read("settings.json").packages), activeBefore));

	await t.cmd.handler("remove web npm:new", t.ctx);
	ok("named remove", !srcs(t.read("presets.json").presets.web.packages).includes("npm:new"));

	await t.cmd.handler("add webb", t.ctx);
	ok("lone unknown word rejected", t.last().startsWith("error: Not a preset or a package"));

	await t.cmd.handler("add fresh npm:f1 npm:f2", t.ctx);
	ok("add creates unknown preset", same(srcs(t.read("presets.json").presets.fresh.packages), ["npm:f1", "npm:f2"]));

	await t.cmd.handler("remove fresh", t.ctx);
	ok("delete refuses without UI", t.read("presets.json").presets.fresh !== undefined && t.last().includes("interactive UI"));

	const confirmCtx = (answer) => {
		const messages = [];
		return {
			messages,
			ctx: {
				...t.ctx,
				hasUI: true,
				ui: {
					notify: (message, type = "info") => messages.push(`${type}: ${message}`),
					confirm: async (title) => {
						t.asked.push(title);
						return answer;
					},
				},
			},
		};
	};

	let q = confirmCtx(false);
	await t.cmd.handler("remove fresh", q.ctx);
	ok("cancelled delete keeps the preset", t.read("presets.json").presets.fresh !== undefined && t.asked[0].includes("fresh"));

	q = confirmCtx(true);
	await t.cmd.handler("remove fresh", q.ctx);
	ok("confirmed delete removes the preset", t.read("presets.json").presets.fresh === undefined);

	q = confirmCtx(true);
	await t.cmd.handler("remove default", q.ctx);
	ok("active preset not deletable", t.read("presets.json").presets.default !== undefined && q.messages[0].includes("Cannot delete the active preset"));
}

// --- shared packages -------------------------------------------------------
{
	const t = await setup({
		settings: { packages: ["npm:a", "npm:s"] },
		presets: {
			active: "default",
			shared: ["npm:s"],
			presets: { default: { packages: ["npm:a"] }, web: { packages: ["npm:b"] }, dup: { packages: ["npm:s", "npm:b"] } },
		},
	});

	await t.cmd.handler("use web", t.ctx);
	ok("shared prepended on switch", same(srcs(t.read("settings.json").packages), ["npm:s", "npm:b"]));
	ok("preset keeps only its own", same(srcs(t.read("presets.json").presets.web.packages), ["npm:b"]));

	// simulate "pi install npm:x" inside web, then any /preset command snapshots it
	t.write("settings.json", { packages: ["npm:s", "npm:b", "npm:x"] });
	await t.cmd.handler("shared", t.ctx);
	ok("shared list shown", t.last().includes("npm:s"));

	await t.cmd.handler("shared add npm:z", t.ctx);
	ok("shared add lands in settings", same(srcs(t.read("settings.json").packages), ["npm:s", "npm:z", "npm:b", "npm:x"]));
	ok("shared add persisted", srcs(t.read("presets.json").shared).includes("npm:z"));
	ok("preset not polluted by shared", same(srcs(t.read("presets.json").presets.web.packages), ["npm:b", "npm:x"]));

	await t.cmd.handler("add npm:s", t.ctx);
	ok("add refuses shared source", t.last().startsWith("error: Already shared"));
	ok("shared source not re-added to preset", !srcs(t.read("presets.json").presets.web.packages).includes("npm:s"));

	await t.cmd.handler("shared remove npm:s", t.ctx);
	ok("shared remove drops from settings", same(srcs(t.read("settings.json").packages), ["npm:z", "npm:b", "npm:x"]));

	await t.cmd.handler("use dup", t.ctx);
	ok("shared not duplicated when preset lists it too", same(srcs(t.read("settings.json").packages), ["npm:z", "npm:s", "npm:b"]));

	await t.cmd.handler("shared bogus npm:q", t.ctx);
	ok("bad shared op rejected", t.last().startsWith("error: Usage"));

	const badCfg = t.read("presets.json");
	badCfg.shared = "npm:oops";
	t.write("presets.json", badCfg);
	const before = t.text("settings.json");
	await t.cmd.handler("use web", t.ctx);
	ok("malformed shared refused", t.last().startsWith("error: Presets unavailable") && t.text("settings.json") === before);
}

// --- preset names that look like subcommands ------------------------------
{
	const t = await setup({
		settings: { packages: ["npm:a"] },
		presets: {
			active: "default",
			shared: ["npm:s"],
			default: "update",
			presets: {
				default: { packages: ["npm:a"] },
				shared: { packages: ["npm:sh"] },
				use: { packages: ["npm:u"] },
				update: { packages: ["npm:up"] },
			},
		},
	});

	await t.cmd.handler("shared", t.ctx);
	ok("'/preset shared' still lists shared", t.last().includes("Shared packages"));
	ok("same-named preset not switched", t.read("presets.json").active === "default");

	await t.cmd.handler("use shared", t.ctx);
	ok("'/preset use shared' switches", t.read("presets.json").active === "shared" && srcs(t.read("settings.json").packages).includes("npm:sh"));

	await t.cmd.handler("use use", t.ctx);
	ok("'/preset use use' switches to preset 'use'", t.read("presets.json").active === "use");

	await t.cmd.handler("use", t.ctx);
	ok("bare use lists presets (no UI)", t.last().includes("Presets:"));

	await t.cmd.handler("update", t.ctx);
	ok("'/preset update' still takes the update branch", t.read("presets.json").active === "use" && t.last().includes("pi CLI"));

	const before = t.read("presets.json").active;
	t.shortcut.handler(t.ctx);
	ok("ctrl+s sets the active preset as default", t.read("presets.json").default === before && t.sent.length === 0);
}

// --- guards: bad input, failed reload, corrupt presets.json ----------------
{
	const t = await setup({
		settings: { packages: ["npm:a"], defaultModel: "x" },
		presets: { active: "default", presets: { default: { packages: ["npm:a"] }, bad: { packages: "npm:oops" } } },
	});
	const before = t.text("settings.json");
	await t.cmd.handler("use bad", t.ctx);
	ok("malformed preset refused", t.last().startsWith("error: Not switching"));
	ok("settings.json untouched", t.text("settings.json") === before);
	ok("active still default", t.read("presets.json").active === "default");
	ok("no .tmp left behind", !t.has("settings.json.tmp"));
}

{
	const t = await setup({
		settings: { packages: ["npm:a"], defaultModel: "x" },
		reloadThrows: true,
		presets: { active: "default", presets: { default: { packages: ["npm:a"] }, web: { packages: ["npm:b"] } } },
	});
	const before = t.text("settings.json");
	await t.cmd.handler("use web", t.ctx);
	ok("reload failure reported", t.last().startsWith("error: Reload failed"));
	ok("settings.json rolled back", t.text("settings.json") === before);
	ok("active rolled back", t.read("presets.json").active === "default");
	ok("in-memory snapshot kept", t.read("presets.json").presets.default.packages[0] === "npm:a");
}

{
	const t = await setup({ settings: { packages: ["npm:a"] }, presets: "{ not json" });
	const before = t.text("presets.json");
	await t.cmd.handler("default", t.ctx);
	ok("corrupt presets.json reports itself", t.last().startsWith("error: Presets unavailable") && t.last().includes("is not valid JSON"));
	ok("corrupt presets.json untouched", t.text("presets.json") === before);
}

{
	const t = await setup({
		settings: { packages: ["npm:a"] },
		presets: { active: "default", default: "web", presets: { default: { packages: ["npm:a"] }, web: { packages: ["npm:b"] } } },
	});
	await t.shortcut.handler(t.ctx);
	ok("ctrl+s sets default without touching settings", t.read("presets.json").default === "default" && same(srcs(t.read("settings.json").packages), ["npm:a"]));
}

// --- cleanup of leftovers --------------------------------------------------
{
	const t = await setup({
		settings: { packages: ["npm:a"] },
		presets: { active: "default", presets: { default: { packages: ["npm:a"] }, web: { packages: ["npm:b"] } } },
		files: {
			"settings.json.tmp": "{}",
			"presets.json.tmp": "{}",
			"mcp.json.tmp": "{}",
			"settings.json.gone.bak": "old",
			"mcp.json.gone.bak": "old",
			"settings.json.web.bak": "keep",
			"settings.json.bak": "legacy",
			"notes.txt": "keep",
		},
	});

	await t.cmd.handler("default", t.ctx);
	ok("tmp files removed", !t.has("settings.json.tmp") && !t.has("presets.json.tmp") && !t.has("mcp.json.tmp"));
	ok("orphan backups removed", !t.has("settings.json.gone.bak") && !t.has("mcp.json.gone.bak"));
	ok("live preset backup kept", t.has("settings.json.web.bak"));
	ok("legacy settings.json.bak kept", t.has("settings.json.bak"));
	ok("unrelated file kept", t.has("notes.txt"));
	ok("settings intact", t.read("settings.json").packages[0] === "npm:a");
}

if (failed > 0) {
	console.error(`${failed} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
