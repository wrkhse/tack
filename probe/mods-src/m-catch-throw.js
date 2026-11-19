function guard() {
  throw new Error("probe catch guard threw");
}

export const register = (on) => {
  on("tool.call", { tool: "Bash" }, guard).catch(async ($, e, next) => {
    await $.fs.write("probe-out/catch-throw.json", JSON.stringify({ called: next.called, error: next.error }));

    if (next.called) return next(e);

    return { deny: "probe guard failed: " + next.error.kind };
  });
};
