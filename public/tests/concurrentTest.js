// concurrentTest.js
const puppeteer = require("puppeteer");

const RECEIVER_URL = "https://shareswift-1.onrender.com/receiver.html";
const ROOM_ID = '1eb6fb'; // replace with an active room from sender
const NUM_RECEIVERS = 3; // adjust how many concurrent receivers
const HEADLESS = true;   // set false to watch browsers

async function simulateReceiver(id) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  let startTime, endTime;

  // Navigate to receiver page
  await page.goto(RECEIVER_URL, { waitUntil: "domcontentloaded" });

  // Wait for input and join button to appear
  await page.waitForSelector("#join-room-input", { visible: true });
  await page.waitForSelector("#join-room-btn", { visible: true });

  // Fill in room ID and join
  await page.type("#join-room-input", ROOM_ID);
  await page.click("#join-room-btn");

  // Wait for the receiver panel (means connected to sender)
  await page.waitForSelector("#receive-panel", { visible: true, timeout: 60000 });

  startTime = Date.now();

  // Poll until at least one file is received
  await page.waitForFunction(
    () => {
      const metrics = document.querySelector("#received-metrics")?.textContent || "";
      return metrics.includes("Files received:") && !metrics.includes("0");
    },
    { timeout: 300000 } // 5 min max wait
  );

  endTime = Date.now();

  // Get file info
  const result = await page.evaluate(() => {
    const fileName = document.querySelector("#received-files .file-entry .fname")?.textContent || "unknown";
    const metrics = document.querySelector("#received-metrics")?.textContent || "";
    return { fileName, metrics };
  });

  console.log(`✅ Receiver ${id} got ${result.fileName} in ${(endTime - startTime) / 1000}s`);
  console.log(`   Metrics: ${result.metrics}`);

  await browser.close();
}

(async () => {
  console.log(`Starting test with ${NUM_RECEIVERS} concurrent receivers...`);

  const startAll = Date.now();
  await Promise.all(Array.from({ length: NUM_RECEIVERS }, (_, i) => simulateReceiver(i + 1)));
  const endAll = Date.now();

  console.log(`🎉 All receivers finished in ${(endAll - startAll) / 1000}s`);
})();
