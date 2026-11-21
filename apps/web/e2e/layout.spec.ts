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
      // Text typed into a field scrolls inside it by design.
      if (box.tagName === "INPUT" || box.tagName === "TEXTAREA" || box.tagName === "SELECT") continue;
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

async function signInAs(page: Page, handle: string, answer: "private" | "shared" | null = "private") {
  // The device question is asked once per browser; most checks answer it up front.
  if (answer) await page.addInitScript((a) => localStorage.setItem("bastion.device-kind", a), answer);
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
        await page.getByPlaceholder(/^Message #/).fill(long);
        await page.locator(".composer button", { hasText: "Send" }).click();
        await check(page, "channel", size.name);
      }

      await rail.getByRole("button", { name: "Privacy", exact: true }).click();
      await check(page, "privacy", size.name);

      // The erase section sits below the fold: scroll to it, then check and look at it.
      await page.getByRole("heading", { name: "Erase messages from this device" }).scrollIntoViewIfNeeded();
      await page.getByRole("button", { name: "Sign out and erase this device…" }).click();
      await expect(page.getByRole("button", { name: "Yes, erase and sign out" })).toBeVisible();
      await page.getByRole("button", { name: "Yes, erase and sign out" }).scrollIntoViewIfNeeded();
      await check(page, "privacy-erase", size.name);
    });

    test("moderation screens", async ({ page }) => {
      const LONG = "an-extremely-long-unbroken-reason-" + "y".repeat(150);
      const ULID = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
      // Fill the lists with awkward text so the overflow scan has something to catch.
      await page.route(/\/api\/servers\/[^/]+\/reports(\?|$)/, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
          json: [
            {
              id: ULID(1), serverId: ULID(2), channelId: ULID(3), category: "harassment", note: LONG, status: "open", handledBy: null,
              messages: [
                { id: ULID(4), authorId: ULID(5), content: LONG + " " + LONG, createdAt: Date.now() - 60_000 },
                { id: ULID(6), authorId: ULID(5), content: "short one", createdAt: Date.now() },
              ],
              createdAt: Date.now() - 30_000, updatedAt: Date.now(),
            },
          ],
        });
      });
      await page.route(/\/api\/servers\/[^/]+\/bans(\?|$)/, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({ json: [{ serverId: ULID(2), userId: ULID(7), reason: LONG, createdBy: ULID(8), createdAt: Date.now() }] });
      });
      await page.route(/\/api\/servers\/[^/]+\/audit-log(\?|$)/, async (route) => {
        await route.fulfill({
          json: [
            { id: ULID(9), serverId: ULID(2), actorId: ULID(8), action: "member.ban", targetId: ULID(7), channelId: null, reason: LONG, reasonCode: "harassment", data: { deletedMessages: 12 }, createdAt: Date.now() },
            { id: ULID(10), serverId: ULID(2), actorId: ULID(8), action: "role.update", targetId: ULID(11), channelId: null, reason: null, reasonCode: null, data: { name: LONG }, createdAt: Date.now() },
          ],
        });
      });

      await signInAs(page, "alice");
      await page.getByRole("navigation", { name: "Servers" }).getByRole("button").nth(1).click();

      // Members: open each moderation form on someone who is not the owner.
      const members = page.locator(".members");
      const manage = members.getByRole("button", { name: "Manage" }).first();
      await expect(manage).toBeVisible();
      await manage.click();
      await check(page, "member-tools", size.name);
      await members.getByRole("button", { name: "Timeout…" }).click();
      await members.getByLabel("Reason (shown in the audit log)").fill(LONG);
      await check(page, "member-timeout", size.name);
      await members.getByRole("button", { name: "Back" }).click();
      await members.getByRole("button", { name: "Kick…" }).click();
      await members.getByLabel("Reason (shown in the audit log)").fill(LONG);
      await check(page, "member-kick", size.name);
      await members.getByRole("button", { name: "Back" }).click();
      await members.getByRole("button", { name: "Ban…" }).click();
      await check(page, "member-ban", size.name);
      await members.getByRole("button", { name: "Back" }).click();
      await members.getByRole("button", { name: "Close" }).click();

      // The owner sees every tab.
      await page.locator(".sidebar").getByRole("button", { name: "Moderation" }).click();
      await expect(page.getByRole("tab")).toHaveText(["Reports", "Roles", "Bans", "Audit log"]);
      await expect(page.getByText("short one")).toBeVisible();
      await check(page, "mod-reports", size.name);

      await page.getByRole("tab", { name: "Roles" }).click();
      await page.getByRole("list", { name: "Roles" }).getByRole("button", { name: "Moderator" }).click();
      await expect(page.getByRole("heading", { name: "Moderator" })).toBeVisible();
      await check(page, "mod-roles", size.name);
      await page.getByRole("button", { name: "+ New role" }).click();
      await page.getByLabel("Name").fill(LONG);
      await check(page, "mod-roles-new", size.name);

      await page.getByRole("tab", { name: "Bans" }).click();
      await expect(page.getByRole("button", { name: "Unban" })).toBeVisible();
      await check(page, "mod-bans", size.name);

      await page.getByRole("tab", { name: "Audit log" }).click();
      await expect(page.locator(".audit").getByText("banned a member")).toBeVisible();
      await check(page, "mod-audit", size.name);
    });

    test("a moderator sees only the tools they were given", async ({ page }) => {
      await signInAs(page, "bob");
      await page.getByRole("navigation", { name: "Servers" }).getByRole("button").nth(1).click();
      await page.locator(".sidebar").getByRole("button", { name: "Moderation" }).click();
      // Bob can handle reports and read the audit log, but cannot edit roles or ban.
      await expect(page.getByRole("tab")).toHaveText(["Reports", "Audit log"]);
      await check(page, "mod-bob", size.name);
      const members = page.locator(".members");
      await members.getByRole("button", { name: "Manage" }).first().click();
      await expect(members.getByRole("button", { name: "Kick…" })).toBeVisible();
      await expect(members.getByRole("button", { name: "Ban…" })).toHaveCount(0);
      await expect(members.getByText("Roles", { exact: true })).toHaveCount(0);
    });

    test("attach a file and see it encrypted before upload", async ({ page }) => {
      const FILE_ID = "01HZZZZZZZZZZZZZZZZZZZZF99";
      const NAME = "a-very-long-file-name-" + "z".repeat(100) + ".txt";
      const contents = "hello from the attach test";
      let stored: Buffer | null = null;
      // Stand in for storage: the browser PUTs ciphertext to an address on the app's own origin.
      await page.route(/\/api\/files\/uploads$/, (route) =>
        route.fulfill({ status: 201, json: { fileId: FILE_ID, uploadUrl: "http://localhost:5173/fake-storage/put", headers: { "content-type": "application/octet-stream" }, expiresAt: Date.now() + 60_000 } }),
      );
      await page.route(/\/fake-storage\/put$/, async (route) => {
        stored = route.request().postDataBuffer();
        await route.fulfill({ status: 200, body: "" });
      });
      await page.route(/\/api\/files\/uploads\/[^/]+\/complete$/, (route) =>
        route.fulfill({ json: { id: FILE_ID, visibility: "private", status: "ready", size: stored?.length ?? 0, contentType: "application/octet-stream", createdAt: Date.now() } }),
      );

      await signInAs(page, "alice");
      await page.getByRole("navigation", { name: "Servers" }).getByRole("button").nth(1).click();
      await page.locator(".sidebar ul button").first().click();
      await expect(page.getByRole("button", { name: "Attach file" })).toBeEnabled();

      await page.locator('input[type="file"]').setInputFiles({ name: NAME, mimeType: "text/plain", buffer: Buffer.from(contents) });
      await expect(page.locator(".pending-files .chip")).toBeVisible();
      await check(page, "attach-pending", size.name);
      // What reached storage is ciphertext, not the file.
      expect(stored).not.toBeNull();
      expect(stored!.toString()).not.toContain(contents);

      // Send is on once a file is attached, even with no text. Local dev has no encrypted group for the
      // channel (sending says conversation_not_ready), so the sent message is not checked here.
      await expect(page.locator(".composer button", { hasText: "Send" })).toBeEnabled();
      await page.getByRole("button", { name: "Remove "+NAME }).click();
      await expect(page.locator(".pending-files .chip")).toHaveCount(0);
    });

    test("private or shared device question", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Sign in as alice" }).click();
      await expect(page.getByRole("heading", { name: "Is this your own device?" })).toBeVisible();
      await check(page, "device-question", size.name);
      await page.getByRole("button", { name: "This is a shared device" }).click();
      await expect(page.getByRole("navigation", { name: "Servers" })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("bastion.device-kind"))).toBe("shared");
    });
  });
}
