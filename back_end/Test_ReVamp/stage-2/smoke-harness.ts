import { runDbSeed, withTemporaryTestApi } from "../lib/test-api-harness.js";

async function go() {
  console.log("smoke: seed");
  runDbSeed();
  console.log("smoke: api");
  await withTemporaryTestApi("4018", async (u) => {
    const r = await fetch(`${u}/health`);
    console.log("smoke: health", r.status);
  });
  console.log("smoke: done");
}

go().catch((e) => {
  console.error("smoke fail", e);
  process.exit(1);
});
