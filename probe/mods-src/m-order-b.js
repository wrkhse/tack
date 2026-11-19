export const register = (on) => {
  on("session.start", async ($, e, next) => {
    let seen;

    try {
      seen = globalThis["tack-probe-realm-a"] ?? "none";
    } catch (err) {
      seen = "error: " + String(err);
    }

    globalThis["tack-probe-realm-b"] = "m-order-b";

    await $.fs.write("probe-out/order-b.json", JSON.stringify({ seen, input: e }));

    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    await $.fs.write("probe-out/order-b-call.json", JSON.stringify(e));

    return next({ ...e, command: e.command + " --B" });
  });
};
