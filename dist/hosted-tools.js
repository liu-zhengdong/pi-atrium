#!/usr/bin/env node

// src/hosted-tools/codex.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/hosted-tools/http.ts
var HostedToolError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "HostedToolError";
  }
};
async function postJson(request) {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
      redirect: "error",
      credentials: "omit"
    });
  } catch (error) {
    if (request.signal?.aborted) throw new HostedToolError(`${request.label}\u5DF2\u53D6\u6D88\u3002`);
    if (timeout.aborted)
      throw new HostedToolError(`${request.label}\u8D85\u65F6\uFF08${Math.round(request.timeoutMs / 1e3)} \u79D2\uFF09\u3002`);
    throw new HostedToolError(`${request.label}\u8BF7\u6C42\u5931\u8D25\uFF1A${networkReason(error)}\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5\u3002`);
  }
  let text;
  try {
    text = await readBounded(response, request.maxResponseBytes);
  } catch (error) {
    if (error instanceof HostedToolError) throw new HostedToolError(`${request.label}${error.message}`);
    if (request.signal?.aborted) throw new HostedToolError(`${request.label}\u5DF2\u53D6\u6D88\u3002`);
    if (timeout.aborted)
      throw new HostedToolError(`${request.label}\u8D85\u65F6\uFF08${Math.round(request.timeoutMs / 1e3)} \u79D2\uFF09\u3002`);
    throw new HostedToolError(`${request.label}\u8BFB\u53D6\u54CD\u5E94\u5931\u8D25\uFF1A${networkReason(error)}\u3002`);
  }
  if (!response.ok) return { ok: false, status: response.status, detail: errorDetail(text) };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    throw new HostedToolError(`${request.label}\u8FD4\u56DE\u7684\u4E0D\u662F JSON\uFF08HTTP ${response.status}\uFF09\u3002`);
  }
}
function httpFailure(label, status, detail) {
  const suffix = detail ? `\uFF1A${detail}` : "";
  if (status === 429) return new HostedToolError(`${label}\u88AB\u9650\u6D41\u6216\u989D\u5EA6\u7528\u5C3D\uFF08HTTP 429\uFF09${suffix}\u3002\u7A0D\u540E\u518D\u8BD5\u3002`);
  if (status >= 500) return new HostedToolError(`${label}\u670D\u52A1\u7AEF\u51FA\u9519\uFF08HTTP ${status}\uFF09${suffix}\u3002\u7A0D\u540E\u518D\u8BD5\u3002`);
  return new HostedToolError(`${label}\u5931\u8D25\uFF08HTTP ${status}\uFF09${suffix}\u3002`);
}
async function readBounded(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => void 0);
    throw new HostedToolError(`\u54CD\u5E94\u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650\u3002`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => void 0);
        throw new HostedToolError(`\u54CD\u5E94\u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650\u3002`);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
function errorDetail(text) {
  let message = text;
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") message = error;
      else if (isRecord(error) && typeof error.message === "string") message = error.message;
      else if (typeof parsed.detail === "string") message = parsed.detail;
      else if (typeof parsed.message === "string") message = parsed.message;
    }
  } catch {
  }
  return redactBearer(message.replace(/\s+/g, " ").trim()).slice(0, 64 * 1024);
}
function networkReason(error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : void 0;
  const message = cause ?? (error instanceof Error ? error.message : String(error));
  return redactBearer(message).slice(0, 200);
}
function redactBearer(text) {
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [\u5DF2\u9690\u85CF]");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/hosted-tools/auth.ts
var LOGIN_HINT = {
  "openai-codex": "\u5728 Pi \u91CC\u6267\u884C /login \u9009 OpenAI (ChatGPT Plus/Pro)\uFF0C\u6216\u5728 Atrium \u91CC\u4E3A\u8BE5\u8EAB\u4EFD\u91CD\u65B0\u767B\u5F55 openai-codex",
  xai: "\u5728 Pi \u91CC\u6267\u884C /login \u9009 xAI\uFF0C\u6216\u914D\u7F6E XAI_API_KEY"
};
async function resolveToken(registry, provider) {
  let result;
  try {
    result = await registry.getProviderAuth(provider);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HostedToolError(`${provider} \u4EE4\u724C\u5237\u65B0\u5931\u8D25\uFF08${reason.slice(0, 200)}\uFF09\u3002\u8BF7${LOGIN_HINT[provider]}\u3002`);
  }
  const token = result?.auth.apiKey?.trim();
  if (!token) throw new HostedToolError(`\u6CA1\u6709 ${provider} \u7684\u767B\u5F55\u51ED\u636E\u3002\u8BF7${LOGIN_HINT[provider]}\u3002`);
  return token;
}
async function sendWithToken(registry, provider, label, send) {
  let token = await resolveToken(registry, provider);
  const used = [token];
  let response = await send(token);
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    const next = await resolveToken(registry, provider);
    if (next !== token) {
      token = next;
      used.push(token);
      response = await send(token);
    }
  }
  if (response.ok) return response.value;
  const scrubbed = used.reduce((text, value) => text.split(value).join("[\u5DF2\u9690\u85CF]"), response.detail).slice(0, 300);
  if (response.status === 401 || response.status === 403) {
    const detail = scrubbed ? `\uFF1A${scrubbed}` : "";
    throw new HostedToolError(
      `${label}\u9274\u6743\u5931\u8D25\uFF08HTTP ${response.status}\uFF09${detail}\u3002\u5F53\u524D ${provider} \u767B\u5F55\u53EF\u80FD\u5DF2\u5931\u6548\u6216\u65E0\u6B64\u6743\u9650\uFF0C\u8BF7${LOGIN_HINT[provider]}\u3002`
    );
  }
  throw httpFailure(label, response.status, scrubbed);
}

// src/hosted-tools/images.ts
import { randomUUID } from "crypto";
import { mkdir, open, stat, writeFile } from "fs/promises";
import { isAbsolute, join, resolve } from "path";
var IMAGE_OUTPUT_DIR = join(".pi", "generated-images");
var EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
function sniffImage(bytes) {
  const starts = (...signature) => signature.every((value, index) => bytes[index] === value);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  if (starts(71, 73, 70, 56)) return "image/gif";
  if (starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80)
    return "image/webp";
  return void 0;
}
async function readImageInputs(paths, cwd, limits) {
  const list = (paths ?? []).map((path) => path.trim()).filter(Boolean);
  if (list.length > limits.maxCount)
    throw new HostedToolError(`\u6700\u591A\u4F20 ${limits.maxCount} \u5F20\u56FE\u7247\uFF0C\u6536\u5230 ${list.length} \u5F20\u3002`);
  const inputs = [];
  for (const raw of list) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const info = await stat(path).catch(() => void 0);
    if (!info?.isFile()) throw new HostedToolError(`\u56FE\u7247\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u6587\u4EF6\uFF1A${raw}`);
    if (info.size > limits.maxBytes)
      throw new HostedToolError(`\u56FE\u7247\u8FC7\u5927\uFF08${info.size} \u5B57\u8282\uFF0C\u4E0A\u9650 ${limits.maxBytes}\uFF09\uFF1A${raw}`);
    const bytes = await readFileBounded(path, limits.maxBytes);
    const mimeType = sniffImage(bytes);
    if (!mimeType || !limits.accept.includes(mimeType))
      throw new HostedToolError(
        `\u4E0D\u652F\u6301\u7684\u56FE\u7247\u683C\u5F0F\uFF08\u53EA\u63A5\u53D7 ${limits.accept.map((type) => EXTENSIONS[type]).join("/")}\uFF09\uFF1A${raw}`
      );
    inputs.push({ path, mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` });
  }
  return inputs;
}
async function readFileBounded(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (; ; ) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) throw new HostedToolError(`\u56FE\u7247\u8BFB\u53D6\u65F6\u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650\uFF1A${path}`);
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function saveGeneratedImage(cwd, prefix, base64) {
  const data = base64.replace(/^data:[^;,]+;base64,/, "").trim();
  const bytes = Buffer.from(data, "base64");
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new HostedToolError("\u670D\u52A1\u7AEF\u8FD4\u56DE\u7684\u56FE\u7247\u6570\u636E\u65E0\u6CD5\u8BC6\u522B\u3002");
  const dir = resolve(cwd, IMAGE_OUTPUT_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.${EXTENSIONS[mimeType]}`);
  await writeFile(path, bytes, { flag: "wx" });
  return path;
}

// src/hosted-tools/types.ts
var DEFAULT_ENDPOINTS = {
  codex: "https://chatgpt.com/backend-api/codex",
  xai: "https://api.x.ai/v1"
};
function stringParam(params, key) {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function stringListParam(params, key) {
  const value = params[key];
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return void 0;
  return value;
}

// src/hosted-tools/codex.ts
var ORIGINATOR = "codex_cli_rs";
var USER_AGENT = "codex_cli_rs/0.0.0 (pi-atrium)";
var SEARCH_MODEL = "gpt-5.6-luna";
var SEARCH_REASONING_EFFORT = "max";
var SEARCH_MAX_OUTPUT_TOKENS = 4096;
var SEARCH_TIMEOUT_MS = 6e4;
var SEARCH_MAX_QUERY_BYTES = 8 * 1024;
var SEARCH_MAX_RESPONSE_BYTES = 256 * 1024;
var SEARCH_MAX_SOURCES = 10;
var IMAGE_MODEL = "gpt-image-2.5";
var IMAGE_TIMEOUT_MS = 18e4;
var IMAGE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
var IMAGE_MAX_INPUTS = 5;
var IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
function chatgptAccountId(token) {
  try {
    const payload = token.split(".")[1];
    if (payload) {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      const auth = isRecord(claims) ? claims["https://api.openai.com/auth"] : void 0;
      const accountId = isRecord(auth) ? auth.chatgpt_account_id : void 0;
      if (typeof accountId === "string" && accountId.trim()) return accountId.trim();
    }
  } catch {
  }
  throw new HostedToolError("openai-codex \u4EE4\u724C\u91CC\u6CA1\u6709 ChatGPT \u8D26\u53F7\u4FE1\u606F\uFF0C\u65E0\u6CD5\u8C03\u7528 Codex \u540E\u7AEF\u3002\u8BF7\u91CD\u65B0\u767B\u5F55 openai-codex\u3002");
}
function codexHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": chatgptAccountId(token),
    accept: "application/json",
    "content-type": "application/json",
    originator: ORIGINATOR,
    "user-agent": USER_AGENT,
    ...extra
  };
}
function parseCodexSearch(value) {
  if (!isRecord(value) || typeof value.output !== "string")
    throw new HostedToolError("Codex \u641C\u7D22\u8FD4\u56DE\u7684\u5185\u5BB9\u7F3A\u5C11 output \u5B57\u6BB5\uFF0C\u63A5\u53E3\u53EF\u80FD\u5DF2\u53D8\u66F4\u3002");
  const results = Array.isArray(value.results) ? value.results : [];
  const sources = results.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : void 0;
    const snippet = typeof item.snippet === "string" && item.snippet.trim() ? item.snippet.trim() : void 0;
    return [{ url: item.url, ...title ? { title } : {}, ...snippet ? { snippet } : {} }];
  });
  return { answer: value.output.trim(), sources };
}
function formatSearch(query, answer, sources) {
  const lines = answer ? [answer] : [];
  const shown = sources.slice(0, SEARCH_MAX_SOURCES);
  if (shown.length) {
    lines.push("", "\u6765\u6E90\uFF1A");
    shown.forEach((source, index) => {
      lines.push(`${index + 1}. [${source.title ?? source.url}](${source.url})`);
      if (source.snippet) lines.push(`   ${source.snippet}`);
    });
  }
  return lines.length ? lines.join("\n").trim() : `\u6CA1\u6709\u627E\u5230\u300C${query}\u300D\u7684\u7ED3\u679C\u3002`;
}
function codexTools(endpoints) {
  const search = {
    provider: "openai-codex",
    name: "codex_search",
    label: "Codex \u641C\u7D22",
    description: "\u7528\u5F53\u524D ChatGPT \u8D26\u53F7\u7ECF Codex \u641C\u7D22\u540E\u7AEF\u8054\u7F51\u641C\u7D22\uFF0C\u8FD4\u56DE\u7B54\u6848\u548C\u5F15\u7528\u6765\u6E90\u3002",
    promptSnippet: "\u8054\u7F51\u641C\u7D22\uFF08ChatGPT \u8D26\u53F7\uFF09",
    promptGuidelines: [
      "\u9700\u8981\u6700\u65B0\u4FE1\u606F\u3001\u73B0\u4EF7\u3001\u8FD1\u671F\u53D1\u5E03\u6216\u4EFB\u4F55\u53EF\u80FD\u5DF2\u53D8\u5316\u7684\u4E8B\u5B9E\u65F6\uFF0C\u7528 codex_search \u8054\u7F51\u641C\u7D22\uFF0C\u5E76\u5728\u56DE\u7B54\u91CC\u5F15\u7528\u8FD4\u56DE\u7684\u6765\u6E90\u94FE\u63A5\u3002"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "\u641C\u7D22\u95EE\u9898\uFF0C\u5C3D\u91CF\u4FDD\u7559\u539F\u8BDD\u3002" }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = stringParam(params, "query");
      if (!query) throw new HostedToolError("codex_search \u9700\u8981\u975E\u7A7A\u7684 query\u3002");
      if (Buffer.byteLength(query) > SEARCH_MAX_QUERY_BYTES)
        throw new HostedToolError(`query \u8D85\u8FC7 ${SEARCH_MAX_QUERY_BYTES} \u5B57\u8282\u3002`);
      const label = "Codex \u641C\u7D22";
      const value = await sendWithToken(
        ctx.modelRegistry,
        "openai-codex",
        label,
        (token) => postJson({
          label,
          url: `${endpoints.codex}/alpha/search`,
          headers: codexHeaders(token),
          body: {
            id: randomUUID2(),
            model: SEARCH_MODEL,
            reasoning: { effort: SEARCH_REASONING_EFFORT },
            input: query,
            commands: { search_query: [{ q: query }], response_length: "short" },
            settings: { allowed_callers: ["direct"], external_web_access: true },
            max_output_tokens: SEARCH_MAX_OUTPUT_TOKENS
          },
          timeoutMs: SEARCH_TIMEOUT_MS,
          maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
          signal
        })
      );
      const { answer, sources } = parseCodexSearch(value);
      return {
        content: [{ type: "text", text: formatSearch(query, answer, sources) }],
        details: { query, sources }
      };
    }
  };
  const image = {
    provider: "openai-codex",
    name: "codex_image",
    label: "Codex \u751F\u56FE",
    description: "\u7528\u5F53\u524D ChatGPT \u8D26\u53F7\u7ECF Codex Images \u63A5\u53E3\u751F\u6210\u56FE\u7247\uFF1B\u4F20 images\uFF08\u672C\u5730\u56FE\u7247\u8DEF\u5F84\uFF09\u5219\u6309\u63D0\u793A\u6539\u56FE\u6216\u4EE5\u5176\u4E3A\u53C2\u8003\u3002\u56FE\u7247\u4FDD\u5B58\u5230\u5DE5\u4F5C\u76EE\u5F55\u4E0B .pi/generated-images/\uFF0C\u8FD4\u56DE\u4FDD\u5B58\u8DEF\u5F84\u3002",
    promptSnippet: "\u751F\u6210\u6216\u4FEE\u6539\u56FE\u7247\uFF08ChatGPT \u8D26\u53F7\uFF09",
    promptGuidelines: [
      "\u7528\u6237\u8981\u751F\u6210\u6216\u4FEE\u6539\u4F4D\u56FE\uFF08\u63D2\u753B\u3001\u7167\u7247\u3001\u56FE\u6807\u3001\u8D34\u56FE\u7B49\uFF09\u65F6\u7528 codex_image\uFF1Bprompt \u539F\u6837\u8F6C\u8FF0\u7528\u6237\u7684\u63CF\u8FF0\uFF0C\u4E0D\u8981\u81EA\u884C\u52A0\u6599\u3002",
      "\u6539\u56FE\u65F6\u628A\u7528\u6237\u7ED9\u7684\u672C\u5730\u56FE\u7247\u8DEF\u5F84\u653E\u8FDB images\uFF1B\u7ED3\u679C\u53EA\u8FD4\u56DE\u4FDD\u5B58\u8DEF\u5F84\uFF0C\u9700\u8981\u67E5\u770B\u65F6\u518D\u7528 read \u8BFB\u53D6\u3002"
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "\u751F\u56FE\u6216\u6539\u56FE\u7684\u63CF\u8FF0\uFF0C\u539F\u6837\u8F6C\u8FF0\u7528\u6237\u7684\u8BDD\u3002" },
        images: {
          type: "array",
          maxItems: IMAGE_MAX_INPUTS,
          items: { type: "string" },
          description: "\u8981\u4FEE\u6539\u6216\u4F5C\u53C2\u8003\u7684\u672C\u5730\u56FE\u7247\u8DEF\u5F84\uFF08\u76F8\u5BF9\u8DEF\u5F84\u6309\u5DE5\u4F5C\u76EE\u5F55\u89E3\u6790\uFF09\uFF0C\u652F\u6301 png/jpg/webp/gif\u3002\u4E0D\u4F20\u5219\u76F4\u63A5\u751F\u6210\u3002"
        }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prompt = stringParam(params, "prompt");
      if (!prompt) throw new HostedToolError("codex_image \u9700\u8981\u975E\u7A7A\u7684 prompt\u3002");
      const paths = stringListParam(params, "images");
      if (params.images !== void 0 && !paths) throw new HostedToolError("images \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4\u3002");
      const inputs = await readImageInputs(paths, ctx.cwd, {
        maxCount: IMAGE_MAX_INPUTS,
        maxBytes: IMAGE_MAX_INPUT_BYTES,
        accept: ["image/png", "image/jpeg", "image/webp", "image/gif"]
      });
      const action = inputs.length ? "edit" : "generate";
      const common = { prompt, background: "auto", model: IMAGE_MODEL, quality: "auto", size: "auto" };
      const body = action === "edit" ? { images: inputs.map((input) => ({ image_url: input.dataUrl })), ...common } : common;
      const label = action === "edit" ? "Codex \u6539\u56FE" : "Codex \u751F\u56FE";
      onUpdate?.({ content: [{ type: "text", text: `${label}\u8BF7\u6C42\u4E2D\uFF08${IMAGE_MODEL}\uFF09\u2026` }], details: {} });
      const value = await sendWithToken(
        ctx.modelRegistry,
        "openai-codex",
        label,
        (token) => postJson({
          label,
          url: `${endpoints.codex}/images/${action === "edit" ? "edits" : "generations"}`,
          headers: codexHeaders(token, { "x-codex-image-turn-id": randomUUID2() }),
          body,
          timeoutMs: IMAGE_TIMEOUT_MS,
          maxResponseBytes: IMAGE_MAX_RESPONSE_BYTES,
          signal
        })
      );
      const images = isRecord(value) && Array.isArray(value.data) ? value.data : [];
      const first = images.find((item) => isRecord(item) && typeof item.b64_json === "string" && item.b64_json.trim());
      if (!isRecord(first)) throw new HostedToolError(`${label}\u6CA1\u6709\u8FD4\u56DE\u56FE\u7247\u6570\u636E\u3002`);
      const savedPath = await saveGeneratedImage(ctx.cwd, "codex-image", first.b64_json);
      const revisedPrompt = typeof first.revised_prompt === "string" ? first.revised_prompt : void 0;
      const lines = [`\u5DF2\u4FDD\u5B58\uFF1A${savedPath}`, `\u6A21\u578B\uFF1A${IMAGE_MODEL}\uFF08${action === "edit" ? "\u6539\u56FE" : "\u751F\u6210"}\uFF09`];
      if (revisedPrompt) lines.push(`\u6539\u5199\u540E\u7684\u63D0\u793A\uFF1A${revisedPrompt}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { savedPath, model: IMAGE_MODEL, action, inputs: inputs.map((input) => input.path) }
      };
    }
  };
  return [search, image];
}

// src/hosted-tools/xai.ts
var USER_AGENT2 = "pi-atrium";
var SEARCH_TIMEOUT_MS2 = 12e4;
var SEARCH_MAX_RESPONSE_BYTES2 = 1024 * 1024;
var SEARCH_MAX_QUERY_CHARS = 4e3;
var IMAGE_MODEL2 = "grok-imagine-image-2.0";
var IMAGE_TIMEOUT_MS2 = 18e4;
var IMAGE_MAX_RESPONSE_BYTES2 = 32 * 1024 * 1024;
var IMAGE_MAX_INPUTS2 = 3;
var IMAGE_MAX_INPUT_BYTES2 = 8 * 1024 * 1024;
var MAX_ALLOWED_DOMAINS = 5;
var MAX_X_HANDLES = 10;
var XAI_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "auto"
];
function xaiHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": USER_AGENT2
  };
}
function parseResponsesSearch(value) {
  if (!isRecord(value)) throw new HostedToolError("xAI \u641C\u7D22\u8FD4\u56DE\u7684\u5185\u5BB9\u4E0D\u662F\u5BF9\u8C61\uFF0C\u63A5\u53E3\u53EF\u80FD\u5DF2\u53D8\u66F4\u3002");
  const chunks = [];
  const citations = /* @__PURE__ */ new Map();
  const cite = (url, title) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || citations.has(url)) return;
    citations.set(url, { url, ...typeof title === "string" && title.trim() ? { title: title.trim() } : {} });
  };
  for (const item of Array.isArray(value.output) ? value.output : []) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (isRecord(annotation) && annotation.type === "url_citation") cite(annotation.url, annotation.title);
      }
    }
  }
  for (const url of Array.isArray(value.citations) ? value.citations : []) cite(url);
  const text = (typeof value.output_text === "string" && value.output_text ? value.output_text : chunks.join("")).trim();
  return { text, citations: [...citations.values()] };
}
function formatCitations(text, citations, empty) {
  const lines = text ? [text] : [empty];
  if (citations.length) {
    lines.push("", "\u6765\u6E90\uFF1A");
    citations.slice(0, 20).forEach((citation, index) => {
      lines.push(`${index + 1}. [${citation.title ?? citation.url}](${citation.url})`);
    });
  }
  return lines.join("\n");
}
function searchModel(ctx, toolName) {
  if (ctx.model?.provider !== "xai" || !ctx.model.id)
    throw new HostedToolError(`${toolName} \u53EA\u5728\u5F53\u524D\u6A21\u578B\u4E3A xai \u65F6\u53EF\u7528\uFF0C\u6CA1\u6709\u53D1\u51FA\u8BF7\u6C42\u3002`);
  return ctx.model.id;
}
async function runSearch(endpoints, ctx, label, model, prompt, tool, signal) {
  const value = await sendWithToken(
    ctx.modelRegistry,
    "xai",
    label,
    (token) => postJson({
      label,
      url: `${endpoints.xai}/responses`,
      headers: xaiHeaders(token),
      body: { model, input: [{ role: "user", content: prompt }], tools: [tool], store: false },
      timeoutMs: SEARCH_TIMEOUT_MS2,
      maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES2,
      signal
    })
  );
  return parseResponsesSearch(value);
}
function dateParam(params, key) {
  const value = stringParam(params, key);
  if (value !== void 0 && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HostedToolError(`${key} \u987B\u4E3A YYYY-MM-DD\u3002`);
  return value;
}
function queryParam(params, toolName) {
  const query = stringParam(params, "query");
  if (!query) throw new HostedToolError(`${toolName} \u9700\u8981\u975E\u7A7A\u7684 query\u3002`);
  if (query.length > SEARCH_MAX_QUERY_CHARS) throw new HostedToolError(`query \u8D85\u8FC7 ${SEARCH_MAX_QUERY_CHARS} \u5B57\u3002`);
  return query;
}
function boundedList(params, key, max) {
  const list = stringListParam(params, key);
  if (params[key] !== void 0 && !list) throw new HostedToolError(`${key} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4\u3002`);
  const cleaned = list?.map((item) => item.trim()).filter(Boolean);
  if (cleaned && cleaned.length > max) throw new HostedToolError(`${key} \u6700\u591A ${max} \u9879\u3002`);
  return cleaned?.length ? cleaned : void 0;
}
function xaiTools(endpoints) {
  const webSearch = {
    provider: "xai",
    name: "xai_web_search",
    label: "xAI \u8054\u7F51\u641C\u7D22",
    description: "\u7528\u5F53\u524D xAI \u8D26\u53F7\u53E6\u53D1\u4E00\u6B21 Grok \u8BF7\u6C42\uFF0C\u501F\u670D\u52A1\u7AEF web_search \u8054\u7F51\u641C\u7D22\uFF0C\u8FD4\u56DE\u6458\u8981\u548C\u6765\u6E90\u3002",
    promptSnippet: "\u8054\u7F51\u641C\u7D22\uFF08xAI \u8D26\u53F7\uFF09",
    promptGuidelines: ["\u9700\u8981\u6700\u65B0\u4FE1\u606F\u6216\u53EF\u80FD\u5DF2\u53D8\u5316\u7684\u4E8B\u5B9E\u65F6\uFF0C\u7528 xai_web_search \u8054\u7F51\u641C\u7D22\uFF0C\u5E76\u5728\u56DE\u7B54\u91CC\u5F15\u7528\u8FD4\u56DE\u7684\u6765\u6E90\u94FE\u63A5\u3002"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "\u641C\u7D22\u95EE\u9898\uFF0C\u5C3D\u91CF\u4FDD\u7559\u539F\u8BDD\u3002" },
        allowed_domains: {
          type: "array",
          maxItems: MAX_ALLOWED_DOMAINS,
          items: { type: "string" },
          description: "\u53EA\u5728\u8FD9\u4E9B\u57DF\u540D\u5185\u641C\u7D22\uFF08\u53EF\u9009\uFF0C\u6700\u591A 5 \u4E2A\uFF09\u3002"
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = searchModel(ctx, "xai_web_search");
      const query = queryParam(params, "xai_web_search");
      const domains = boundedList(params, "allowed_domains", MAX_ALLOWED_DOMAINS);
      const tool = { type: "web_search", ...domains ? { filters: { allowed_domains: domains } } : {} };
      const prompt = `Search the web for: ${query}

Summarize the key results and cite sources.`;
      const result = await runSearch(endpoints, ctx, "xAI \u8054\u7F51\u641C\u7D22", model, prompt, tool, signal);
      return {
        content: [
          { type: "text", text: formatCitations(result.text, result.citations, `\u6CA1\u6709\u627E\u5230\u300C${query}\u300D\u7684\u7ED3\u679C\u3002`) }
        ],
        details: { query, model, citations: result.citations }
      };
    }
  };
  const xSearch = {
    provider: "xai",
    name: "xai_x_search",
    label: "X \u641C\u7D22",
    description: "\u7528\u5F53\u524D xAI \u8D26\u53F7\u53E6\u53D1\u4E00\u6B21 Grok \u8BF7\u6C42\uFF0C\u501F\u670D\u52A1\u7AEF x_search \u641C\u7D22 X\uFF08Twitter\uFF09\u5E16\u5B50\uFF0C\u8FD4\u56DE\u6458\u8981\u548C\u5E16\u5B50\u94FE\u63A5\u3002",
    promptSnippet: "\u641C\u7D22 X \u5E16\u5B50\uFF08xAI \u8D26\u53F7\uFF09",
    promptGuidelines: ["\u9700\u8981 X\uFF08Twitter\uFF09\u4E0A\u7684\u5B9E\u65F6\u8BA8\u8BBA\u3001\u5E16\u5B50\u6216\u67D0\u8D26\u53F7\u52A8\u6001\u65F6\u7528 xai_x_search\u3002"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "\u8981\u5728 X \u4E0A\u627E\u4EC0\u4E48\u3002" },
        from_date: { type: "string", description: "\u53EA\u770B\u6B64\u65E5\u671F\u4E4B\u540E\u7684\u5E16\u5B50\uFF0CYYYY-MM-DD\uFF08\u53EF\u9009\uFF09\u3002" },
        to_date: { type: "string", description: "\u53EA\u770B\u6B64\u65E5\u671F\u4E4B\u524D\u7684\u5E16\u5B50\uFF0CYYYY-MM-DD\uFF08\u53EF\u9009\uFF09\u3002" },
        handles: {
          type: "array",
          maxItems: MAX_X_HANDLES,
          items: { type: "string" },
          description: "\u53EA\u770B\u8FD9\u4E9B\u8D26\u53F7\u7684\u5E16\u5B50\uFF0C\u4E0D\u5E26 @\uFF08\u53EF\u9009\uFF0C\u6700\u591A 10 \u4E2A\uFF09\u3002"
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = searchModel(ctx, "xai_x_search");
      const query = queryParam(params, "xai_x_search");
      const fromDate = dateParam(params, "from_date");
      const toDate = dateParam(params, "to_date");
      const handles = boundedList(params, "handles", MAX_X_HANDLES)?.map((handle) => handle.replace(/^@/, ""));
      const tool = {
        type: "x_search",
        ...fromDate ? { from_date: fromDate } : {},
        ...toDate ? { to_date: toDate } : {},
        ...handles ? { allowed_x_handles: handles } : {}
      };
      const prompt = `Search X for: ${query}

Summarize the most relevant posts with usernames, timestamps and links.`;
      const result = await runSearch(endpoints, ctx, "X \u641C\u7D22", model, prompt, tool, signal);
      return {
        content: [
          { type: "text", text: formatCitations(result.text, result.citations, `X \u4E0A\u6CA1\u6709\u627E\u5230\u300C${query}\u300D\u7684\u7ED3\u679C\u3002`) }
        ],
        details: { query, model, citations: result.citations }
      };
    }
  };
  const image = {
    provider: "xai",
    name: "xai_image",
    label: "xAI \u751F\u56FE",
    description: "\u7528\u5F53\u524D xAI \u8D26\u53F7\u7ECF Grok Imagine \u751F\u6210\u56FE\u7247\uFF1B\u4F20 images\uFF08\u672C\u5730 png/jpg \u8DEF\u5F84\uFF0C\u6700\u591A 3 \u5F20\uFF09\u5219\u6309\u63D0\u793A\u6539\u56FE\u3002\u56FE\u7247\u4FDD\u5B58\u5230\u5DE5\u4F5C\u76EE\u5F55\u4E0B .pi/generated-images/\uFF0C\u8FD4\u56DE\u4FDD\u5B58\u8DEF\u5F84\u3002",
    promptSnippet: "\u751F\u6210\u6216\u4FEE\u6539\u56FE\u7247\uFF08xAI \u8D26\u53F7\uFF09",
    promptGuidelines: [
      "\u7528\u6237\u8981\u751F\u6210\u6216\u4FEE\u6539\u4F4D\u56FE\u65F6\u7528 xai_image\uFF1Bprompt \u539F\u6837\u8F6C\u8FF0\u7528\u6237\u7684\u63CF\u8FF0\uFF0C\u4E0D\u8981\u81EA\u884C\u52A0\u6599\u3002",
      "\u6539\u56FE\u65F6\u628A\u7528\u6237\u7ED9\u7684\u672C\u5730\u56FE\u7247\u8DEF\u5F84\u653E\u8FDB images\uFF1B\u7ED3\u679C\u53EA\u8FD4\u56DE\u4FDD\u5B58\u8DEF\u5F84\uFF0C\u9700\u8981\u67E5\u770B\u65F6\u518D\u7528 read \u8BFB\u53D6\u3002"
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "\u751F\u56FE\u6216\u6539\u56FE\u7684\u63CF\u8FF0\uFF0C\u539F\u6837\u8F6C\u8FF0\u7528\u6237\u7684\u8BDD\u3002" },
        images: {
          type: "array",
          maxItems: IMAGE_MAX_INPUTS2,
          items: { type: "string" },
          description: "\u8981\u4FEE\u6539\u7684\u672C\u5730\u56FE\u7247\u8DEF\u5F84\uFF08\u76F8\u5BF9\u8DEF\u5F84\u6309\u5DE5\u4F5C\u76EE\u5F55\u89E3\u6790\uFF09\uFF0Cpng/jpg\uFF0C\u6700\u591A 3 \u5F20\u3002\u4E0D\u4F20\u5219\u76F4\u63A5\u751F\u6210\u3002"
        },
        aspect_ratio: {
          type: "string",
          enum: [...XAI_ASPECT_RATIOS],
          description: "\u753B\u5E45\u6BD4\u4F8B\uFF08\u53EF\u9009\uFF09\uFF1B\u591A\u5F20\u53C2\u8003\u56FE\u65F6\u9ED8\u8BA4 auto\u3002"
        }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const prompt = stringParam(params, "prompt");
      if (!prompt) throw new HostedToolError("xai_image \u9700\u8981\u975E\u7A7A\u7684 prompt\u3002");
      const aspectRatio = stringParam(params, "aspect_ratio");
      if (aspectRatio && !XAI_ASPECT_RATIOS.includes(aspectRatio))
        throw new HostedToolError(`aspect_ratio \u53EA\u80FD\u662F ${XAI_ASPECT_RATIOS.join(" / ")}\u3002`);
      const paths = stringListParam(params, "images");
      if (params.images !== void 0 && !paths) throw new HostedToolError("images \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4\u3002");
      const inputs = await readImageInputs(paths, ctx.cwd, {
        maxCount: IMAGE_MAX_INPUTS2,
        maxBytes: IMAGE_MAX_INPUT_BYTES2,
        accept: ["image/png", "image/jpeg"]
      });
      const action = inputs.length ? "edit" : "generate";
      const body = { model: IMAGE_MODEL2, prompt, n: 1, response_format: "b64_json" };
      if (action === "edit") {
        body.resolution = "1k";
        if (inputs.length === 1) {
          body.image = { url: inputs[0].dataUrl };
          if (aspectRatio) body.aspect_ratio = aspectRatio;
        } else {
          body.images = inputs.map((input) => ({ url: input.dataUrl }));
          body.aspect_ratio = aspectRatio ?? "auto";
        }
      } else if (aspectRatio) {
        body.aspect_ratio = aspectRatio;
      }
      const label = action === "edit" ? "xAI \u6539\u56FE" : "xAI \u751F\u56FE";
      onUpdate?.({ content: [{ type: "text", text: `${label}\u8BF7\u6C42\u4E2D\uFF08${IMAGE_MODEL2}\uFF09\u2026` }], details: {} });
      const value = await sendWithToken(
        ctx.modelRegistry,
        "xai",
        label,
        (token) => postJson({
          label,
          url: `${endpoints.xai}/images/${action === "edit" ? "edits" : "generations"}`,
          headers: xaiHeaders(token),
          body,
          timeoutMs: IMAGE_TIMEOUT_MS2,
          maxResponseBytes: IMAGE_MAX_RESPONSE_BYTES2,
          signal
        })
      );
      const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
      const first = data.find((item) => isRecord(item) && typeof item.b64_json === "string" && item.b64_json.trim());
      if (!isRecord(first)) throw new HostedToolError(`${label}\u6CA1\u6709\u8FD4\u56DE\u56FE\u7247\u6570\u636E\u3002`);
      const savedPath = await saveGeneratedImage(ctx.cwd, "xai-image", first.b64_json);
      const revisedPrompt = typeof first.revised_prompt === "string" ? first.revised_prompt : void 0;
      const lines = [`\u5DF2\u4FDD\u5B58\uFF1A${savedPath}`, `\u6A21\u578B\uFF1A${IMAGE_MODEL2}\uFF08${action === "edit" ? "\u6539\u56FE" : "\u751F\u6210"}\uFF09`];
      if (revisedPrompt) lines.push(`\u6539\u5199\u540E\u7684\u63D0\u793A\uFF1A${revisedPrompt}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { savedPath, model: IMAGE_MODEL2, action, inputs: inputs.map((input) => input.path) }
      };
    }
  };
  return [webSearch, xSearch, image];
}

// src/hosted-tools/extension.ts
function syncHostedTools(pi, tools, model) {
  const hosted = new Set(tools.map((tool) => tool.name));
  const wanted = tools.filter((tool) => tool.provider === model?.provider).map((tool) => tool.name);
  try {
    const active = pi.getActiveTools();
    const next = [...active.filter((name) => !hosted.has(name)), ...wanted];
    if (next.length === active.length && next.every((name, index) => name === active[index])) return;
    pi.setActiveTools(next);
  } catch {
  }
}
function registerHostedTools(pi, endpoints = DEFAULT_ENDPOINTS) {
  const tools = [...codexTools(endpoints), ...xaiTools(endpoints)];
  for (const { provider, execute, ...tool } of tools) {
    pi.registerTool({
      ...tool,
      execute(toolCallId, params, signal, onUpdate, ctx) {
        if (ctx.model?.provider !== provider)
          throw new HostedToolError(`${tool.name} \u53EA\u5728\u5F53\u524D\u6A21\u578B\u7684 provider \u4E3A ${provider} \u65F6\u53EF\u7528\uFF0C\u6CA1\u6709\u53D1\u51FA\u8BF7\u6C42\u3002`);
        return execute(toolCallId, params ?? {}, signal, onUpdate, ctx);
      }
    });
  }
  pi.on("session_start", (_event, ctx) => syncHostedTools(pi, tools, ctx.model));
  pi.on("model_select", (event, ctx) => syncHostedTools(pi, tools, event.model ?? ctx.model));
  pi.on("before_agent_start", (_event, ctx) => syncHostedTools(pi, tools, ctx.model));
}
function hostedToolsExtension(pi) {
  registerHostedTools(pi);
}
export {
  hostedToolsExtension as default,
  registerHostedTools,
  syncHostedTools
};
//# sourceMappingURL=hosted-tools.js.map