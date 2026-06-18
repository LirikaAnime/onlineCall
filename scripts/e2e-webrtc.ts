import { chromium, expect, firefox, Page } from "@playwright/test";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000/";
const browserName = process.env.E2E_BROWSER ?? "chromium";
const sharedRoom = process.env.E2E_SHARED_ROOM === "true";
const skipMedia = process.env.E2E_SKIP_MEDIA === "true";
const blockPeerJs = process.env.E2E_BLOCK_PEERJS === "true";
const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const firefoxPath = process.env.FIREFOX_PATH;

async function waitForRoomReady(page: Page) {
  await expect(page.locator(".room-code")).toHaveText(/[a-z0-9]{6,16}/, {
    timeout: 20_000
  });
  await expect(page.locator(".connection-banner")).toContainText(/открыта|Готово|комнате/, {
    timeout: 30_000
  });
}

async function enableMedia(page: Page) {
  await page.getByRole("button", { name: /Включить медиа/ }).click();
  await expect
    .poll(async () => {
      return page.locator("video").first().evaluate((video) => Boolean((video as HTMLVideoElement).srcObject));
    }, { timeout: 12_000 })
    .toBe(true);
}

async function waitForConnectedPair(alice: Page, bob: Page) {
  await expect(alice.getByText(/1 подключено/)).toBeVisible({ timeout: 45_000 });
  await expect(bob.getByText(/1 подключено/)).toBeVisible({ timeout: 45_000 });
  await expect(alice.locator(".participant-row", { hasText: "Bob" })).toContainText("онлайн", {
    timeout: 20_000
  });
  await expect(bob.locator(".participant-row", { hasText: "Alice" })).toContainText("онлайн", {
    timeout: 20_000
  });
}

async function main() {
  const browser =
    browserName === "firefox"
      ? await firefox.launch({
          executablePath: firefoxPath,
          headless: true,
          firefoxUserPrefs: {
            "media.navigator.permission.disabled": true,
            "media.navigator.streams.fake": true
          }
        })
      : await chromium.launch({
          executablePath: chromePath,
          headless: true,
          args: [
            "--allow-http-screen-capture",
            "--autoplay-policy=no-user-gesture-required",
            "--auto-select-desktop-capture-source=Entire screen",
            "--disable-dev-shm-usage",
            "--enable-usermedia-screen-capturing",
            ...(blockPeerJs ? ["--host-resolver-rules=MAP 0.peerjs.com 127.0.0.1"] : []),
            "--no-sandbox",
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream"
          ]
        });

  const contextOptions =
    browserName === "firefox"
      ? { viewport: { width: 1440, height: 960 } }
      : {
          permissions: ["camera", "microphone"],
          viewport: { width: 1440, height: 960 }
        };

  const aliceContext = await browser.newContext(contextOptions);
  const bobContext = await browser.newContext(contextOptions);

  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const consoleErrors: string[] = [];

  for (const context of [aliceContext, bobContext]) {
    context.on("page", (page) => {
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (url.includes("favicon") || url.includes("manifest")) return;
        const failure = request.failure();
        failedRequests.push(`${url} ${failure?.errorText ?? "failed"}`);
      });
    });
  }

  const alice = await aliceContext.newPage();
  await alice.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await waitForRoomReady(alice);
  await alice.locator("#displayName").fill("Alice");
  const roomCode = (await alice.locator(".room-code").innerText()).trim().toLowerCase();

  const bob = await bobContext.newPage();
  if (sharedRoom) {
    const bobUrl = new URL(baseUrl);
    bobUrl.searchParams.set("room", roomCode);
    await bob.goto(bobUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  } else {
    await bob.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }
  await waitForRoomReady(bob);
  await bob.locator("#displayName").fill("Bob");

  if (!sharedRoom) {
    await bob.locator("#roomInput").fill(roomCode);
    await bob.getByRole("button", { name: "Войти" }).click();
  }

  await expect(bob.locator(".room-code")).toHaveText(roomCode, { timeout: 10_000 });
  await waitForConnectedPair(alice, bob);

  if (!skipMedia) {
    await enableMedia(alice);
    await enableMedia(bob);
    await expect
      .poll(async () => alice.locator("video").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    await expect
      .poll(async () => bob.locator("video").count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
  }

  const chatInput = alice.locator(".chat-form input");
  await chatInput.fill("ping from Alice");
  await alice.getByRole("button", { name: /Отправить/ }).click();
  await expect(bob.getByText("ping from Alice")).toBeVisible({ timeout: 10_000 });

  if (browserName === "chromium" && !skipMedia) {
    await alice.getByTitle("Показать экран").click();
    await expect(alice.getByTitle("Остановить демонстрацию")).toBeVisible({
      timeout: 10_000
    });
    await alice.getByTitle("Остановить демонстрацию").click();
    await expect(alice.getByTitle("Показать экран")).toBeVisible({ timeout: 10_000 });
  }

  const meaningfulConsoleErrors = consoleErrors.filter((error) => {
    const knownPeerJsWebSocketNoise =
      (error.includes("0.peerjs.com/peerjs") &&
        (error.includes("was interrupted") ||
          error.includes("can’t establish a connection") ||
          error.includes("can't establish a connection"))) ||
      (error.includes("PeerJS") && error.includes("Lost connection to server"));

    return !error.includes("Critical dependency") && !knownPeerJsWebSocketNoise;
  });

  if (pageErrors.length || failedRequests.length || meaningfulConsoleErrors.length) {
    throw new Error(
      [
        pageErrors.length ? `Page errors:\n${pageErrors.join("\n")}` : "",
        failedRequests.length ? `Failed requests:\n${failedRequests.join("\n")}` : "",
        meaningfulConsoleErrors.length
          ? `Console errors:\n${meaningfulConsoleErrors.join("\n")}`
          : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  await browser.close();
  console.log(
    `E2E room test passed in ${browserName} (${sharedRoom ? "shared link" : "typed code"}${skipMedia ? ", no media" : ""}).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
