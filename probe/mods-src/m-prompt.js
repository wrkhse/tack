export const register = (on) => {
  on("prompt.submit", async ($, e, next) => {
    await $.fs.write("probe-out/prompt.json", JSON.stringify(e));

    const context = Array.isArray(e.context) ? e.context : [];

    return next({
      ...e,
      context: [...context, { type: "text", text: "tack-probe-context" }],
    });
  });
};
