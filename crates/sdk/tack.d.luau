--!strict

-- The SDK contract major is 1. A plugin built against another major is refused
-- with a named contract_major_mismatch error.

-- The scoped module loader bound into each module chunk's environment, with
-- Luau's stock require absent. A specifier resolves relative to the requiring
-- file, only inside the canonical plugin folder: absolute paths, parent
-- segments, symlinks that escape the folder, missing modules and cycles are
-- rejected. Each module is evaluated once per path and cached. Annotate
-- requires under --!strict using this declaration.
declare require: (path: string) -> any

export type DenyResult = { deny: string }
export type RewriteResult = { rewrite: any }
export type AnnotateResult = { annotate: { [string]: any } }
export type DropResult = { drop: true }
export type AllowResult = { allow: true }
export type HookResult = DenyResult | RewriteResult | AnnotateResult | DropResult | AllowResult | nil
export type ToolBeforeResult = HookResult
export type OnError = "deliver" | "deny"

-- Capabilities are injected into hooks by the barn stall. No runtime client
-- module is importable, and the default grant is none: a plugin must be
-- granted `control.call.<name>` at build time to call that control.
export type Control = { call: (name: string, input: any) -> any }

-- Rust-backed helpers passed as the second hook and tool argument.
export type HookCtx = {
    control: Control?,
    deny: (reason: string) -> DenyResult,
    rewrite: (payload: any) -> RewriteResult,
    allow: () -> nil,
    annotate: (fields: { [string]: any }) -> AnnotateResult,
    drop: () -> DropResult,
}

-- The tack daemon adds this metadata for toolBefore hooks. The payload is
-- the tool input. The daemon overlays rewrite fields on that input.
export type ToolBeforeCtx = HookCtx & {
    tool: string,
    name: string,
    session_id: string?,
}

-- A hook field may be a function, one handler, or an array of handlers. The
-- barn engine runs handlers in descending priority, within each handler's
-- budget.
-- Defaults applied by the barn engine: priority 0; budgetMs the sandbox's
-- per-call cap; onError "deny" (fails closed).
-- Handlers with equal priority run in array order. A priority or budgetMs that
-- is NaN, fractional or out of range is rejected by name.
-- `{ allow = true }` is a valid result.
export type HookHandler = {
    priority: number?,
    budgetMs: number?,
    onError: OnError?,
    run: (payload: any, ctx: HookCtx) -> HookResult?,
}
export type HookTable = { HookHandler } | HookHandler
export type ToolBeforeHandler = {
    priority: number?,
    budgetMs: number?,
    onError: OnError?,
    run: (payload: any, ctx: ToolBeforeCtx) -> ToolBeforeResult?,
}
export type ToolBeforeHookTable = { ToolBeforeHandler } | ToolBeforeHandler
export type ToolBeforeFn = (payload: any, ctx: ToolBeforeCtx) -> ToolBeforeResult
export type EventBeforeFn = (payload: any, ctx: HookCtx) -> HookResult

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
    toolBefore: (ToolBeforeFn | ToolBeforeHookTable)?,
    eventBefore: (EventBeforeFn | HookTable)?,
    tools: { [string]: ToolDef }?,
}
