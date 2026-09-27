/* With every song source unreachable the game must say so on the setup
   screen instead of hanging, and the ?debug=1 overlay must show the crate
   log line that explains why.
   node e2e/offline.mjs [--profile=phone|desktop] [--shots=dir] */
import path from "node:path";
import { serve, open, args } from "./harness.mjs";

const A = args({ profile: "phone" });
const server = await serve();
const { browser, page, errors } = await open(A.profile);
let exit = 0;
try {
  await page.route(/saavn|itunes\.apple|catalog\.json|snips\.json/, r => r.abort());
  await page.goto(server.url + "?debug=1");
  await page.locator(".dbg-panel").waitFor();
  await page.getByRole("button", { name: "close" }).click();
  await page.getByRole("button", { name: /Start the show/ }).click();
  await page.getByRole("alert").getByText(/Not enough verified music-only clips/).waitFor({ timeout: 60000 });
  const box = await page.getByRole("alert").boundingBox();
  if (!box || box.y < 0 || box.y > (await page.evaluate(() => innerHeight)) / 2) throw new Error("error banner is off screen");
  await page.getByRole("button", { name: "log" }).click();
  await page.locator(".dbg-body").getByText(/crate mix=both difficulty=medium source=index.*snips=none/).waitFor();
  if (A.shots) await page.screenshot({ path: path.join(A.shots, `${A.profile}-offline.png`) });
  if (errors.length) throw new Error(errors.join(" | "));
  console.log("PASS offline", A.profile, "error shown, debug overlay has the crate line");
} catch (e){
  exit = 1;
  console.log("FAIL offline", A.profile, e.message.split("\n")[0]);
} finally {
  await browser.close();
  server.close();
  process.exit(exit);
}
