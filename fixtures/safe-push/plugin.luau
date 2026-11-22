--!strict

local guardStatus = require("./guard-status")

local plugin = {
    name = "safe-push",
    toolBefore = function(call, ctx)
        if call.tool == "shell" and string.find(call.input.command, "^git push") then
            return ctx.deny("push blocked")
        end
        return nil
    end,
    tools = {
        guard_status = guardStatus,
    },
}

return plugin
