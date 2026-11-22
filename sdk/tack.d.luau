--!strict

-- The call a toolBefore hook inspects before the harness runs it.
export type ToolCall = {
    tool: string,
    name: string,
    input: any,
    session_id: string?,
}

export type DenyResult = { deny: string }
export type RewriteResult = { rewrite: { command: string } }
export type ToolBeforeResult = DenyResult | RewriteResult | nil

-- Rust-backed helpers passed as the second hook and tool argument.
export type HookCtx = {
    deny: (reason: string) -> DenyResult,
    rewrite: (command: string) -> RewriteResult,
    allow: () -> nil,
}

export type Content = { kind: string, text: string }
export type ToolResult = { content: { Content } }

export type ToolDef = {
    name: string,
    description: string?,
    input: any?,
    run: (input: any, ctx: HookCtx) -> ToolResult,
}

-- The table plugin.luau must return.
export type Plugin = {
    name: string,
    needs: { string }?,
    toolBefore: ((call: ToolCall, ctx: HookCtx) -> ToolBeforeResult)?,
    tools: { [string]: ToolDef }?,
}
