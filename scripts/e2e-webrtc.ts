import { chromium, expect, firefox } from "@playwright/test";
import { encodeSignal } from "../lib/signaling-code";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000/";
const browserName = process.env.E2E_BROWSER ?? "chromium";
const sharedRoom = process.env.E2E_SHARED_ROOM === "true";
const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const firefoxPath = process.env.FIREFOX_PATH;

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

  for (const context of [aliceContext, bobContext]) {
    context.on("page", (page) => {
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        const failure = request.failure();
        failedRequests.push(`${request.url()} ${failure?.errorText ?? "failed"}`);
      });
    });
  }

  const alice = await aliceContext.newPage();
  await alice.goto(baseUrl);
  await expect(alice.locator("#roomId")).toHaveValue(/\S+/);
  const roomId = await alice.locator("#roomId").inputValue();

  const bob = await bobContext.newPage();
  const bobUrl = new URL(baseUrl);
  if (sharedRoom) {
    bobUrl.searchParams.set("room", roomId);
  }
  await bob.goto(bobUrl.toString());
  const bobInitialRoomId = await bob.locator("#roomId").inputValue();
  if (sharedRoom) {
    expect(bobInitialRoomId).toBe(roomId);
  } else {
    expect(bobInitialRoomId).not.toBe(roomId);
  }

  await alice.locator("#displayName").fill("Alice");
  await bob.locator("#displayName").fill("Bob");

  await alice.getByRole("button", { name: /Включить медиа/ }).click();
  await bob.getByRole("button", { name: /Включить медиа/ }).click();
  await expect(alice.getByText("медиа готово")).toBeVisible({ timeout: 10_000 });
  await expect(bob.getByText("медиа готово")).toBeVisible({ timeout: 10_000 });

  await alice.getByRole("button", { name: /Создать offer/ }).click();
  const aliceOut = alice.locator('textarea[id^="out-"]');
  await expect(aliceOut).toHaveValue(/^manual-meet-v1\./, { timeout: 20_000 });
  const offer = await aliceOut.inputValue();

  const malformedOffer = encodeSignal({
    version: 1,
    type: "offer",
    roomId,
    participantId: "bad-offer",
    participantName: "Bad Offer",
    createdAt: Date.now(),
    description: {
      type: "offer",
      sdp: "v=0\r\n"
    }
  });

  await bob.locator('textarea[id^="in-"]').fill(malformedOffer);
  await bob.getByRole("button", { name: /Применить код/ }).click();
  await expect(bob.getByText(/Ошибка:/)).toBeVisible({ timeout: 10_000 });

  await bob.locator('textarea[id^="in-"]').fill(offer);
  await bob.getByRole("button", { name: /Применить код/ }).click();
  await expect(bob.locator("#roomId")).toHaveValue(roomId, { timeout: 5_000 });
  const bobOut = bob.locator('textarea[id^="out-"]');
  await expect(bobOut).toHaveValue(/^manual-meet-v1\./, { timeout: 20_000 });
  const answer = await bobOut.inputValue();

  await alice.locator('textarea[id^="in-"]').fill(answer);
  await alice.getByRole("button", { name: /Применить код/ }).click();

  await expect(alice.getByText(/1 подключено/)).toBeVisible({ timeout: 25_000 });
  await expect(bob.getByText(/1 подключено/)).toBeVisible({ timeout: 25_000 });
  await expect(alice.locator(".peer-name strong", { hasText: "Bob" })).toBeVisible({
    timeout: 10_000
  });
  await expect(bob.locator(".peer-name strong", { hasText: "Alice" })).toBeVisible({
    timeout: 10_000
  });

  const chatInput = alice.locator(".chat-form input");
  await expect(chatInput).toBeEnabled({ timeout: 10_000 });
  await chatInput.fill("ping from Alice");
  await alice.getByRole("button", { name: /Отправить/ }).click();
  await expect(bob.getByText("ping from Alice")).toBeVisible({ timeout: 10_000 });

  if (browserName === "chromium") {
    await alice.getByTitle("Показать экран").click();
    await expect(alice.getByTitle("Остановить демонстрацию")).toBeVisible({
      timeout: 10_000
    });
    await alice.getByTitle("Остановить демонстрацию").click();
    await expect(alice.getByTitle("Показать экран")).toBeVisible({ timeout: 10_000 });
  }

  if (pageErrors.length || failedRequests.length) {
    throw new Error(
      [
        pageErrors.length ? `Page errors:\n${pageErrors.join("\n")}` : "",
        failedRequests.length ? `Failed requests:\n${failedRequests.join("\n")}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  await browser.close();
  console.log(
    `E2E WebRTC smoke test passed in ${browserName} (${sharedRoom ? "shared room" : "offer adopts room"}).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
