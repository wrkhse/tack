export const register = (on) => {
  on("session.start", async ($, e, next) => {
    void $.clock.after(200, () => {
      void $.fs.write("probe-out/dollar-closure.json", JSON.stringify({ ok: true }));
    });

    return next(e);
  });
};
