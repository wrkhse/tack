export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const shim = (await $.fs.read("probe-out/shim-path.txt")).trim();
    let direct;

    try {
      direct = await $.process.run([shim, "tack-tool", "probe-direct", "PROJ-1"], { timeoutMs: 5000 });
    } catch (err) {
      direct = { error: String(err) };
    }

    await $.fs.write("probe-out/shim-direct.json", JSON.stringify({ shim, direct, input: e }));

    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const shim = (await $.fs.read("probe-out/shim-path.txt")).trim();
    let direct;

    try {
      direct = await $.process.run([shim, "probe-shim", "from-tool-call"], { timeoutMs: 5000 });
    } catch (err) {
      direct = { error: String(err) };
    }

    await $.fs.write("probe-out/shim-call.json", JSON.stringify({ direct, input: e }));

    return next(e);
  });
};
