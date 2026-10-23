# Demo GIF

`images/demo.gif` is rendered from `demo.html`, a scripted mock of the VS Code window that follows the README quick start. Its labels, commands, and status bar text mirror the extension's real UI strings; update them here when the UI changes.

Run the install command below before opening `demo.html` directly in a browser; the preview loads Codicons from `node_modules`. To regenerate the GIF, you also need ffmpeg and Chromium for Playwright:

```sh
npm install --no-save playwright @vscode/codicons
node docs/demo/record.cjs            # writes images/demo.gif
```

Set `CHROMIUM_PATH` to use an existing Chromium, and `DEMO_FPS` to change the frame rate (default 12). Timings live in the `S` object in `demo.html`.

The demo files are excluded from the VSIX; the Marketplace loads the GIF from GitHub.
