import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { WebAdapter } from "../packages/adapters/dist/index.js";

const executablePath = process.env.PROOFKIT_BROWSER_PATH ?? (process.platform === "win32" && existsSync("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><style>body{margin:0;background:#fff}.field{position:absolute;left:20px;width:180px;height:30px;border:0;padding:0;background:rgb(200,30,20);color:white}</style>
    <input class="field" type="password" style="top:20px" value="private-password">
    <input class="field" autocomplete="one-time-code" style="top:60px" value="123456">
    <input class="field" autocomplete="section-checkout cc-number" style="top:100px" value="4242424242424242">
    <div class="field" data-proofkit-mask style="top:140px">private text</div>
    <div class="field" id="custom-private" style="top:180px">project secret</div>
    <div class="field" style="top:220px;background:rgb(12,170,80)">ordinary content</div>`);
});

let adapter, browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Screenshot fixture did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  adapter = new WebAdapter({ baseUrl, executablePath, screenshotMaskSelectors: ["#custom-private"] });
  await adapter.connect();
  const masked = Buffer.from(await adapter.capture("masked.png"));
  assert.ok(masked.length > 1000);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  await page.goto(baseUrl);
  const unmasked = await page.screenshot({ type: "png" });
  const colors = await page.evaluate(async (images) => {
    const sample = async (bytes) => {
      const image = new Image(); image.src = `data:image/png;base64,${bytes}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      return [35, 75, 115, 155, 195, 235].map((y) => [...context.getImageData(180, y, 1, 1).data].slice(0, 3));
    };
    return { before: await sample(images.before), after: await sample(images.after) };
  }, { before: unmasked.toString("base64"), after: masked.toString("base64") });
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(colors.before[index], [200, 30, 20]);
    assert.deepEqual(colors.after[index], [29, 35, 48], `Sensitive field ${index + 1} must be pixel-masked`);
  }
  assert.deepEqual(colors.before[5], [12, 170, 80]);
  assert.deepEqual(colors.after[5], [12, 170, 80], "Ordinary content must remain visible");
  console.log(JSON.stringify({ status: "passed", sensitiveRegionsMasked: 5, projectSelectorMasked: true, ordinaryContentVisible: true, videoRedactionClaimed: false }));
} finally {
  await adapter?.close();
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
