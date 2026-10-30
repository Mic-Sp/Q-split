/** Ping the engine once per Node.js server startup to begin waking a cold instance. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { prewarmEngine } = await import("./lib/engine");
    await prewarmEngine();
  }
}
