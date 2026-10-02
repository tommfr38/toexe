const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 360, height: 160 });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
