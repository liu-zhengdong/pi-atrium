import { describe, expect, it } from "vitest";
import { buildProxyDescription } from "../direct-tool-surface.ts";
import { resolveMcpToolExposure, type McpConfig } from "../types.ts";

describe("固定代理模式", () => {
  it("默认沿用配置，显式选择固定代理", () => {
    expect(resolveMcpToolExposure(undefined)).toBe("configured");
    expect(resolveMcpToolExposure("configured")).toBe("configured");
    expect(resolveMcpToolExposure("proxy-only")).toBe("proxy-only");
    for (const bad of [null, true, 1, "", "proxy", " proxy-only", {}])
      expect(() => resolveMcpToolExposure(bad)).toThrow("toolExposure");
  });

  it("服务注册、删除、禁用和搜索模式不改变代理描述", () => {
    const empty: McpConfig = { mcpServers: {}, settings: { toolExposure: "proxy-only" } };
    const description = buildProxyDescription(empty);
    const variants: McpConfig[] = [
      { ...empty, mcpServers: { privateName: { url: "https://example.test/mcp", directTools: true } } },
      { ...empty, mcpServers: { changedName: { command: "tool", directTools: "search" } } },
      { ...empty, mcpServers: { hiddenName: { command: "tool", disabled: true } } },
    ];
    for (const config of variants) expect(buildProxyDescription(config)).toBe(description);
    expect(description).toContain('mcp({ server: "name" })');
    expect(description).toContain('mcp({ describe: "tool_name" })');
    expect(description).not.toContain("Servers:");
    expect(description).not.toContain("Search-mode servers");
  });

  it("默认描述仍保留配置中的服务和搜索模式提示", () => {
    const config: McpConfig = { mcpServers: { original: { command: "tool", directTools: "search" } } };
    expect(buildProxyDescription(config)).toContain("Servers: original");
    expect(buildProxyDescription(config)).toContain("Search-mode servers (original)");
    expect(buildProxyDescription(config, "proxy-only")).not.toContain("original");
  });
});
