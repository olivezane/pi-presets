// /preset — switch which packages/extensions load, from ~/.pi/agent/presets.json
// presets.json: { "active": "web", "shared": ["npm:..."], "presets": { "web": { "packages": ["npm:..."] } } }
// "shared" packages are prepended to every preset: one place for what all scenarios need.
// A preset is a set of top-level settings.json overrides: /preset writes them, then reloads.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

const agentDir = getAgentDir();
const presetsFile = join(agentDir, "presets.json");
const settingsFile = join(agentDir, "settings.json");
const mcpFile = join(agentDir, "mcp.json");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
// Atomic, so a crash or full disk never leaves settings.json half-written (pi would not boot).
const writeAtomic = (file, text) => {
  const tmp = file + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};
const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
const sourceOf = (entry) => (typeof entry === "string" ? entry : entry?.source);
const sameSource = (entry, src) => sourceOf(entry) === src;

// Actual packages a preset loads: shared first, then its own, no duplicates by source.
function effectivePackages(cfg, packages) {
  const seen = new Set();
  return [...(cfg.shared ?? []), ...(packages ?? [])].filter((entry) => {
    const src = sourceOf(entry);
    if (seen.has(src)) return false;
    seen.add(src);
    return true;
  });
}

// Shared ones are re-added on every apply, so a preset snapshot must not keep its own copy.
const withoutShared = (cfg, packages) =>
  (packages ?? []).filter((entry) => !(cfg.shared ?? []).some((shared) => sameSource(shared, sourceOf(entry))));

function loadPresets() {
  if (existsSync(presetsFile)) {
    try {
      const cfg = readJson(presetsFile);
      if (cfg.shared !== undefined && !Array.isArray(cfg.shared)) throw new Error(presetsFile + " has a malformed shared list. Fix it; nothing was written.");
      return cfg;
    } catch {
      // Never overwrite it from here: the user's presets are still in that file.
      throw new Error(presetsFile + " is not valid JSON. Fix or delete it; nothing was written.");
    }
  }
  // First run: keep the current package list as the "default" preset.
  const settings = existsSync(settingsFile) ? readJson(settingsFile) : {};
  const init = { active: "default", presets: { default: { packages: settings.packages ?? [] } } };
  writeJson(presetsFile, init);
  return init;
}

const loadSettings = () => (existsSync(settingsFile) ? readJson(settingsFile) : {});

// Copy what is really on disk back into the preset that owns it, so "pi install" /
// "pi mcp add" land in it. A preset without "mcp" leaves mcp.json alone (shared).
function snapshotActive(cfg, settings) {
  const active = cfg.active && cfg.presets?.[cfg.active] ? cfg.active : undefined;
  if (!active) return undefined;
  cfg.presets[active].packages = withoutShared(cfg, settings.packages);
  if (existsSync(mcpFile)) cfg.presets[active].mcp = readJson(mcpFile);
  return active;
}

const HELP = [
  "/preset                              this help",
  "/preset add [name] <source...>       add packages (unknown name: create that preset)",
  "/preset remove [name] <source...>    drop packages (name only: delete the preset)",
  "/preset use [name]                   switch (no name: pick from the list)",
  "/preset update [name|*]              pi update --extensions, per preset",
  "/preset shared [add|remove <source...>]",
  "/preset default [name]               what quitting restores (Ctrl+S picks the active one)",
].join("\n");

// A preset name is a bare word; a package source carries npm:/git:/a path. Catches name typos.
const looksLikeSource = (token) =>
  /[:\\/]/.test(token) || token.startsWith(".") || token.startsWith("~") || /\.(ts|js|mjs|cjs)$/.test(token);

// Refuse to write a preset that would make settings.json useless to pi.
const packagesOk = (packages) =>
  packages === undefined ||
  (Array.isArray(packages) && packages.every((entry) => typeof entry === "string" || (typeof entry === "object" && entry !== null)));

// Write a preset into settings.json (+ mcp.json when it carries one) and persist presets.json.
function applyPreset(cfg, name) {
  const preset = cfg.presets?.[name];
  if (typeof preset !== "object" || preset === null) throw new Error("Unknown preset \"" + name + "\"");
  if (!packagesOk(preset.packages)) throw new Error("Preset \"" + name + "\" has a malformed packages list");
  const { mcp, ...overrides } = preset;
  if (existsSync(settingsFile)) copyFileSync(settingsFile, settingsFile + "." + name + ".bak");
  writeJson(settingsFile, { ...loadSettings(), ...overrides, packages: effectivePackages(cfg, preset.packages) });
  if (mcp && typeof mcp === "object") {
    if (existsSync(mcpFile)) copyFileSync(mcpFile, mcpFile + "." + name + ".bak");
    writeJson(mcpFile, mcp);
  }
  writeJson(presetsFile, { ...cfg, active: name });
}

// Remove our own leftovers: half-written .tmp files and backups of presets that no longer exist.
// (settings.json/<name>.bak style legacy backups are left alone.)
function cleanup(cfg) {
  try {
    for (const file of ["settings.json.tmp", "presets.json.tmp", "mcp.json.tmp"]) {
      const full = join(agentDir, file);
      if (existsSync(full)) rmSync(full);
    }
    const names = new Set(Object.keys(cfg.presets ?? {}));
    for (const entry of readdirSync(agentDir)) {
      const match = /^(settings|mcp)\.json\.(.+)\.bak$/.exec(entry);
      if (match && !names.has(match[2])) rmSync(join(agentDir, entry));
    }
  } catch {
    // Cleanup must never break a preset operation.
  }
}

// Reload, but undo the switch if the new package set cannot load: keep the session usable.
async function reloadSafely(ctx, restore) {
  try {
    await ctx.reload();
  } catch (error) {
    if (restore) {
      try {
        restore();
      } catch {
        // Restore is best effort; the backup is still on disk.
      }
    }
    ctx.ui.notify("Reload failed: " + String(error?.message ?? error) +
      (restore ? " — previous settings restored." : " — backups: " + settingsFile + ".<preset>.bak"), "error");
  }
}

export default function (pi) {
  pi.registerCommand("preset", {
    description: "Extension presets: /preset add|remove [<name>] <source...> edits a preset (default: the active one), /preset use [name] switches, /preset for help; shared/default/update for the rest",
    handler: async (args, ctx) => {
      let cfg;
      try {
        cfg = loadPresets();
      } catch (error) {
        ctx.ui.notify("Presets unavailable: " + String(error?.message ?? error), "error");
        return;
      }
      const settings = loadSettings();
      const names = Object.keys(cfg.presets ?? {});
      cleanup(cfg);
      const active = snapshotActive(cfg, settings);

      const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const save = (name) => {
        if (existsSync(settingsFile)) copyFileSync(settingsFile, settingsFile + "." + name + ".bak");
        writeJson(settingsFile, settings);
        writeJson(presetsFile, { ...cfg, active: name });
      };

      if (!first) {
        ctx.ui.notify(HELP + "\nPresets: " + (names.join(", ") || "(none)") + " (active: " + (cfg.active ?? "-") + ")", "info");
        return;
      }

      // Editing the active preset means rewriting settings.json and reloading;
      // any other preset is just saved in presets.json and applies on its next switch.
      const afterEdit = async (target) => {
        if (target !== active) {
          writeJson(presetsFile, cfg);
          ctx.ui.notify("Preset \"" + target + "\" updated. It applies the next time you switch to it.", "info");
          return;
        }
        settings.packages = effectivePackages(cfg, cfg.presets[target].packages);
        save(target);
        ctx.ui.notify("Preset \"" + target + "\" updated. Reloading...", "info");
        await reloadSafely(ctx, undefined);
      };

      // Deleting a preset is destructive; never the active one, never the default, always confirmed.
      const removePreset = async (name) => {
        if (name === active) {
          ctx.ui.notify("Cannot delete the active preset \"" + name + "\". Switch first: /preset use <other>.", "error");
          return;
        }
        if (name === (cfg.default ?? "default")) {
          ctx.ui.notify("Cannot delete the default preset \"" + name + "\". Change it first: /preset default <other>.", "error");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("Deleting a preset needs the interactive UI for the confirmation; nothing was deleted.", "error");
          return;
        }
        if (!(await ctx.ui.confirm("Delete preset \"" + name + "\"?", "Its package list and backups are removed. This cannot be undone."))) {
          ctx.ui.notify("Deletion cancelled; \"" + name + "\" is untouched.", "info");
          return;
        }
        delete cfg.presets[name];
        writeJson(presetsFile, cfg);
        cleanup(cfg);
        ctx.ui.notify("Preset \"" + name + "\" deleted.", "info");
      };

      const edit = async (target, op, srcs) => {
        if (!srcs.length) {
          ctx.ui.notify("Name at least one package: /preset " + op + " " + (target === active ? "" : target + " ") + "<source...>", "error");
          return;
        }
        const list = cfg.presets[target].packages ?? [];
        if (op === "add") {
          const clash = srcs.filter((src) => (cfg.shared ?? []).some((e) => sameSource(e, src)));
          if (clash.length) {
            ctx.ui.notify("Already shared (applies to every preset): " + clash.join(", ") + ". Use /preset shared remove if you only want it here.", "error");
            return;
          }
          cfg.presets[target].packages = [...list, ...srcs.filter((src) => !list.some((e) => sameSource(e, src)))];
        } else {
          cfg.presets[target].packages = list.filter((e) => !srcs.some((src) => sameSource(e, src)));
        }
        await afterEdit(target);
      };

      if (first === "update") {
        // pi update --extensions only reads settings.json, i.e. the active preset:
        // load each preset there in turn and put the file back afterwards.
        const targets = rest[0] && rest[0] !== "*" ? rest : names;
        const unknown = targets.filter((n) => typeof cfg.presets?.[n] !== "object");
        const cliPath = join(getPackageDir(), "dist", "bundle", "cli.js");
        if (unknown.length) {
          ctx.ui.notify("Unknown preset(s): " + unknown.join(", ") + ". Available: " + names.join(", "), "error");
          return;
        }
        if (!existsSync(cliPath)) {
          ctx.ui.notify("Cannot find the pi CLI at " + cliPath + ". Update each preset by hand.", "error");
          return;
        }
        const original = readFileSync(settingsFile, "utf8");
        try {
          for (const name of targets) {
            ctx.ui.notify("Updating packages of \"" + name + "\"...", "info");
            const body = JSON.parse(original);
            body.packages = effectivePackages(cfg, cfg.presets[name].packages);
            writeJson(settingsFile, body);
            const result = await pi.exec(process.execPath, [cliPath, "update", "--extensions"], { cwd: agentDir, timeout: 600000 });
            if (result.code !== 0) {
              ctx.ui.notify("Update of \"" + name + "\" failed (exit " + result.code + "): " + (result.stderr || result.stdout).trim().slice(-400), "error");
              break;
            }
          }
        } finally {
          writeFileSync(settingsFile, original);
        }
        ctx.ui.notify("Preset updates done. Reloading...", "info");
        await reloadSafely(ctx, undefined);
        return;
      }

      if (first === "shared") {
        const [op, ...srcs] = rest;
        if (!op) {
          const list = cfg.shared ?? [];
          ctx.ui.notify("Shared packages (every preset): " + (list.length ? list.map(sourceOf).join(", ") : "(none)") +
            " — usage: /preset shared add|remove <source...>", "info");
          return;
        }
        if (op !== "add" && op !== "remove") {
          ctx.ui.notify("Usage: /preset shared [add|remove] <source...>", "error");
          return;
        }
        if (!srcs.length) {
          ctx.ui.notify("Name at least one package: /preset shared " + op + " <source...>", "error");
          return;
        }
        const current = cfg.shared ?? [];
        cfg.shared = op === "add"
          ? [...current, ...srcs.filter((src) => !current.some((e) => sameSource(e, src)))]
          : current.filter((e) => !srcs.some((src) => sameSource(e, src)));
        if (!active) {
          writeJson(presetsFile, cfg);
          ctx.ui.notify("Shared packages updated. No active preset; run /preset <name> to apply them.", "info");
          return;
        }
        settings.packages = effectivePackages(cfg, cfg.presets[active].packages);
        save(active);
        ctx.ui.notify("Shared packages updated for \"" + active + "\". Reloading...", "info");
        await reloadSafely(ctx, undefined);
        return;
      }

      if (first === "default") {
        const target = rest[0];
        if (!target) {
          ctx.ui.notify("Default preset: " + (cfg.default ?? "default") + " (active: " + (cfg.active ?? "-") + ")", "info");
          return;
        }
        if (typeof cfg.presets?.[target] !== "object") {
          ctx.ui.notify("Unknown preset \"" + target + "\". Available: " + names.join(", "), "error");
          return;
        }
        writeJson(presetsFile, { ...cfg, default: target });
        ctx.ui.notify("Default preset set to \"" + target + "\". Quitting restores it.", "info");
        return;
      }

      if (first === "use") {
        let name = rest[0];
        if (!name) {
          if (!ctx.hasUI) {
            ctx.ui.notify("Presets: " + (names.join(", ") || "(none)") + " (active: " + (cfg.active ?? "-") + ")", "info");
            return;
          }
          name = await ctx.ui.select("Preset (active: " + (cfg.active ?? "-") + ")", names);
        }
        if (!name) return;
        if (typeof cfg.presets?.[name] !== "object") {
          ctx.ui.notify("Unknown preset \"" + name + "\". Available: " + names.join(", "), "error");
          return;
        }
        const before = cfg.active;
        const previous = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : undefined;
        try {
          applyPreset(cfg, name);
        } catch (error) {
          ctx.ui.notify("Not switching: " + String(error?.message ?? error) + ". settings.json untouched.", "error");
          return;
        }
        ctx.ui.notify("Preset \"" + name + "\" applied (backup: settings.json." + name + ".bak). Reloading...", "info");
        await reloadSafely(ctx, () => {
          if (previous !== undefined) writeAtomic(settingsFile, previous);
          writeJson(presetsFile, { ...cfg, active: before });
        });
        return;
      }

      if (first === "add" || first === "remove") {
        // /preset add [<preset>] <source...>: a known preset name is the target, a bare unknown word
        // followed by packages creates that preset, anything else is a package for the active preset.
        const known = typeof cfg.presets?.[rest[0]] === "object";
        const create = !known && first === "add" && rest.length > 1 && !looksLikeSource(rest[0]);
        const target = known || create ? rest[0] : active;
        const srcs = known || create ? rest.slice(1) : rest;
        if (!known && !create && srcs.length && !looksLikeSource(srcs[0])) {
          ctx.ui.notify("Not a preset or a package: \"" + srcs[0] + "\". Presets: " + (names.join(", ") || "(none)") +
            ". To create one: /preset add " + srcs[0] + " <source...>; a source looks like npm:x, git:github.com/u/r or ./my.ts.", "error");
          return;
        }
        if (!target) {
          ctx.ui.notify("No active preset yet. Name one: /preset " + first + " <preset> <source...>", "error");
          return;
        }
        if (first === "remove" && known && !srcs.length) {
          await removePreset(target);
          return;
        }
        if (create) (cfg.presets ??= {})[target] = { packages: [] };
        await edit(target, first, srcs);
        return;
      }

      // A bare preset name gets told which action it wants; actions always come first.
      ctx.ui.notify(typeof cfg.presets?.[first] === "object"
        ? "\"" + first + "\" is a preset, not an action. Switch: /preset use " + first + " — add: /preset add " + first + " <source...>."
        : "Unknown action \"" + first + "\". Run /preset for the list.", "error");
    },
  });

  // Ctrl+S marks the preset you are on as the default one, i.e. what quitting restores.
  pi.registerShortcut("ctrl+s", {
    description: "Make the active preset the default one",
    handler: (ctx) => {
      try {
        const cfg = loadPresets();
        cleanup(cfg);
        const active = snapshotActive(cfg, loadSettings());
        if (!active) {
          ctx.ui.notify("No active preset to set as default.", "error");
          return;
        }
        if ((cfg.default ?? "default") === active) {
          ctx.ui.notify("\"" + active + "\" is already the default preset.", "info");
          return;
        }
        writeJson(presetsFile, { ...cfg, default: active });
        ctx.ui.notify("Default preset is now \"" + active + "\". Quitting restores it.", "info");
      } catch (error) {
        ctx.ui.notify("Ctrl+S could not set the default preset: " + String(error?.message ?? error), "error");
      }
    },
  });

  // Going back to a fixed preset on exit, so the next launch starts clean.
  // presets.json may name it with a top-level "default"; ignores reload/new/resume/fork.
  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit") return;
    try {
      const cfg = loadPresets();
      cleanup(cfg);
      snapshotActive(cfg, loadSettings());
      const fallback = cfg.default ?? "default";
      if (typeof cfg.presets?.[fallback] === "object" && cfg.active !== fallback) applyPreset(cfg, fallback);
      else writeJson(presetsFile, cfg);
    } catch {
      // Never block quitting on a preset write.
    }
  });
}
