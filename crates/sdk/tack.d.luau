--!strict

-- The SDK contract major is 1. The pure major check is used by build-time
-- tests; the running daemon's named contract_major_mismatch refusal comes
-- later with the barn engine.

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

-- Capabilities are injected into hooks by the barn stall later. Today this
-- file only declares them, and a build-time audit scans plugin sources. A
-- plugin declares the capabilities it calls in its `needs` list, such as
-- `control.call.navigate`. The audit is an early, developer-facing error that
-- can be bypassed, not a security boundary: host config grants them per plugin
-- in a later PR, and the daemon's refusal of undeclared or ungranted calls at
-- run time is the later security boundary. No runtime client module is
-- importable. The audit scans comments and string literals too, so mentioning
-- a capability counts as a call (conservative fail-closed).
--
-- There is one accepted spelling of a capability call: the hook parameter is
-- named `ctx`, and the call is `ctx.control.call("<ident>", ...)`. tack build
-- refuses any other spelling with the named `control_call_form` error.
--
-- ## Known bypasses
-- The build audit cannot prove these at runtime:
--   - a plugin that is not built by tack;
--   - a call injected after build by another loader;
--   - a runtime capability obtained outside the stall grant.
export type Control = { call: (name: string, input: any) -> any }

-- Rust-backed helpers passed as the second hook and tool argument.
export type HookCtx = {
    control: Control,
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
