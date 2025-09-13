const puppeteer = require('puppeteer');
const path = require('path');

// --- Configuration ---
// 1. Manually start the sender page in your own browser and create a room.
// 2. Paste the Room ID you receive here.
const MANUAL_ROOM_ID = "034286"; // <--- IMPORTANT: SET THIS VALUE

// 3. Set how many concurrent receivers you want to test.
const NUM_RECEIVERS = 100;
const LAUNCH_STAGGER_MS = 250; // Stagger helps prevent initial CPU spike

const SERVER_URL = "https://shareswift-1.onrender.com";
const TEST_TIMEOUT_MS = 120000; // 2 minutes, generous for multiple downloads
// ---------------------

async function launchReceiver(browser, receiverId) {
  console.log(`[Receiver #${receiverId}] Launching in new browser context...`);
  // ✅ FIX: The correct modern Puppeteer method is `createBrowserContext()`.
  // This creates the isolated "incognito" session needed for parallel tests.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  
  try {
    // Navigate to the receiver page
    await page.goto(`${SERVER_URL}/receiver.html`, { waitUntil: 'networkidle2' });

    // Type the Room ID and join
    await page.waitForSelector('#join-room-input', { visible: true });
    await page.type('#join-room-input', MANUAL_ROOM_ID);
    await page.click('#join-room-btn');
    console.log(`[Receiver #${receiverId}] Joined room ${MANUAL_ROOM_ID}.`);

    // Wait for the receive panel to show up, indicating a successful connection
    await page.waitForSelector('#receive-panel:not(.hidden)', { timeout: 30000 });
    console.log(`[Receiver #${receiverId}] ✅ Connection to sender established.`);

    // Wait for the downloaded file entry to appear
    await page.waitForSelector('#received-files .file-entry', { timeout: 30000 });
    const receivedFilename = await page.$eval('#received-files .fname', el => el.textContent);
    console.log(`[Receiver #${receiverId}] Detected incoming file: ${receivedFilename}`);
    
    // Final success metric: Wait for the progress bar to be 100%
    await page.waitForFunction(
      () => document.querySelector('#received-files .progress-bar-fill').style.width === '100%',
      { timeout: 60000 } // Give more time for the actual download
    );
    
    console.log(`[Receiver #${receiverId}] ✅🎉 File download successful!`);
    return { status: 'succeeded', id: receiverId };

  } catch (error) {
    console.error(`[Receiver #${receiverId}] ❌ FAILED: ${error.message.split('\n')[0]}`);
    return { status: 'failed', id: receiverId, error: error.message };
  } finally {
    // Clean up by closing the entire context and its pages.
    await context.close();
    console.log(`[Receiver #${receiverId}] Context closed.`);
  }
}

// Helper function for creating a delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTest() {
  if (MANUAL_ROOM_ID === "YOUR_ROOM_ID_HERE") {
    console.error("❌ ERROR: Please set the MANUAL_ROOM_ID in the script before running.");
    return;
  }

  console.log(`🚀 Launching test for ${NUM_RECEIVERS} receivers...`);
  let browser;

  const testTimeout = setTimeout(() => {
    console.error("❌ GLOBAL TIMEOUT! The entire test took too long.");
    if (browser) browser.close();
    process.exit(1);
  }, TEST_TIMEOUT_MS);

  try {
    browser = await puppeteer.launch({ 
      headless: true, // Change to `false` to see all the browsers open
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });

    console.log(`\n--- Starting ${NUM_RECEIVERS} concurrent receiver(s) with a ${LAUNCH_STAGGER_MS}ms stagger ---\n`);
    
    const receiverIds = Array.from({ length: NUM_RECEIVERS }, (_, i) => i + 1);

    // This code still runs all tests in parallel, but each one gets its own isolated context.
    const results = await Promise.all(
      receiverIds.map(async (id) => {
        await delay(id * LAUNCH_STAGGER_MS);
        return launchReceiver(browser, id);
      })
    );

    console.log("\n--- TEST COMPLETE ---");
    const successfulCount = results.filter(r => r.status === 'succeeded').length;
    console.log(`✅ ${successfulCount} / ${NUM_RECEIVERS} receivers successfully downloaded the file.`);
    
    const failedCount = NUM_RECEIVERS - successfulCount;
    if (failedCount > 0) {
        console.log(`❌ ${failedCount} / ${NUM_RECEIVERS} receivers failed.`);
    }
    console.log("---------------------\n");

  } catch (error) {
    console.error("\n❌ --- A CRITICAL ERROR OCCURRED --- ❌");
    console.error(error);
    process.exit(1);
  } finally {
    clearTimeout(testTimeout);
    if (browser) {
      await browser.close();
      console.log("Browser closed.");
    }
  }
}

runTest();

