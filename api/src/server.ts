import { start } from "./boot.js";

start()
  .then((running) => {
    const stop = () => {
      console.log("[aura] shutting down");
      running.stop().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 8_000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
