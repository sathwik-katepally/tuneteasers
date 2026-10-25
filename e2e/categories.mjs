/* The song-category chips on the setup screen: Any clears the others, the
   rest combine, thin ones are greyed with their count (Music-only too, with
   its reason), a chosen chip that turns thin can still be turned off, the
   choice survives a reload, saves from before categories load as Any, and an
   unreachable corpus neither enables the chips nor lets a categories game
   fall back to untagged songs.
   node e2e/categories.mjs [--profile=phone|desktop] [--shots=dir] */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved, moreSettings, pickLangs } from "./harness.mjs";

const A = args({ profile: "phone" });
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const fail = msg => { throw new Error(msg); };

const server = await serve();
const { browser, page, errors } = await open(A.profile);
const chip = label => page.getByRole("button", { name: new RegExp(`^${label}(, \\d+ songs)?$`) });
const pressed = async label => (await chip(label).getAttribute("aria-pressed")) === "true";
const expectPressed = async (want, when) => {
  for (const l of ["Any", "Dance & party", "Romantic", "Sad", "Item songs", "Mass"])
    if (await pressed(l) !== want.includes(l)) fail(`${when}: ${l} should be ${want.includes(l) ? "on" : "off"}`);
};
const counted = label => page.waitForFunction(l => [...document.querySelectorAll("button")].some(b => new RegExp(`^${l}, \\d+ songs$`).test(b.getAttribute("aria-label") || "")), label);
async function shot(name){
  if (!shotsDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shotsDir, `${A.profile}-${name}.png`), fullPage: true });
}
async function seed(state){
  await page.goto(server.url + "seed.html");
  await page.evaluate(v => { localStorage.clear(); if (v) localStorage.setItem("tuneteasers_v7", JSON.stringify(v)); }, state);
  await page.goto(server.url);
  await page.getByRole("button", { name: /Start the show/ }).waitFor();
  await moreSettings(page);
}

let exit = 0;
try {
  await seed(null);
  await counted("Item songs");
  await page.getByRole("radio", { name: "With singing" }).click();
  await expectPressed(["Any"], "fresh install");
  await shot("cat-01-any");

  await chip("Item songs").click();
  await expectPressed(["Item songs"], "after Item");
  await chip("Mass").click();
  await expectPressed(["Item songs", "Mass"], "after Mass");
  if (JSON.stringify((await saved(page)).settings.categories) !== '["mass","item"]') fail("categories not saved in config order");
  await shot("cat-02-item-mass");
  await chip("Any").click();
  await expectPressed(["Any"], "after Any");
  await chip("Item songs").click();

  await page.reload();
  await moreSettings(page);
  await counted("Item songs");
  await expectPressed(["Item songs"], "after reload");

  // Music-only: item songs rarely have a clean instrumental stretch.
  await page.getByRole("radio", { name: "Music only" }).click();
  await page.getByText(/Music.only needs a stretch with no singing/).waitFor();
  const item = chip("Item songs");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => /^Item songs, \d+ songs$/.test(b.getAttribute("aria-label") || "") && /only \d+/.test(b.textContent)));
  if (await item.isDisabled()) fail("a chosen thin chip must stay tappable");
  await shot("cat-03-music-only");
  await item.click();
  await expectPressed(["Any"], "turning off a thin chip");
  if (!(await item.isDisabled())) fail("thin Item chip is not greyed out in Music-only");
  const text = await item.textContent();
  const n = Number(text.match(/only (\d+)/)?.[1] ?? NaN);
  if (!(n < 10)) fail(`Item chip should show a count below the show's 10 turns: "${text}"`);

  // A thin chip on Easy: a long show for a big crowd in one language and era.
  await page.getByRole("radio", { name: "With singing" }).click();
  await pickLangs(page, ["Hindi"]);
  await page.getByRole("radio", { name: "2000s" }).click();
  await page.getByRole("radio", { name: "8", exact: true }).click();
  for (const name of ["Anu", "Ravi", "Meera", "Kiran"]){
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.keyboard.type(name); await page.keyboard.press("Enter");
  }
  await page.getByText(/not enough songs for 48 turns/).waitFor();
  if (!(await chip("Item songs").isDisabled())) fail("Item not greyed for 48 turns of Hindi 2000s");
  if (await chip("Dance & party").isDisabled()) fail("Dance & party greyed for 48 turns of Hindi 2000s");
  await shot("cat-04-thin-easy");

  // Saves from before categories (and junk) load as Any, or keep what is valid.
  const base = (await saved(page));
  const { categories, ...old } = base.settings;
  void categories;
  await seed({ ...base, settings: old, game: null });
  await counted("Item songs");
  await expectPressed(["Any"], "save without categories");
  await seed({ ...base, settings: { ...old, categories: ["item", "nope", 7, "item"] }, game: null });
  await counted("Item songs");
  await expectPressed(["Item songs"], "save with junk categories");

  // Categories follow the languages: English has hip hop and no item or mass songs, so a
  // chosen Item goes, with a line saying why, when English is the only language left.
  await seed({ ...base, settings: { ...old, langs: ["hindi"], eras: ["2000s", "2010s", "2020s"], rounds: 3, categories: ["item"] }, players: [{ id: "p1", name: "Solo", members: [] }], game: null });
  await counted("Item songs");
  if (await chip("Hip hop").count()) fail("Hip hop shown for a Hindi show");
  await pickLangs(page, ["English"]);
  await page.getByRole("status").getByText("No Item songs in English, so that choice is off.").waitFor();
  await counted("Hip hop");
  if (await chip("Item songs").count() || await chip("Mass").count()) fail("Item or Mass shown for an English show");
  if (!(await pressed("Any")) || await pressed("Hip hop")) fail("Item dropped for English: Any should be the only pick");
  if (JSON.stringify((await saved(page)).settings.categories) !== "[]") fail("dropped category still saved");
  await pickLangs(page, ["Hindi", "English"]);
  await counted("Item songs");
  await counted("Hip hop");
  await shot("cat-05-english");

  // No corpus: the chips stay off, and a categories game does not fall back to untagged songs.
  await page.route(u => u.pathname.endsWith("/corpus.json"), r => r.abort("connectionrefused"));
  await seed({ ...base, settings: { ...old, difficulty: "easy", rounds: 3, categories: ["item"] }, players: [{ id: "p1", name: "Solo", members: [] }], game: null });
  await page.getByText(/Categories need the song list/).waitFor();
  if (!(await chip("Mass").isDisabled())) fail("chips enabled without a corpus");
  await shot("cat-06-offline");
  await page.getByRole("button", { name: /Start the show/ }).click();
  await page.getByText(/Couldn't load songs/).waitFor({ timeout: 30000 });
  if ((await saved(page)).game) fail("a categories game started without the corpus");

  if (errors.length) fail("page errors: " + errors.join(" | "));
  console.log("PASS categories", A.profile, `music-only item count=${n}`);
} catch (e){
  exit = 1;
  console.log("FAIL categories", A.profile, e.message.split("\n").slice(0, 8).join(" / "));
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${A.profile}-cat-FAIL.png`), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.close();
  process.exit(exit);
}
