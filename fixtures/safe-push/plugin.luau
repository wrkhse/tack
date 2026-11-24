--!strict

local guardStatus = require("./guard-status")

local plugin = {
    name = "safe-push",
    toolBefore = function(payload, ctx)
        if ctx.tool == "shell" and string.find(payload.command, "^git push") then
            return ctx.deny("push blocked")
        end
        return nil
    end,
    tools = {
        guard_status = guardStatus,
    },
}

return plugin
