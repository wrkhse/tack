export const register = (on) => {
  on("session.start", async ($, e, next) => {
    const globals = {
      setTimeout: typeof setTimeout,
      clearTimeout: typeof clearTimeout,
      setInterval: typeof setInterval,
      queueMicrotask: typeof queueMicrotask,
      fetch: typeof fetch,
      Buffer: typeof Buffer,
      console: typeof console,
      process: typeof process,
      AbortController: typeof AbortController,
      TextEncoder: typeof TextEncoder,
      atob: typeof atob,
      performanceNow: typeof performance.now,
      cryptoDigest: typeof crypto.subtle.digest,
      structuredClone: typeof structuredClone,
      realm: globalThis["tack-probe-realm"] ?? "none",
    };

    globalThis["tack-probe-realm"] = "m-globals";

    let run;

    try {
      run = await $.process.run(["git", "probe-shim", "session-start"], { timeoutMs: 5000 });
    } catch (err) {
      run = { error: String(err) };
    }

    await $.fs.write("probe-out/globals-start.json", JSON.stringify({ globals, run, input: e }));

    await $.session.append({
      message: { type: "user", content: [{ type: "text", text: "tack-probe-append-start" }] },
    });

    return next(e);
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    let run;

    try {
      run = await $.process.run(["git", "probe-shim", "tool-call"], { timeoutMs: 5000 });
    } catch (err) {
      run = { error: String(err) };
    }

    await $.fs.write("probe-out/globals-tool.json", JSON.stringify({ run, input: e }));

    await $.session.append({
      message: { type: "user", content: [{ type: "text", text: "tack-probe-append-now" }] },
    });

    return next(e);
  });

  on("session.end", async ($, e, next) => {
    await $.fs.write("probe-out/globals-end.json", JSON.stringify(e));

    return next(e);
  });
};
