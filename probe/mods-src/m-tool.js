export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const echo = await $.tool.register({
      name: "echo",
      description: "Probe echo tool",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      isDeferred: false,
    });
    const fail = await $.tool.register({
      name: "fail",
      description: "Probe failing tool",
      inputSchema: { type: "object" },
      isDeferred: false,
    });

    await $.fs.write("probe-out/tool-register.json", JSON.stringify({ echo, fail }));

    return next(e);
  });

  for (const short of ["echo", "fail"]) {
    on("tool.call", { tool: "mcp__m-tool__" + short }, async ($, e) => {
      await $.fs.write("probe-out/tool-" + short + ".json", JSON.stringify(e));

      return { result: short === "fail" ? "probe tool failed: " + JSON.stringify(e) : "probe echo: " + JSON.stringify(e) };
    });
  }
};
