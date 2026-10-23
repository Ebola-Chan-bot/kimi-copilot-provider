// Renders docs/demo/demo.html frame by frame and encodes images/demo.gif.
// Usage: see docs/demo/README.md.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FPS = Number(process.env.DEMO_FPS ?? 12);
const root = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] ?? path.join(root, "images/demo.gif"));
const codicons = path.dirname(require.resolve("@vscode/codicons/dist/codicon.css"));

(async () => {
	const frames = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-demo-"));
	const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 1 });
		await page.route("**/codicon.*", route => route.fulfill({ path: path.join(codicons, path.basename(new URL(route.request().url()).pathname)) }));
		await page.goto(`file://${path.join(__dirname, "demo.html")}`);
		await page.waitForFunction(() => window.DEMO?.ready);
		const duration = await page.evaluate(() => window.DEMO.duration);
		const count = Math.round(duration * FPS);
		for (let i = 0; i < count; i++) {
			await page.evaluate(t => window.DEMO.render(t), i / FPS);
			await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, "0")}.png`) });
		}
		console.log(`Captured ${count} frames at ${FPS} fps.`);
	} finally {
		await browser.close();
	}

	const palette = path.join(frames, "palette.png");
	const input = ["-framerate", String(FPS), "-i", path.join(frames, "f%04d.png")];
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...input, "-vf", "palettegen=max_colors=256:stats_mode=diff", palette]);
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...input, "-i", palette,
		"-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", output]);
	fs.rmSync(frames, { recursive: true, force: true });
	console.log(`Wrote ${path.relative(process.cwd(), output)} (${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB).`);
})().catch(error => {
	console.error(error);
	process.exit(1);
});
