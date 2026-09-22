#!/usr/bin/env node

// src/rollover/extension.ts
import { statSync } from "fs";

// src/acp/pi-settings.ts
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedPiSettings(cwd) {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

// src/rollover/config.ts
var DEFAULT_THRESHOLD_MB = 20;
var DEFAULT_TAIL_BUDGET_KB = 1024;
var ROLLOVER_DEFAULTS = {
  enabled: true,
  thresholdBytes: DEFAULT_THRESHOLD_MB * 1024 * 1024,
  tailBudgetBytes: DEFAULT_TAIL_BUDGET_KB * 1024
};
function positiveNumber(value, fallback, unit) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * unit) : fallback;
}
function section(settings) {
  const atrium = settings.atrium;
  if (!atrium || typeof atrium !== "object") return {};
  const rollover = atrium.rollover;
  return rollover && typeof rollover === "object" ? rollover : {};
}
function readRolloverConfig(cwd) {
  const configured = section(getMergedPiSettings(cwd));
  return {
    enabled: configured.enabled === void 0 ? ROLLOVER_DEFAULTS.enabled : configured.enabled !== false,
    thresholdBytes: positiveNumber(configured.thresholdMB, ROLLOVER_DEFAULTS.thresholdBytes, 1024 * 1024),
    tailBudgetBytes: positiveNumber(configured.tailBudgetKB, ROLLOVER_DEFAULTS.tailBudgetBytes, 1024)
  };
}

// src/rollover/plan.ts
var CARRY_CUSTOM_TYPE = "atrium-rollover-carry";
var CONTEXT_ENTRY_TYPES = /* @__PURE__ */ new Set(["message", "custom_message"]);
function dropDuplicateInjections(entries) {
  const keys = entries.map(
    (entry) => entry.type === "custom_message" ? `${entry.customType ?? ""}\0${JSON.stringify(entry.content ?? "")}` : ""
  );
  const lastIndexByContent = /* @__PURE__ */ new Map();
  keys.forEach((key, index) => {
    if (key) lastIndexByContent.set(key, index);
  });
  const kept = entries.filter((_entry, index) => !keys[index] || lastIndexByContent.get(keys[index]) === index);
  return { kept, dropped: entries.length - kept.length };
}
function entryBytes(entry) {
  return Buffer.byteLength(JSON.stringify(entry)) + 1;
}
function isUserMessage(entry) {
  return entry.type === "message" && entry.message?.role === "user";
}
function contentItems(message) {
  return Array.isArray(message.content) ? message.content : [];
}
function findCutIndex(branch, tailBudgetBytes) {
  const suffixBytes = new Array(branch.length + 1).fill(0);
  for (let i = branch.length - 1; i >= 0; i--) suffixBytes[i] = suffixBytes[i + 1] + entryBytes(branch[i]);
  let lastUser = -1;
  for (let i = 0; i < branch.length; i++) {
    if (!isUserMessage(branch[i])) continue;
    if (suffixBytes[i] <= tailBudgetBytes) return i;
    lastUser = i;
  }
  return lastUser >= 0 ? lastUser : branch.length;
}
function repairToolPairs(tail) {
  const callIds = /* @__PURE__ */ new Set();
  for (const entry of tail) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const item of contentItems(entry.message)) {
      if (item.type === "toolCall" && typeof item.id === "string") callIds.add(item.id);
    }
  }
  const resultIds = /* @__PURE__ */ new Set();
  let droppedOrphanResults = 0;
  const kept = [];
  for (const entry of tail) {
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const callId = entry.message.toolCallId;
      if (typeof callId !== "string" || !callIds.has(callId)) {
        droppedOrphanResults++;
        continue;
      }
      resultIds.add(callId);
    }
    kept.push(entry);
  }
  let strippedToolCalls = 0;
  const repaired = [];
  for (const entry of kept) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") {
      repaired.push(entry);
      continue;
    }
    const items = contentItems(entry.message);
    const survivors = items.filter((item) => {
      if (item.type !== "toolCall") return true;
      if (typeof item.id === "string" && resultIds.has(item.id)) return true;
      strippedToolCalls++;
      return false;
    });
    if (survivors.length === items.length) {
      repaired.push(entry);
      continue;
    }
    if (survivors.length === 0) continue;
    repaired.push({ ...entry, message: { ...entry.message, content: survivors } });
  }
  return { repaired, droppedOrphanResults, strippedToolCalls };
}
function blockSection(block) {
  const topic = block.topic ? ` \xB7 ${block.topic}` : "";
  const tier = typeof block.tier === "number" ? ` (tier ${block.tier})` : "";
  return `### ${block.blockId}${topic}${tier}
${block.summary}`;
}
function entryText(entry) {
  if (typeof entry.content === "string") return entry.content;
  if (!Array.isArray(entry.content)) return "";
  return entry.content.map((item) => typeof item.text === "string" ? item.text : "").join("");
}
function inheritedCarry(branch, tail) {
  const carried = new Set(tail.map((entry) => entry.id));
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom_message" || entry.customType !== CARRY_CUSTOM_TYPE) continue;
    if (carried.has(entry.id)) return [];
    const text = entryText(entry);
    return text ? [`### \u4E0A\u4E00\u6B21\u4EA4\u63A5\u5E26\u8FC7\u6765\u7684\u4E0A\u4E0B\u6587
${text}`] : [];
  }
  return [];
}
function nativeSummaries(branch) {
  return branch.filter(
    (entry) => (entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string"
  ).map(
    (entry, index) => `### \u4E0A\u4E00\u6BB5\u7684 Pi ${entry.type === "compaction" ? "\u538B\u7F29" : "\u5206\u652F"}\u6458\u8981 ${index + 1}
${entry.summary}`
  );
}
function planRollover(branch, blocks, options) {
  const ordered = [...blocks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const { kept: contextual, dropped: droppedDuplicateInjections } = dropDuplicateInjections(
    branch.filter((entry) => CONTEXT_ENTRY_TYPES.has(entry.type))
  );
  const cutIndex = findCutIndex(contextual, options.tailBudgetBytes);
  const { repaired, droppedOrphanResults, strippedToolCalls } = repairToolPairs(contextual.slice(cutIndex));
  const inherited = ordered.length === 0 ? inheritedCarry(branch, repaired) : [];
  const sections = [...inherited, ...nativeSummaries(branch), ...ordered.map(blockSection)];
  const carryText = [
    "# \u4F1A\u8BDD\u63A5\u7EED\u4E0A\u4E0B\u6587",
    "",
    `\u672C\u4F1A\u8BDD\u7EED\u81EA ${options.parentFile}\uFF0C\u90A3\u4EFD\u6587\u4EF6\u539F\u6837\u4FDD\u7559\uFF0C\u9700\u8981\u539F\u6587\u65F6\u76F4\u63A5\u8BFB\u5B83\u3002`,
    sections.length > 0 ? `\u4E0B\u9762\u662F\u4E0A\u4E00\u6BB5\u7684\u538B\u7F29\u4E0A\u4E0B\u6587\uFF0C\u5171 ${sections.length} \u6BB5\u6458\u8981\uFF1B\u672C\u6761\u4E4B\u540E\u662F\u4E0A\u4E00\u6BB5\u6700\u8FD1\u7684 ${repaired.length} \u6761\u539F\u6587\u6D88\u606F\u3002` : `\u4E0A\u4E00\u6BB5\u6CA1\u6709\u53EF\u7EE7\u627F\u7684\u6458\u8981\uFF1B\u672C\u6761\u4E4B\u540E\u53EA\u6709\u4E0A\u4E00\u6BB5\u6700\u8FD1\u7684 ${repaired.length} \u6761\u539F\u6587\u6D88\u606F\u3002`,
    "\u8FD9\u4E9B\u662F\u5DF2\u7ECF\u53D1\u751F\u7684\u5386\u53F2\u8BB0\u5F55\uFF0C\u4E0D\u662F\u5F85\u6267\u884C\u7684\u6307\u4EE4\u3002",
    ...sections.length > 0 ? ["", ...sections] : []
  ].join("\n");
  return {
    carryText,
    tail: repaired,
    stats: {
      branchEntries: branch.length,
      contextEntries: contextual.length,
      blocks: ordered.length,
      carryBytes: Buffer.byteLength(carryText),
      tailEntries: repaired.length,
      tailBytes: repaired.reduce((total, entry) => total + entryBytes(entry), 0),
      cutIndex,
      inheritedCarry: inherited.length > 0,
      droppedDuplicateInjections,
      droppedOrphanResults,
      strippedToolCalls
    }
  };
}

// src/rollover/sidecar.ts
import { readFileSync as readFileSync2 } from "fs";
function sidecarPathFor(sessionFile) {
  return `${sessionFile}.acp.json`;
}
function isBlock(value) {
  if (!value || typeof value !== "object") return false;
  const block = value;
  return typeof block.blockId === "string" && typeof block.summary === "string" && block.summary.length > 0;
}
function readActiveBlocks(sessionFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(sidecarPathFor(sessionFile), "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const blocks = parsed.blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(isBlock).filter((block) => block.active === true);
}

// src/rollover/extension.ts
function humanBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
}
function sessionBytes(sessionFile) {
  try {
    return statSync(sessionFile).size;
  } catch {
    return 0;
  }
}
function describe(plan, sessionFile) {
  const { stats } = plan;
  const notes = [
    stats.blocks === 0 && !stats.inheritedCarry ? "\u6CE8\u610F\uFF1A\u6CA1\u6709\u53EF\u7EE7\u627F\u7684\u6458\u8981\uFF0C\u5207\u70B9\u4E4B\u524D\u7684\u5386\u53F2\u53EA\u4F1A\u7559\u5728\u65E7\u6587\u4EF6\u91CC\uFF0C\u4E0D\u8FDB\u5165\u65B0\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u3002" : "\u65E7\u4F1A\u8BDD\u6587\u4EF6\u539F\u6837\u4FDD\u7559\uFF0C/resume \u4ECD\u53EF\u56DE\u53BB\u3002",
    stats.inheritedCarry ? "\u8FD8\u6CA1\u6709\u65B0\u7684\u538B\u7F29\u5757\uFF0C\u4E0A\u4E00\u6B21\u4EA4\u63A5\u7684\u63A5\u7EED\u6B63\u6587\u539F\u6837\u5F80\u4E0B\u4F20\u3002" : "",
    stats.droppedOrphanResults + stats.strippedToolCalls > 0 ? `\u4FEE\u6389\u8DE8\u5207\u70B9\u7684\u5DE5\u5177\u8C03\u7528\uFF1A\u4E22\u5F03 ${stats.droppedOrphanResults} \u6761\u5B64\u513F\u7ED3\u679C\uFF0C\u5265\u6389 ${stats.strippedToolCalls} \u4E2A\u60AC\u7A7A\u8C03\u7528\u3002` : "",
    stats.droppedDuplicateInjections > 0 ? `\u5408\u5E76 ${stats.droppedDuplicateInjections} \u6761\u91CD\u590D\u7684\u6269\u5C55\u6CE8\u5165\uFF0C\u6BCF\u79CD\u5185\u5BB9\u53EA\u7559\u6700\u540E\u4E00\u6761\u3002` : ""
  ].filter(Boolean);
  return [
    `\u5F53\u524D\u4F1A\u8BDD ${humanBytes(sessionBytes(sessionFile))}\uFF0C\u5171 ${stats.branchEntries} \u6761\u3002`,
    `\u65B0\u4F1A\u8BDD\u5C06\u5E26\u4E0A ${stats.blocks} \u4E2A\u6458\u8981\u5757\uFF08${humanBytes(stats.carryBytes)}\uFF09\u548C\u6700\u8FD1 ${stats.tailEntries} \u6761\u539F\u6587\uFF08${humanBytes(stats.tailBytes)}\uFF09\u3002`,
    ...notes
  ].join("\n").trim();
}
async function writePlan(sessionManager, plan) {
  sessionManager.appendCustomMessageEntry(CARRY_CUSTOM_TYPE, [{ type: "text", text: plan.carryText }], true);
  for (const entry of plan.tail) {
    if (entry.type === "message" && entry.message) sessionManager.appendMessage(entry.message);
    else if (entry.type === "custom_message" && typeof entry.customType === "string")
      sessionManager.appendCustomMessageEntry(
        entry.customType,
        entry.content ?? "",
        entry.display === true,
        entry.details
      );
  }
}
function rolloverExtension(pi) {
  let nudged = false;
  pi.on("session_start", () => {
    nudged = false;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (nudged || !ctx.hasUI) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const config = readRolloverConfig(ctx.cwd);
    if (!config.enabled) return;
    const size = sessionBytes(sessionFile);
    if (size < config.thresholdBytes) return;
    nudged = true;
    ctx.ui.notify(
      `\u4F1A\u8BDD\u5DF2 ${humanBytes(size)}\uFF0C\u4E0B\u6B21 resume \u4F1A\u660E\u663E\u53D8\u6162\u3002\u6267\u884C /rollover \u4EA4\u63A5\u5230\u65B0\u4F1A\u8BDD\uFF0C\u65E7\u4F1A\u8BDD\u539F\u6837\u4FDD\u7559\u3002`,
      "warning"
    );
  });
  pi.registerCommand("rollover", {
    description: "\u628A\u5F53\u524D\u957F\u4F1A\u8BDD\u4EA4\u63A5\u5230\u65B0\u4F1A\u8BDD\uFF1A\u5E26\u4E0A\u6458\u8981\u548C\u6700\u8FD1\u539F\u6587\uFF0C\u65E7\u6587\u4EF6\u4FDD\u7559",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("\u5F53\u524D\u4F1A\u8BDD\u6CA1\u6709\u843D\u76D8\uFF0C\u65E0\u6CD5\u4EA4\u63A5\u3002", "error");
        return;
      }
      const config = readRolloverConfig(ctx.cwd);
      const plan = planRollover(ctx.sessionManager.getBranch(), readActiveBlocks(sessionFile), {
        parentFile: sessionFile,
        tailBudgetBytes: config.tailBudgetBytes
      });
      if (plan.stats.tailEntries === 0 && plan.stats.blocks === 0) {
        ctx.ui.notify("\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u53EF\u4EA4\u63A5\u7684\u5185\u5BB9\u3002", "warning");
        return;
      }
      if (ctx.hasUI && !await ctx.ui.confirm("\u4EA4\u63A5\u5230\u65B0\u4F1A\u8BDD\uFF1F", describe(plan, sessionFile))) return;
      const result = await ctx.newSession({
        parentSession: sessionFile,
        setup: async (sessionManager) => writePlan(sessionManager, plan)
      });
      if (result.cancelled) ctx.ui.notify("\u4EA4\u63A5\u88AB\u53D6\u6D88\u3002", "warning");
    }
  });
}
export {
  rolloverExtension as default
};
//# sourceMappingURL=rollover.js.map