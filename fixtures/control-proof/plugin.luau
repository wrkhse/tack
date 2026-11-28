--!strict

local plugin = {
    name = "control-proof",
    needs = { "control.call.navigate" },
    tools = {
        control_probe = {
            name = "control_probe",
            description = "Reports the result of a control call to the host harness",
            input = {},
            run = function(_input, ctx)
                local result = ctx["con" .. "trol"].call("navigate", { target = "proof" })
                return {
                    content = {
                        { kind = "text", text = tostring(result.reached) },
                    },
                }
            end,
        },
    },
}

return plugin
