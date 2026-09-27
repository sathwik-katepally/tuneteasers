/* iOS Safari only lets an <audio> element start from a timer once that same
   element has been played inside a tap. Headless browsers are laxer, so this
   emulates the rule: play() outside a tap rejects with NotAllowedError unless
   the element was unlocked in a tap earlier.
   Pass 1 (rule as on iOS): the hand-over tap primes the element, so the
   countdown's timer-started clip must play without any extra tap.
   Pass 2 (stricter, nothing unlocks): the game must fall back to a
   "Tap to play" button that works.
   node e2e/autoplay.mjs */
import { serve, open } from "./harness.mjs";

const stub = strict => {
  let inTap = false;
  addEventListener("click", () => { inTap = true; setTimeout(() => { inTap = false; }, 0); }, true);
  const real = HTMLMediaElement.prototype.play;
  window.__ttBlocked = 0;
  HTMLMediaElement.prototype.play = function(){
    if (inTap){ if (!strict) this.__unlocked = true; return real.call(this); }
    if (this.__unlocked) return real.call(this);
    window.__ttBlocked++;
    return Promise.reject(new DOMException("blocked", "NotAllowedError"));
  };
};

const server = await serve();
let exit = 0;
for (const strict of [false, true]){
  const { browser, context, page, errors } = await open("desktop");
  await context.addInitScript(stub, strict);
  try {
    await page.goto(server.url);
    await page.getByRole("radio", { name: "Hindi", exact: true }).click();
    await page.getByRole("button", { name: /Start the show/ }).click();
    await page.getByRole("button", { name: /^It's with me/ }).click();
    const tap = page.getByRole("button", { name: "Tap to play" });
    const left = page.getByText(/\ds left/);
    await Promise.race([tap.waitFor({ timeout: 30000 }), left.waitFor({ timeout: 30000 })]).catch(() => {});
    const blocked = await tap.isVisible();
    if (!strict){
      if (blocked) throw new Error("countdown clip was blocked even though the hand-over tap primed it");
      const n = await page.evaluate(() => window.__ttBlocked);
      if (n) throw new Error(`${n} play() calls were refused`);
      console.log("PASS autoplay: primed element plays from the countdown timer");
    } else {
      if (!blocked) throw new Error("no Tap to play fallback when autoplay is refused");
      await tap.click();
      await left.waitFor({ timeout: 20000 });
      await page.getByRole("button", { name: "Game menu" }).click();
      await page.getByRole("button", { name: "End game" }).click();
      await page.getByRole("button", { name: "End it" }).click();
      await page.getByRole("button", { name: /Start the show/ }).waitFor();
      if (await page.getByText("Show in progress").count()) throw new Error("ended game still offered for resume");
      if (errors.length) throw new Error(errors.join(" | "));
      console.log("PASS autoplay: refused autoplay falls back to Tap to play, which plays; End game clears the show");
    }
  } catch (e){
    exit = 1;
    console.log("FAIL autoplay", strict ? "strict" : "ios-rule", e.message.split("\n")[0]);
  } finally { await browser.close(); }
}
server.close();
process.exit(exit);
