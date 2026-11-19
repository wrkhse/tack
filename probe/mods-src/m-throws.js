export const register = (on) => {
  on("tool.call", { tool: "Bash" }, async () => {
    throw new Error("probe guard threw");
  });
};
