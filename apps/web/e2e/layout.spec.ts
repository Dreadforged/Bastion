import { expect, test, type Page } from "@playwright/test";

// Each size is checked on every screen. Screenshots land in e2e/screenshots
// so a person can look at them; the pass or fail check is the overflow scan.
const sizes = [
  { name: "wide", width: 1440, height: 900 },
  { name: "laptop", width: 1100, height: 700 },
  { name: "narrow", width: 820, height: 640 },
];

interface Spill {
  element: string;
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Finds text that spills outside its box: an element whose content is wider
 * than the element while it neither scrolls nor clips on purpose, or an
 * element that clips with no ellipsis. Also reports sideways page scroll.
 */
async function findOverflow(page: Page): Promise<Spill[]> {
  return page.evaluate(() => {
    const found: Spill[] = [];
    const describe = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    for (const el of document.querySelectorAll("body *")) {
      const box = el as HTMLElement;
      if (box.clientWidth === 0 || box.scrollWidth <= box.clientWidth + 1) continue;
      const style = getComputedStyle(box);
      if (style.display === "inline") continue;
      const x = style.overflowX;
      // A scroll container is allowed to scroll.
      if (x === "auto" || x === "scroll") continue;
      // Clipped text is fine only when it shows an ellipsis.
      if ((x === "hidden" || x === "clip") && style.textOverflow === "ellipsis") continue;
      found.push({
        element: describe(box),
        text: (box.textContent ?? "").trim().slice(0, 40),
        scrollWidth: box.scrollWidth,
        clientWidth: box.clientWidth,
      });
    }
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) {
      found.push({ element: "page", text: "sideways scroll", scrollWidth: doc.scrollWidth, clientWidth: window.innerWidth });
    }
    return found;
  });
}

async function check(page: Page, label: string, size: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `e2e/screenshots/${size}-${label}.png`, fullPage: false });
  expect(await findOverflow(page), `${label} at ${size}`).toEqual([]);
}

async function signInAs(page: Page, handle: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Sign in as ${handle}` }).click();
  await expect(page.getByRole("navigation", { name: "Servers" })).toBeVisible();
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("sign-in screen", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Sign in as alice" })).toBeVisible();
      await check(page, "signin", size.name);
    });

    test("server, channel, settings and messages", async ({ page }) => {
      await signInAs(page, "alice");
      const rail = page.getByRole("navigation", { name: "Servers" });
      await check(page, "home", size.name);

      // Open the first server and its first channel.
      await rail.getByRole("button").nth(1).click();
      await check(page, "server", size.name);
      const channel = page.locator(".sidebar ul button").first();
      if (await channel.count()) {
        await channel.click();
        const long = "a-very-long-unbroken-message-" + "x".repeat(120);
        await page.locator(".composer input").fill(long);
        await page.locator(".composer button").click();
        await check(page, "channel", size.name);
      }

      await rail.getByRole("button", { name: "Privacy", exact: true }).click();
      await check(page, "privacy", size.name);
    });
  });
}
