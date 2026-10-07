const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const html = `<title>Electron fixture</title><h1>Resume desktop</h1><button id="fetch" onclick="document.body.dataset.ready='true';document.querySelector('#result').textContent='Resume ready'">Fetch resume</button><div id="result"></div>`;
  void window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
});

app.on("window-all-closed", () => {});
