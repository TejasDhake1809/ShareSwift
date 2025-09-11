// concurrentTest.js
const puppeteer = require('puppeteer');

const RECEIVER_URL = 'https://shareswift-1.onrender.com/receiver.html';
const ROOM_ID = '3aaaa6'; // <-- update with your active room ID
const NUM_RECEIVERS = 3;  // how many concurrent users to simulate
const HEADLESS = true;    // false if you want to see browsers

async function simulateReceiver(id) {
  const browser = await puppeteer.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  let startTime = performance.now();

  // Expose a function for structured logging
  await page.exposeFunction('receiverComplete', (fileName, bytes, duration, avgSpeed) => {
    console.log(
      `Receiver ${id} finished file "${fileName}" (${bytes} bytes) in ${duration.toFixed(2)}s | Avg: ${avgSpeed} MB/s`
    );
  });

  await page.goto(RECEIVER_URL, { waitUntil: 'networkidle2' });

  // Fill in room ID and click join
  await page.type('#join-room-input', ROOM_ID);
  await page.click('#join-room-btn');

  // Wait until receive panel is visible
  await page.waitForSelector('#receive-panel', { visible: true });

  // Wait until the page sets fileTransferCompleted
  await page.waitForFunction(() => window.fileTransferCompleted === true, { timeout: 300000 });

  // Grab last file info from the page
  const fileInfo = await page.evaluate(() => window.lastReceivedFile);

  // Pass info into exposed logging function
  await page.evaluate(
    ({ fileName, totalBytes, duration, avgSpeed }) => {
      window.receiverComplete(fileName, totalBytes, duration, avgSpeed);
    },
    fileInfo
  );

  await browser.close();
}

(async () => {
  console.log(`Starting test with ${NUM_RECEIVERS} concurrent receivers...`);

  const startAll = performance.now();

  // Kick off all receivers
  const promises = [];
  for (let i = 0; i < NUM_RECEIVERS; i++) {
    promises.push(simulateReceiver(i + 1));
  }

  await Promise.all(promises);

  const endAll = performance.now();
  console.log(`✅ All receivers completed in ${(endAll - startAll) / 1000}s`);
})();
