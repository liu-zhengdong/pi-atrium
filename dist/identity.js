#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/acp/paths.ts
import { homedir } from "os";
import { join, resolve } from "path";
function getPiAcpDir() {
  return process.env.PI_ACP_DIR ? resolve(process.env.PI_ACP_DIR) : join(homedir(), ".pi", "pi-acp");
}
var init_paths = __esm({
  "src/acp/paths.ts"() {
    "use strict";
  }
});

// src/pi-rpc/command.ts
import { statSync } from "fs";
import { platform as hostPlatform } from "os";
import { win32 } from "path";
function defaultPiCommand(platform = hostPlatform()) {
  return platform === "win32" ? "pi.cmd" : "pi";
}
function getPiCommand(override) {
  return override ?? defaultPiCommand();
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function resolveWindowsScriptCommand(command, cwd, pathValue, fileExists = isFile) {
  const normalized = command.trim();
  const explicitPath = win32.isAbsolute(normalized) || /[\\/:]/.test(normalized);
  const candidates = explicitPath ? [win32.resolve(cwd, normalized)] : [
    win32.resolve(cwd, normalized),
    ...pathValue.split(win32.delimiter).map((rawDir) => {
      const dir = rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir;
      return win32.resolve(cwd, dir || ".", normalized);
    })
  ];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}
function cmdToken(value) {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()%!^"<>&|]/g, (char) => char === "%" ? "%%" : `^${char}`);
}
function buildPiInvocation(command, args, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command.trim())) {
    return { executable: command, args: [...args] };
  }
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const pathValue = Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";
  const script = resolveWindowsScriptCommand(command, cwd, pathValue, opts.fileExists);
  if (!script) return null;
  const commandProcessor = env.ComSpec || env.COMSPEC || "cmd.exe";
  const commandLine = [script, ...args].map(cmdToken).join(" ");
  return {
    executable: commandProcessor,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}
var init_command = __esm({
  "src/pi-rpc/command.ts"() {
    "use strict";
  }
});

// src/runtime/launch-secret.ts
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join as join2 } from "path";
function readLaunchSecret(account, root = process.env[LAUNCH_SECRET_ROOT_ENV]) {
  if (!root || !isAbsolute(root)) throw new Error("Identity launch secret root is missing");
  if (!/^k[0-9]+$/.test(account)) throw new Error("Invalid launch secret account number");
  const safeRoot = realpathSync(root);
  const accountPath = join2(safeRoot, account);
  const path = join2(accountPath, LAUNCH_SECRET_NAME);
  if (realpathSync(accountPath) !== accountPath || realpathSync(path) !== path)
    throw new Error("Identity launch secret path leaves its account directory");
  const accountDir = lstatSync(accountPath);
  const file = lstatSync(path);
  if (!accountDir.isDirectory() || accountDir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink())
    throw new Error("Identity launch secret must be an ordinary file in an account directory");
  if (accountDir.uid !== process.getuid?.() || (accountDir.mode & 511) !== 448)
    throw new Error("Identity launch secret account directory must be private");
  if (file.uid !== process.getuid?.() || (file.mode & 511) !== 384 || file.size > 4097)
    throw new Error("Identity launch secret owner, mode or size is invalid");
  const value = readFileSync(path, "utf8").trim();
  if (!value || /\s/.test(value)) throw new Error("Identity launch secret is empty or malformed");
  return value;
}
function applyLaunchSecret(env, account, agentDirectory) {
  const token = readLaunchSecret(account);
  const configDir = join2(agentDirectory, "claude-code");
  mkdirSync(configDir, { recursive: true, mode: 448 });
  const stat = lstatSync(configDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 511) !== 448)
    throw new Error("Identity Claude config directory must be private");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX"
  ])
    delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
}
var IDENTITY_LAUNCH_SECRET_CAPABILITY, LAUNCH_SECRET_ROOT_ENV, LAUNCH_SECRET_NAME;
var init_launch_secret = __esm({
  "src/runtime/launch-secret.ts"() {
    "use strict";
    IDENTITY_LAUNCH_SECRET_CAPABILITY = "pi-acp/identity/launch-secret-file/v1";
    LAUNCH_SECRET_ROOT_ENV = "PI_ACP_LAUNCH_SECRET_ROOT";
    LAUNCH_SECRET_NAME = "claude-setup-token";
  }
});

// src/pi-rpc/mcp-servers.ts
var MCP_COMMAND, MCP_WIDGET, MAX_MCP_REQUEST_BYTES, McpConfigurationError;
var init_mcp_servers = __esm({
  "src/pi-rpc/mcp-servers.ts"() {
    "use strict";
    MCP_COMMAND = "pi-acp-mcp";
    MCP_WIDGET = "pi-acp-mcp-result";
    MAX_MCP_REQUEST_BYTES = 1024 * 1024;
    McpConfigurationError = class extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "McpConfigurationError";
      }
      code;
    };
  }
});

// src/pi-rpc/line-decoder.ts
import { StringDecoder } from "string_decoder";
var LfLineTooLongError, DEFAULT_MAX_BUFFERED_BYTES, LfLineDecoder;
var init_line_decoder = __esm({
  "src/pi-rpc/line-decoder.ts"() {
    "use strict";
    LfLineTooLongError = class extends Error {
      constructor(maxBufferedBytes) {
        super(`pi RPC stdout record exceeded the ${maxBufferedBytes}-byte framing limit`);
        this.maxBufferedBytes = maxBufferedBytes;
        this.name = "LfLineTooLongError";
      }
      maxBufferedBytes;
    };
    DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
    LfLineDecoder = class {
      constructor(maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {
        this.maxBufferedBytes = maxBufferedBytes;
      }
      maxBufferedBytes;
      decoder = new StringDecoder("utf8");
      parts = [];
      bytes = 0;
      lastCodeUnit = 0;
      append(text) {
        if (!text) return;
        this.bytes += Buffer.byteLength(text, "utf8");
        if (this.lastCodeUnit >= 55296 && this.lastCodeUnit <= 56319 && text.charCodeAt(0) >= 56320 && text.charCodeAt(0) <= 57343)
          this.bytes -= 2;
        this.lastCodeUnit = text.charCodeAt(text.length - 1);
        if (this.bytes > this.maxBufferedBytes) {
          this.parts = [];
          this.bytes = 0;
          this.lastCodeUnit = 0;
          throw new LfLineTooLongError(this.maxBufferedBytes);
        }
        this.parts.push(text);
      }
      take() {
        const line = this.parts.join("");
        this.parts = [];
        this.bytes = 0;
        this.lastCodeUnit = 0;
        return line;
      }
      /** Scan only new text: neither newline search nor byte accounting revisits a pending record. */
      push(chunk) {
        const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
        const lines = [];
        let start = 0;
        let newline;
        while ((newline = text.indexOf("\n", start)) !== -1) {
          this.append(text.slice(start, newline));
          lines.push(this.take());
          start = newline + 1;
        }
        this.append(text.slice(start));
        return lines;
      }
      end() {
        this.append(this.decoder.end());
        return this.take() || null;
      }
    };
  }
});

// src/pi-rpc/version.ts
import { spawn } from "child_process";
function parsePiVersion(raw) {
  const cleaned = raw.trim().replace(/^v/i, "");
  return SEMVER_REGEX.test(cleaned) ? cleaned : null;
}
function parseSemverParts(v) {
  const normalized = parsePiVersion(v);
  if (!normalized) throw new TypeError(`Invalid semantic version: ${v}`);
  const withoutBuild = normalized.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const base = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split(".");
  const [major, minor, patch] = base.split(".").map(BigInt);
  return { base: [major, minor, patch], prerelease };
}
function comparePiVersions(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1;
    if (pa.base[i] < pb.base[i]) return -1;
  }
  if (!pa.prerelease.length && !pb.prerelease.length) return 0;
  if (!pa.prerelease.length) return 1;
  if (!pb.prerelease.length) return -1;
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === void 0) return -1;
    if (ib === void 0) return 1;
    const numericA = /^\d+$/.test(ia);
    const numericB = /^\d+$/.test(ib);
    if (numericA && numericB) {
      const na = BigInt(ia);
      const nb = BigInt(ib);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (numericA) return -1;
    else if (numericB) return 1;
    else if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}
function versionFailure(command, cwd, detail) {
  return new PiVersionError(
    `Could not determine the pi version: \`${command} --version\` ${detail} from ${cwd}. pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event).`
  );
}
function abortReason(signal) {
  if (signal.reason !== void 0) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
function startVersionProbe(piCommand, cwd) {
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = new Promise((resolve2, reject) => {
    const invocation = buildPiInvocation(piCommand, ["--version"], { cwd });
    if (!invocation) return resolve2(null);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let abortedReason;
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) reject(outcome.error);
      else resolve2(outcome.value);
    };
    const onAbort = () => {
      if (settled || abortedReason !== void 0) return;
      abortedReason = abortReason(signal);
      child.kill("SIGKILL");
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.once("error", (error) => {
      if (abortedReason !== void 0) {
        settle({ error: abortedReason });
        return;
      }
      const code = error.code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOEXEC") settle({ value: null });
      else settle({ error: versionFailure(piCommand, cwd, String(error)) });
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      if (abortedReason !== void 0) {
        settle({ error: abortedReason });
        return;
      }
      const output = (stdout.trim() || stderr.trim()).slice(0, 120);
      if (code !== 0 || childSignal) {
        settle({
          error: versionFailure(
            piCommand,
            cwd,
            childSignal ? `was terminated by ${childSignal}` : `exited with status ${code}`
          )
        });
        return;
      }
      const version = parsePiVersion(output);
      if (!version) {
        settle({ error: versionFailure(piCommand, cwd, `printed ${JSON.stringify(output)}`) });
        return;
      }
      if (comparePiVersions(version, MIN_PI_VERSION) < 0) {
        settle({
          error: new PiVersionError(
            `Unsupported pi version ${version} (command: ${piCommand}). pi-acp requires pi >= ${MIN_PI_VERSION}, which adds the \`agent_settled\` RPC event used to close ACP prompt turns safely.`
          )
        });
        return;
      }
      settle({ value: version });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ error: versionFailure(piCommand, cwd, "timed out") });
    }, 15e3);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const probe = {
    promise,
    consumers: /* @__PURE__ */ new Set(),
    aborting: false,
    settled: false,
    abort() {
      if (probe.aborting || probe.settled) return;
      probe.aborting = true;
      controller.abort();
    }
  };
  void promise.then(
    () => {
      probe.settled = true;
    },
    () => {
      probe.settled = true;
    }
  );
  return probe;
}
function consumeVersionProbe(probe, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const consumer = /* @__PURE__ */ Symbol("version-probe-consumer");
  probe.consumers.add(consumer);
  return new Promise((resolve2, reject) => {
    let finished = false;
    let aborted = false;
    const detach = () => {
      signal?.removeEventListener("abort", onAbort);
      probe.consumers.delete(consumer);
    };
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      detach();
      if ("error" in outcome) reject(outcome.error);
      else resolve2(outcome.value);
    };
    const onAbort = () => {
      if (finished || aborted) return;
      aborted = true;
      const reason = abortReason(signal);
      detach();
      if (probe.consumers.size > 0 || probe.settled) {
        finished = true;
        reject(reason);
        return;
      }
      probe.abort();
      void probe.promise.then(
        () => finish({ error: reason }),
        () => finish({ error: reason })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void probe.promise.then(
      (value) => {
        if (!aborted) finish({ value });
      },
      (error) => {
        if (!aborted) finish({ error });
      }
    );
    if (signal?.aborted) onAbort();
  });
}
function assertSupportedPiVersion(piCommand, cwd = process.cwd(), signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const cacheKey = JSON.stringify([piCommand, cwd]);
  let probe = versionCache.get(cacheKey);
  if (!probe || probe.aborting) {
    probe = startVersionProbe(piCommand, cwd);
    versionCache.set(cacheKey, probe);
    void probe.promise.then(
      (version) => {
        if (version === null && versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey);
      },
      () => {
        if (versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey);
      }
    );
  }
  return consumeVersionProbe(probe, signal);
}
var MIN_PI_VERSION, PiVersionError, SEMVER_REGEX, versionCache;
var init_version = __esm({
  "src/pi-rpc/version.ts"() {
    "use strict";
    init_command();
    MIN_PI_VERSION = "0.80.4";
    PiVersionError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "PiVersionError";
      }
    };
    SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    versionCache = /* @__PURE__ */ new Map();
  }
});

// src/pi-rpc/protocol.ts
function decodePiRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  if (record.type === "response") {
    if (typeof record.command !== "string" || typeof record.success !== "boolean") return null;
    return {
      type: "response",
      id: typeof record.id === "string" ? record.id : void 0,
      command: record.command,
      success: record.success,
      data: record.data,
      error: typeof record.error === "string" ? record.error : void 0
    };
  }
  if (record.type === "extension_error") {
    if (typeof record.extensionPath !== "string" || typeof record.event !== "string" || typeof record.error !== "string")
      return null;
    return { type: "extension_error", extensionPath: record.extensionPath, event: record.event, error: record.error };
  }
  if (typeof record.type !== "string") return null;
  if (!KNOWN_EVENTS.has(record.type)) return { type: "ignored", originalType: record.type };
  return record;
}
var KNOWN_EVENTS;
var init_protocol = __esm({
  "src/pi-rpc/protocol.ts"() {
    "use strict";
    KNOWN_EVENTS = /* @__PURE__ */ new Set([
      "agent_start",
      "agent_end",
      "agent_settled",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "extension_ui_request",
      "queue_update",
      "session_info_changed",
      "thinking_level_changed",
      "auto_retry_start",
      "auto_retry_end",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
      "summarization_retry_finished",
      "auto_compaction_start",
      "auto_compaction_end",
      "compaction_start",
      "compaction_end"
    ]);
  }
});

// src/pi-rpc/process.ts
var process_exports = {};
__export(process_exports, {
  PiRpcClosedError: () => PiRpcClosedError,
  PiRpcProcess: () => PiRpcProcess,
  PiRpcRequestTimeoutError: () => PiRpcRequestTimeoutError,
  PiRpcSpawnError: () => PiRpcSpawnError
});
import { randomUUID } from "crypto";
import { existsSync, mkdirSync as mkdirSync2, writeFileSync, statSync as statSync2, unlinkSync } from "fs";
import { join as join3 } from "path";
import { fileURLToPath } from "url";
function piExecutableNotFoundError(cmd, cause) {
  return new PiRpcSpawnError(
    `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
    { code: "ENOENT", cause }
  );
}
var PiRpcSpawnError, PiRpcRequestTimeoutError, PiRpcClosedError, DEFAULT_REQUEST_TIMEOUT_MS, ABORT_TIMEOUT_MS, PROMPT_TIMEOUT_MS, COMPACT_TIMEOUT_MS, GET_ENTRIES_TIMEOUT_MS, EXPORT_TIMEOUT_MS, KILL_GRACE_MS, CLOSE_FALLBACK_MS, STDERR_TAIL_LIMIT, PiRpcProcess;
var init_process = __esm({
  "src/pi-rpc/process.ts"() {
    "use strict";
    init_identity();
    init_launch_secret();
    init_mcp_servers();
    init_command();
    init_line_decoder();
    init_version();
    init_protocol();
    PiRpcSpawnError = class extends Error {
      /** Underlying spawn error code, e.g. ENOENT, EACCES */
      code;
      constructor(message, opts) {
        super(message);
        this.name = "PiRpcSpawnError";
        this.code = opts?.code;
        this.cause = opts?.cause;
      }
    };
    PiRpcRequestTimeoutError = class extends Error {
      command;
      timeoutMs;
      constructor(command, timeoutMs) {
        super(`pi ${command} timed out after ${timeoutMs}ms: no RPC response from the pi subprocess.`);
        this.name = "PiRpcRequestTimeoutError";
        this.command = command;
        this.timeoutMs = timeoutMs;
      }
    };
    PiRpcClosedError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "PiRpcClosedError";
      }
    };
    DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
    ABORT_TIMEOUT_MS = 1e4;
    PROMPT_TIMEOUT_MS = 10 * 6e4;
    COMPACT_TIMEOUT_MS = 10 * 6e4;
    GET_ENTRIES_TIMEOUT_MS = 2 * 6e4;
    EXPORT_TIMEOUT_MS = 2 * 6e4;
    KILL_GRACE_MS = 2e3;
    CLOSE_FALLBACK_MS = 1e3;
    STDERR_TAIL_LIMIT = 8 * 1024;
    PiRpcProcess = class _PiRpcProcess {
      child;
      pending = /* @__PURE__ */ new Map();
      eventHandlers = [];
      terminationHandlers = [];
      requestTimeoutMs;
      killGraceMs;
      closeFallbackMs;
      stderrTailBuf = "";
      termination = null;
      disposeRequested = false;
      disposeIsExpected = false;
      killTimer;
      exitFallbackTimer;
      constructor(child, opts) {
        this.child = child;
        this.requestTimeoutMs = opts?.requestTimeoutMs;
        this.killGraceMs = opts?.killGraceMs ?? KILL_GRACE_MS;
        this.closeFallbackMs = opts?.closeFallbackMs ?? CLOSE_FALLBACK_MS;
        const decoder = new LfLineDecoder(opts?.maxStdoutRecordBytes);
        child.stdout.on("data", (chunk) => {
          try {
            for (const line of decoder.push(chunk)) this.handleStdoutLine(line);
          } catch {
            this.dispose({ expected: false });
          }
        });
        child.stdout.on("end", () => {
          try {
            const rest = decoder.end();
            if (rest !== null) this.handleStdoutLine(rest);
          } catch {
            this.dispose({ expected: false });
          }
        });
        child.stderr.on("data", (chunk) => {
          this.stderrTailBuf = (this.stderrTailBuf + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
        });
        child.on("error", (err) => {
          if (child.pid === void 0) {
            this.settleTermination({
              reason: "error",
              code: null,
              signal: null,
              error: err
            });
          }
        });
        child.on("exit", (code, signal) => {
          const timer = setTimeout(() => this.settleTermination({ reason: "exit", code, signal }), this.closeFallbackMs);
          this.exitFallbackTimer = timer;
        });
        child.on("close", (code, signal) => {
          this.settleTermination({ reason: "exit", code, signal });
        });
      }
      /**
       * Wrap an already-spawned pi RPC child process.
       * Test seam: production code must go through {@link PiRpcProcess.spawn}.
       */
      static fromChild(child, opts) {
        return new _PiRpcProcess(child, opts);
      }
      handleStdoutLine(line) {
        if (this.disposeRequested || this.termination || !line.trim()) return;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const decoded = decodePiRecord(msg);
        if (!decoded) return;
        if (decoded.type === "response" && "command" in decoded && "success" in decoded) {
          if (typeof decoded.id !== "string") return;
          const entry = this.takePending(decoded.id);
          if (!entry) return;
          const response = decoded;
          try {
            entry.beforeResolve?.(response);
            entry.resolve(response);
          } catch (error) {
            entry.reject(error);
          }
          return;
        }
        this.dispatchEvent(decoded);
      }
      dispatchEvent(ev) {
        for (const handler of [...this.eventHandlers]) {
          try {
            handler(ev);
          } catch {
          }
        }
      }
      takePending(id) {
        const entry = this.pending.get(id);
        if (!entry) return void 0;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        return entry;
      }
      rejectAllPending(err) {
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const entry of entries) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(err);
        }
      }
      settleTermination(info) {
        if (this.termination) return;
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = void 0;
        }
        if (this.exitFallbackTimer) {
          clearTimeout(this.exitFallbackTimer);
          this.exitFallbackTimer = void 0;
        }
        this.termination = {
          ...info,
          expected: this.disposeIsExpected,
          stderrTail: this.stderrTailBuf
        };
        this.rejectAllPending(this.closedError());
        const handlers = [...this.terminationHandlers];
        this.terminationHandlers = [];
        for (const handler of handlers) {
          try {
            handler(this.termination);
          } catch {
          }
        }
      }
      closedError() {
        const t = this.termination;
        if (!t) return new PiRpcClosedError("pi process is shutting down");
        const base = t.reason === "error" ? `pi process failed: ${t.error instanceof Error ? t.error.message : String(t.error)}` : `pi process exited (code=${t.code}, signal=${t.signal})`;
        const tail = t.stderrTail.trim();
        return new PiRpcClosedError(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base);
      }
      timeoutForCommand(type) {
        if (this.requestTimeoutMs !== void 0) return this.requestTimeoutMs;
        switch (type) {
          case "abort":
            return ABORT_TIMEOUT_MS;
          case "prompt":
            return PROMPT_TIMEOUT_MS;
          case "compact":
            return COMPACT_TIMEOUT_MS;
          case "get_entries":
            return GET_ENTRIES_TIMEOUT_MS;
          case "export_html":
            return EXPORT_TIMEOUT_MS;
          default:
            return DEFAULT_REQUEST_TIMEOUT_MS;
        }
      }
      static async spawn(params) {
        const cmd = getPiCommand(params.piCommand);
        try {
          await assertSupportedPiVersion(cmd, params.cwd, params.signal);
        } catch (e) {
          if (e instanceof PiVersionError) {
            throw new PiRpcSpawnError(e.message, { code: "UNSUPPORTED_PI_VERSION", cause: e });
          }
          throw e;
        }
        const extension = new URL("./acp-extension.js", import.meta.url);
        const extensionPath = fileURLToPath(
          existsSync(extension) ? extension : new URL("./acp-extension.ts", import.meta.url)
        );
        const args = ["--mode", "rpc", "--no-themes", "--extension", extensionPath];
        let emptySessionPath;
        if (!params.sessionPath && params.sessionDirectory) {
          mkdirSync2(params.sessionDirectory, { recursive: true, mode: 448 });
          emptySessionPath = join3(
            params.sessionDirectory,
            `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}.jsonl`
          );
          writeFileSync(emptySessionPath, "", { flag: "wx", mode: 384 });
        }
        const sessionPath = params.sessionPath ?? emptySessionPath;
        if (sessionPath) args.push("--session", sessionPath);
        if (params.model) args.push("--model", params.model);
        const cleanupEmptySession = () => {
          if (!emptySessionPath) return;
          try {
            if (statSync2(emptySessionPath).size === 0) unlinkSync(emptySessionPath);
          } catch {
          }
        };
        const env = {};
        if (params.agentDirectory) env.PI_CODING_AGENT_DIR = params.agentDirectory;
        if (params.mcpProxyOnly) env.PI_MCP_TOOL_EXPOSURE = "proxy-only";
        let child;
        try {
          if (params.launchSecretAccount !== void 0) {
            if (!params.identity) throw new Error("Launch secret requires a named identity");
            applyLaunchSecret(env, params.launchSecretAccount, params.identity.agentDirectory);
          }
          child = spawnNamedPi(
            cmd,
            args,
            params.cwd,
            { stdio: "pipe", env },
            params.identity
          );
        } catch (error) {
          cleanupEmptySession();
          throw error;
        }
        const proc = new _PiRpcProcess(child);
        void proc.whenTerminated().then(cleanupEmptySession);
        try {
          params.onProcess?.(proc);
        } catch (error) {
          proc.dispose();
          throw error;
        }
        try {
          await new Promise((resolve2, reject) => {
            const onSpawn = () => {
              cleanup();
              resolve2();
            };
            const onError = (error) => {
              cleanup();
              reject(error);
            };
            const cleanup = () => {
              child.off("spawn", onSpawn);
              child.off("error", onError);
            };
            child.once("spawn", onSpawn);
            child.once("error", onError);
          });
        } catch (error) {
          proc.dispose({ expected: false });
          const e = error;
          const code = typeof e.code === "string" ? e.code : void 0;
          if (code === "ENOENT") {
            throw piExecutableNotFoundError(cmd, e);
          }
          if (code === "EACCES") {
            throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e });
          }
          throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
        }
        if (params.launchSecretAccount !== void 0) {
          try {
            const commands = await proc.getCommands(1e4);
            if (!Array.isArray(commands.commands) || !commands.commands.some((command) => command.name === "claude-bridge-token-ready-v1"))
              throw new Error("Claude bridge did not advertise token readiness");
          } catch (error) {
            proc.dispose({ expected: false });
            await proc.whenTerminated();
            cleanupEmptySession();
            throw new Error(
              "\u72EC\u7ACB\u4EE4\u724C\u5C31\u7EEA\u68C0\u67E5\u672A\u83B7\u80AF\u5B9A\u56DE\u5E94\uFF0C\u5DF2\u62D2\u7EDD\u542F\u52A8\u3002\u5347\u7EA7\u6B64\u8EAB\u4EFD\u7684 claude-bridge\uFF1Api install git:github.com/liu-zhengdong/pi-claude-bridge@<\u65B0\u7248\u63D0\u4EA4>\uFF1B\u7136\u540E\u91CD\u542F\u8EAB\u4EFD",
              { cause: error }
            );
          }
        }
        return proc;
      }
      onEvent(handler) {
        this.eventHandlers.push(handler);
        return () => {
          this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
        };
      }
      /**
       * Subscribe to the child's terminal state. The handler is invoked at most
       * once, even when Node emits both 'error' and 'exit' for the same child.
       * Subscribing after termination delivers the recorded state asynchronously.
       */
      onTermination(handler) {
        const settled = this.termination;
        if (settled) {
          queueMicrotask(() => {
            try {
              handler(settled);
            } catch {
            }
          });
          return () => {
          };
        }
        this.terminationHandlers.push(handler);
        return () => {
          this.terminationHandlers = this.terminationHandlers.filter((h) => h !== handler);
        };
      }
      /** Bounded tail of the child's stderr output (for diagnostics). */
      stderrTail() {
        return this.stderrTailBuf;
      }
      /**
       * Whether a request is still awaiting its correlated pi response. pi has no
       * command that cancels in-flight RPC work (`abort` only stops an agent run,
       * not a manual compaction/export), so callers that must settle promptly use
       * this to decide whether the channel has to be quarantined.
       */
      hasPendingRequests() {
        return this.pending.size > 0;
      }
      /**
       * Resolves once the child has actually terminated (immediately if it
       * already has). Final adapter shutdown awaits this so the SIGTERM ->
       * SIGKILL escalation in {@link dispose} can complete before process exit.
       */
      whenTerminated() {
        if (this.termination) return Promise.resolve();
        return new Promise((resolve2) => {
          this.onTermination(() => resolve2());
        });
      }
      backgroundDisposal = false;
      dispose(options) {
        if (this.disposeRequested) return;
        if (this.backgroundDisposal && options?.expected !== false) return;
        if (options?.backgroundOwner && options.expected !== false) {
          this.backgroundDisposal = true;
          void this.abort(options.backgroundOwner).catch(() => {
            console.error("pi-acp: background stop failed during shutdown; detached work may still be running");
          }).finally(() => {
            this.backgroundDisposal = false;
            this.dispose({ expected: options.expected });
          });
          return;
        }
        this.disposeRequested = true;
        this.disposeIsExpected = options?.expected ?? true;
        this.rejectAllPending(this.closedError());
        if (this.termination) return;
        try {
          this.child.kill("SIGTERM");
        } catch {
        }
        const timer = setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {
          }
        }, this.killGraceMs);
        this.killTimer = timer;
      }
      bridgeReady;
      mcpConfiguration;
      mcpUpdating = false;
      async configureMcpServers(servers) {
        const configuration = JSON.stringify(servers);
        if (configuration === this.mcpConfiguration || !servers.length && this.mcpConfiguration === void 0) return;
        if (this.mcpUpdating) throw new McpConfigurationError("MCP_SESSION_BUSY", "MCP \u914D\u7F6E\u6B63\u5728\u66F4\u65B0");
        this.mcpUpdating = true;
        let unsubscribe;
        try {
          const raw = await this.getCommands();
          if (!Array.isArray(raw.commands) || !raw.commands.some((command) => command.name === MCP_COMMAND))
            throw new McpConfigurationError(
              "MCP_BRIDGE_UNAVAILABLE",
              "Pi \u672A\u52A0\u8F7D ACP MCP \u6865\u63A5\u6269\u5C55\uFF1B\u62D2\u7EDD\u628A\u670D\u52A1\u914D\u7F6E\u53D1\u9001\u7ED9\u6A21\u578B"
            );
          const id = randomUUID();
          let acknowledgement;
          unsubscribe = this.onEvent((event) => {
            if (event.type !== "extension_ui_request" || event.method !== "setWidget" || event.widgetKey !== MCP_WIDGET)
              return;
            const lines = event.widgetLines;
            if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string") return;
            try {
              const response2 = JSON.parse(lines[0]);
              if (response2.version === 1 && response2.id === id) acknowledgement = response2;
            } catch {
            }
          });
          const payload = Buffer.from(JSON.stringify({ version: 1, id, servers })).toString("base64url");
          const response = await this.request({ type: "prompt", message: `/${MCP_COMMAND} ${payload}` });
          if (!response.success || !acknowledgement) {
            this.dispose({ expected: false });
            throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "MCP \u6CE8\u518C\u672A\u6536\u5230\u6709\u6548\u56DE\u6267\uFF0C\u5DF2\u5173\u95ED\u4E0D\u786E\u5B9A\u72B6\u6001\u7684 Pi \u8FDB\u7A0B");
          }
          if (acknowledgement.success !== true) {
            const code = typeof acknowledgement.code === "string" ? acknowledgement.code : "MCP_REGISTRATION_FAILED";
            if (code === "MCP_ROLLBACK_FAILED" || code === "MCP_ADAPTER_INCOMPATIBLE") this.dispose({ expected: false });
            throw new McpConfigurationError(code, "MCP \u670D\u52A1\u6CE8\u518C\u5931\u8D25\uFF1B\u8BF7\u68C0\u67E5 adapter \u517C\u5BB9\u6027\u3001\u670D\u52A1\u91CD\u540D\u548C\u4F1A\u8BDD\u72B6\u6001");
          }
          this.mcpConfiguration = configuration;
        } catch (error) {
          if (error instanceof McpConfigurationError) throw error;
          this.dispose({ expected: false });
          throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "MCP \u6CE8\u518C\u901A\u4FE1\u5931\u8D25\uFF0C\u5DF2\u5173\u95ED\u4E0D\u786E\u5B9A\u72B6\u6001\u7684 Pi \u8FDB\u7A0B");
        } finally {
          unsubscribe?.();
          this.mcpUpdating = false;
        }
      }
      async prompt(message, images = [], onAccepted, owner) {
        if (/^\/pi-acp-(?:control|mcp)(?:\s|$)/.test(message))
          throw new Error("pi-acp internal commands are reserved for the adapter");
        if (owner) {
          this.bridgeReady ??= this.getCommands().then((raw) => {
            const commands = raw?.commands;
            if (!Array.isArray(commands) || !commands.some((command) => command.name === "pi-acp-control")) {
              throw new Error(
                "The adapter lifecycle extension failed to load; refusing to send an internal command to the model"
              );
            }
          });
          await this.bridgeReady;
          await this.control("begin", owner, DEFAULT_REQUEST_TIMEOUT_MS);
        }
        const res = await this.request(
          { type: "prompt", message, images, streamingBehavior: "followUp" },
          {
            // This callback runs synchronously at the successful response record,
            // before any later event records from the same stdout chunk. Session
            // ownership must cross that wire boundary rather than the earlier
            // stdin-write boundary.
            beforeResolve: (response) => {
              if (response.success) onAccepted?.();
            }
          }
        );
        if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
      }
      async control(operation, owner, timeoutMs, deadline) {
        let acknowledgement;
        const unsubscribe = this.onEvent((event) => {
          if (event.type !== "extension_ui_request" || event.method !== "setWidget" || event.widgetKey !== "pi-acp-lifecycle")
            return;
          try {
            const lines = event.widgetLines;
            if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string") return;
            const state = JSON.parse(lines[0]);
            if (state.version === 1 && state.owner === owner && ["ready", "rejected", "stopping", "pending", "cancelled", "error"].includes(String(state.state)))
              acknowledgement = state;
          } catch {
          }
        });
        try {
          await this.call(
            {
              type: "prompt",
              message: `/pi-acp-control ${operation} ${owner}${deadline === void 0 ? "" : ` ${deadline}`}`
            },
            timeoutMs
          );
          if (operation !== "begin" && typeof acknowledgement?.error === "string")
            this.abortControlDiagnostic = acknowledgement.error;
          if (operation === "check" && acknowledgement?.state === "pending") return false;
          if (acknowledgement?.state === (operation === "begin" ? "ready" : operation === "cancel" ? "stopping" : "cancelled"))
            return true;
          if (acknowledgement?.state !== "rejected") this.dispose({ expected: false });
          throw new Error(
            `ACP lifecycle ${operation} failed: ${String(acknowledgement?.error ?? "missing acknowledgement")}`
          );
        } finally {
          unsubscribe();
        }
      }
      abortInFlight;
      abortOwner;
      abortControlDiagnostic;
      async abort(owner) {
        if (this.abortInFlight) {
          if (owner && this.abortOwner && owner !== this.abortOwner) throw new Error("Conflicting ACP cancellation owner");
          this.abortOwner ??= owner;
          return this.abortInFlight;
        }
        this.abortOwner = owner;
        const abort = this.boundedAbort();
        this.abortInFlight = abort;
        try {
          await abort;
        } finally {
          if (this.abortInFlight === abort) {
            this.abortInFlight = void 0;
            this.abortOwner = void 0;
            this.abortControlDiagnostic = void 0;
          }
        }
      }
      async boundedAbort() {
        let timer;
        try {
          await Promise.race([
            this.runAbort(Date.now() + ABORT_TIMEOUT_MS),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => {
                this.dispose({ expected: false });
                reject(new Error("Pi cancellation timed out; detached background work may still be running"));
              }, ABORT_TIMEOUT_MS);
            })
          ]);
        } catch (error) {
          this.dispose({ expected: false });
          if (this.abortControlDiagnostic)
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; last unconfirmed nested control: ${this.abortControlDiagnostic}`,
              { cause: error }
            );
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      async runAbort(deadline) {
        const remaining = () => Math.max(1, deadline - Date.now());
        await this.call({ type: "clear_queue" }, remaining());
        await this.call({ type: "abort" }, remaining());
        while (this.abortOwner) {
          if (Date.now() >= deadline)
            throw new Error("Cancellation quiescence could not be confirmed; detached background work may still be running");
          await this.control("cancel", this.abortOwner, remaining(), deadline);
          await this.call({ type: "clear_queue" }, remaining());
          await this.call({ type: "abort" }, remaining());
          if (await this.control("check", this.abortOwner, remaining(), deadline)) return;
          await new Promise((resolve2) => setTimeout(resolve2, Math.min(25, remaining())));
        }
      }
      async getState() {
        return this.call({ type: "get_state" });
      }
      async getAvailableModels() {
        return this.call({ type: "get_available_models" });
      }
      async setModel(provider, modelId) {
        return this.call({ type: "set_model", provider, modelId });
      }
      async getAvailableThinkingLevels() {
        const res = await this.request({ type: "get_available_thinking_levels" });
        if (!res.success) {
          const error = new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`);
          error.unsupportedCommand = /unknown command|unsupported/i.test(
            res.error ?? ""
          );
          throw error;
        }
        return res.data;
      }
      async setThinkingLevel(level) {
        await this.call({ type: "set_thinking_level", level });
      }
      async setFollowUpMode(mode) {
        await this.call({ type: "set_follow_up_mode", mode });
      }
      async setSteeringMode(mode) {
        await this.call({ type: "set_steering_mode", mode });
      }
      async compact(customInstructions) {
        return this.call({ type: "compact", customInstructions });
      }
      async setAutoCompaction(enabled) {
        await this.call({ type: "set_auto_compaction", enabled });
      }
      async getSessionStats() {
        return this.call({ type: "get_session_stats" });
      }
      async setSessionName(name) {
        await this.call({ type: "set_session_name", name });
      }
      async exportHtml(outputPath) {
        const res = await this.request({ type: "export_html", outputPath });
        if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
        const data = res.data;
        return { path: String(data?.path ?? "") };
      }
      /**
       * The callback runs synchronously at the response line boundary, before
       * later stdout events can be dispatched from the same input chunk.
       */
      async getEntries(beforeResponseResolve) {
        const res = await this.request({ type: "get_entries" }, { beforeResolve: beforeResponseResolve });
        if (!res.success) throw new Error(`pi get_entries failed: ${res.error ?? JSON.stringify(res.data)}`);
        return res.data;
      }
      async getCommands(timeoutMs) {
        return this.call({ type: "get_commands" }, timeoutMs);
      }
      async sendExtensionUiResponse(response) {
        await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}
`);
      }
      async call(cmd, timeoutMs) {
        const res = await this.request(cmd, { timeoutMs });
        if (!res.success) throw new Error(`pi ${cmd.type} failed: ${res.error ?? JSON.stringify(res.data)}`);
        return res.data;
      }
      request(cmd, opts) {
        const id = crypto.randomUUID();
        const line = `${JSON.stringify({ ...cmd, id })}
`;
        return new Promise((resolve2, reject) => {
          if (this.termination || this.disposeRequested) {
            reject(this.closedError());
            return;
          }
          const entry = { resolve: resolve2, reject, beforeResolve: opts?.beforeResolve };
          const timeoutMs = opts?.timeoutMs ?? this.timeoutForCommand(cmd.type);
          if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            const timer = setTimeout(() => {
              if (!this.takePending(id)) return;
              const error = new PiRpcRequestTimeoutError(cmd.type, timeoutMs);
              this.dispose({ expected: false });
              reject(error);
            }, timeoutMs);
            entry.timer = timer;
          }
          this.pending.set(id, entry);
          void this.writeLine(line).catch((error) => {
            if (this.takePending(id)) reject(error);
          });
        });
      }
      writeLine(line) {
        return new Promise((resolve2, reject) => {
          const fail = (error) => {
            this.dispose({ expected: false });
            reject(error);
          };
          try {
            this.child.stdin.write(line, (error) => {
              if (error) {
                fail(error);
                return;
              }
              resolve2();
            });
          } catch (error) {
            fail(error);
          }
        });
      }
    };
  }
});

// src/runtime/identity.ts
import { spawn as spawn2 } from "child_process";
import { randomUUID as randomUUID2 } from "crypto";
import {
  closeSync,
  existsSync as existsSync2,
  mkdirSync as mkdirSync3,
  openSync,
  readFileSync as readFileSync2,
  readSync,
  realpathSync as realpathSync2,
  renameSync,
  rmdirSync,
  statSync as statSync3,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { isAbsolute as isAbsolute2, join as join4 } from "path";
function parseIdentity(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid named identity");
  const { identityId, agentDirectory } = value;
  if (typeof identityId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identityId))
    throw new Error("Invalid identityId");
  if (typeof agentDirectory !== "string" || !isAbsolute2(agentDirectory) || !statSync3(agentDirectory).isDirectory())
    throw new Error("agentDirectory must be an existing absolute directory");
  return { identityId, agentDirectory: realpathSync2(agentDirectory) };
}
function files(identity) {
  const root = join4(getPiAcpDir(), "identities");
  mkdirSync3(root, { recursive: true, mode: 448 });
  const base = join4(root, identity.identityId);
  return { owner: `${base}.json`, guard: `${base}.guard`, cursor: `${base}.cursor.json` };
}
function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID2()}.tmp`;
  writeFileSync2(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
  renameSync(temp, path);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owner PID; refusing takeover");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}
function claimIdentity(value, cwd) {
  const identity = parseIdentity(value), paths = files(identity);
  const guarded = (fn) => {
    try {
      mkdirSync3(paths.guard, { mode: 448 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        `Identity ownership is being changed or needs inspection: ${paths.guard}; no second Pi was started`
      );
    }
    try {
      return fn();
    } finally {
      rmdirSync(paths.guard);
    }
  };
  const owner = { ...identity, nonce: randomUUID2(), launcherPid: process.pid, childPid: null, cwd };
  guarded(() => {
    if (existsSync2(paths.owner)) {
      const previous = JSON.parse(readFileSync2(paths.owner, "utf8"));
      if (previous.identityId !== identity.identityId || previous.agentDirectory !== identity.agentDirectory)
        throw new Error("Identity is bound to another configuration directory");
      if (previous.childPid === null || alive(previous.launcherPid) || alive(previous.childPid))
        throw new Error(
          `Identity already occupied: PID ${previous.childPid ?? previous.launcherPid}, ${previous.cwd}; no second Pi was started`
        );
    }
    writeAtomic(paths.owner, owner);
  });
  const change = (fn) => guarded(() => {
    const current = JSON.parse(readFileSync2(paths.owner, "utf8"));
    if (current.nonce !== owner.nonce) throw new Error("Identity ownership changed");
    fn();
  });
  return {
    env: { [ENV]: JSON.stringify({ path: paths.owner, nonce: owner.nonce }) },
    commit(pid) {
      change(() => {
        owner.childPid = pid;
        writeAtomic(paths.owner, owner);
      });
    },
    // Called only after observed child exit, or a confirmed spawn failure.
    release() {
      change(() => unlinkSync2(paths.owner));
    }
  };
}
function processIdentity() {
  const globals = globalThis;
  if (globals[bindingKey] !== void 0) return globals[bindingKey];
  const raw = process.env[ENV];
  delete process.env[ENV];
  let identity = null;
  if (raw) {
    const pointer = JSON.parse(raw);
    const owner = JSON.parse(readFileSync2(pointer.path, "utf8"));
    if (owner.nonce === pointer.nonce && owner.childPid === process.pid) identity = parseIdentity(owner);
  }
  globals[bindingKey] = identity;
  return identity;
}
function rememberIdentitySession(identity, sessionFile, runtimeId) {
  writeAtomic(files(identity).cursor, { ...identity, sessionFile, runtimeId });
}
function firstJsonlRecordIsSessionHeader(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      return value.type === "session" && typeof value.id === "string";
    } catch {
    }
  }
  return false;
}
function usablePiSessionFile(path) {
  let size;
  try {
    const st = statSync3(path);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  if (size === 0) return true;
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(Math.min(SESSION_HEADER_SCAN, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return firstJsonlRecordIsSessionHeader(buf.subarray(0, n).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function takeUsableSessionFile(path) {
  if (!path || !existsSync2(path)) return void 0;
  if (usablePiSessionFile(path)) return path;
  console.error(`pi-acp: ignoring invalid Pi session file, starting a new session: ${path}`);
  return void 0;
}
function recordedIdentitySessionPath(identity) {
  const path = files(identity).cursor;
  if (!existsSync2(path)) return void 0;
  const cursor = JSON.parse(readFileSync2(path, "utf8"));
  if (cursor.identityId !== identity.identityId || cursor.agentDirectory !== identity.agentDirectory)
    throw new Error("Identity session directory mismatch");
  return cursor.sessionFile && existsSync2(cursor.sessionFile) ? cursor.sessionFile : void 0;
}
function identitySession(identity) {
  return takeUsableSessionFile(recordedIdentitySessionPath(identity));
}
function resolveIdentitySessionFile(identity, fallback) {
  const recorded = recordedIdentitySessionPath(identity);
  const usable = takeUsableSessionFile(recorded);
  if (usable) return usable;
  if (!fallback || fallback === recorded) return void 0;
  return takeUsableSessionFile(fallback);
}
function isInheritedModelCredential(name) {
  return /(?:_API_KEY|_TOKEN|_SECRET(?:_KEY)?|_ACCESS_KEY_ID)$/.test(name) || /^(?:AWS_|GOOGLE_|GCLOUD_|CLAUDE_|ANTHROPIC_|OPENAI_|AZURE_|CLOUDFLARE_|COPILOT_|HF_)/.test(name);
}
function spawnNamedPi(command, args, cwd, options, identity) {
  const invocation = buildPiInvocation(command, args, { cwd });
  if (!invocation) throw new Error(`Pi executable not found: ${command}`);
  const lease = identity ? claimIdentity(identity, cwd) : void 0;
  const env = { ...process.env };
  if (identity) {
    for (const key of Object.keys(env)) {
      if (isInheritedModelCredential(key)) delete env[key];
    }
  }
  Object.assign(env, options.env);
  delete env[ENV];
  delete env[LAUNCH_SECRET_ROOT_ENV];
  if (identity) {
    env.PI_CODING_AGENT_DIR = identity.agentDirectory;
    env.PI_CODING_AGENT_SESSION_DIR = join4(identity.agentDirectory, "sessions");
    Object.assign(env, lease.env);
  }
  let child;
  try {
    child = spawn2(invocation.executable, invocation.args, {
      ...options,
      cwd,
      env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
  } catch (error) {
    lease?.release();
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      lease?.release();
    } catch (error) {
      console.error(`pi-acp: ${String(error)}`);
    }
  };
  child.once("exit", release);
  child.once("error", () => {
    if (child.pid === void 0) release();
  });
  if (child.pid && lease) {
    try {
      lease.commit(child.pid);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  return child;
}
async function runNamedTui(value) {
  const identity = parseIdentity(value);
  const sessionFile = resolveIdentitySessionFile(identity, value.sessionFile);
  const args = ["--session-dir", join4(identity.agentDirectory, "sessions")];
  if (sessionFile) args.push("--session", sessionFile);
  if (value.model) args.push("--model", value.model);
  if (value.launchSecretAccount) {
    const { PiRpcProcess: PiRpcProcess2 } = await Promise.resolve().then(() => (init_process(), process_exports));
    const probe = await PiRpcProcess2.spawn({
      cwd: value.cwd,
      agentDirectory: identity.agentDirectory,
      identity,
      launchSecretAccount: value.launchSecretAccount,
      piCommand: getPiCommand(process.env.PI_ACP_PI_COMMAND)
    });
    probe.dispose();
    await probe.whenTerminated();
  }
  const env = { PI_MCP_TOOL_EXPOSURE: "proxy-only" };
  if (value.launchSecretAccount) applyLaunchSecret(env, value.launchSecretAccount, value.agentDirectory);
  const child = spawnNamedPi(
    getPiCommand(process.env.PI_ACP_PI_COMMAND),
    args,
    value.cwd,
    { stdio: "inherit", env },
    identity
  );
  const forward = (signal) => {
    child.kill(signal);
  };
  const term = () => forward("SIGTERM");
  process.on("SIGTERM", term);
  try {
    return await new Promise((resolve2, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve2(code ?? 1));
    });
  } finally {
    process.off("SIGTERM", term);
  }
}
var bindingKey, IDENTITY_CAPABILITY, IDENTITY_MODEL_CAPABILITY, ENV, SESSION_HEADER_SCAN;
var init_identity = __esm({
  "src/runtime/identity.ts"() {
    init_paths();
    init_command();
    init_launch_secret();
    init_launch_secret();
    bindingKey = /* @__PURE__ */ Symbol.for("@liuser/pi-acp/named-identity/v1");
    IDENTITY_CAPABILITY = "pi-acp/identity/v1";
    IDENTITY_MODEL_CAPABILITY = "pi-acp/identity/model/v1";
    ENV = "PI_ACP_NAMED_OWNER";
    SESSION_HEADER_SCAN = 1024 * 1024;
  }
});
init_identity();
export {
  IDENTITY_CAPABILITY,
  IDENTITY_LAUNCH_SECRET_CAPABILITY,
  IDENTITY_MODEL_CAPABILITY,
  claimIdentity,
  identitySession,
  isInheritedModelCredential,
  parseIdentity,
  processIdentity,
  rememberIdentitySession,
  resolveIdentitySessionFile,
  runNamedTui,
  spawnNamedPi,
  usablePiSessionFile
};
//# sourceMappingURL=identity.js.map