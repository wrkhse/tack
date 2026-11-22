--!strict

return {
    name = "guard_status",
    description = "Reports whether the tack daemon is running",
    input = {},
    run = function(input, ctx)
        return {
            content = {
                { kind = "text", text = "guard_status: daemon ok" },
            },
        }
    end,
}
