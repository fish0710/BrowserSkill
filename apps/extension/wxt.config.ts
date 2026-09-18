import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

// Resolve the extension's own version once at config-evaluation time
// so every entrypoint sees the same string. Reading package.json this
// way avoids the "JSON-import the entire manifest into the bundle"
// trap (review M3 fix to round-1) — only the `version` field reaches
// the production bundle via Vite's `define`.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8")) as { version: string };
const EXTENSION_VERSION = pkg.version;
const LOGO_PATH = resolve(here, "assets/logo.png");

/**
 * Build stamp: `<short-sha>[-dirty].<yyyyMMdd-HHmm>`, computed once while the
 * config is evaluated so the extension can prove which build a browser loaded.
 *
 * The extension id/version stay the same across rebuilds, so `chrome://extensions`
 * shows "0.2.1" no matter how stale the loaded bundle is (see H2-metrics: a probe
 * reproduced a pre-fix build byte-for-byte). A stamp that changes on every build
 * makes staleness detectable, both in the manifest (`version_name`) and offline in
 * the exported `states/*.txt` front matter. `-dirty` is derived from tracked files
 * only (`--untracked-files=no`): scratch output under `recordings/` must not make a
 * byte-identical rebuild look stale.
 *
 * Any git failure (no repository, no git binary, unborn HEAD) degrades to the
 * single token `nogit` rather than failing the build.
 */
function computeBuildStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const minute = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  try {
    const git = (args: string) =>
      execSync(`git ${args}`, {
        cwd: here,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const sha = git("rev-parse --short HEAD");
    if (!sha) return "nogit";
    // Tracked modifications only (`--untracked-files=no`): an untracked scratch file
    // (`recordings/`, a probe script) does not change the bundle, so it must not brand
    // a perfectly reproducible build as `-dirty` — that would make the stamp useless
    // for telling "is the loaded bundle stale?" apart from "is the tree tidy?".
    const dirty = git("status --porcelain --untracked-files=no").length > 0;
    return `${sha}${dirty ? "-dirty" : ""}.${minute}`;
  } catch {
    return "nogit";
  }
}

const BUILD_STAMP = computeBuildStamp();

const resolvePackageSource = (pkg: string) => resolve(here, `../../packages/${pkg}/src/index.ts`);

// browser-skill extension: MV3, talks to local bsk daemon over WebSocket.
export default defineConfig({
  srcDir: "src",
  outDir: "dist",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "BrowserSkill",
    // Surfaced by chrome://extensions next to the version. `manifest.version`
    // itself is untouched, so daemon-side version comparison still works.
    version_name: `${EXTENSION_VERSION} (${BUILD_STAMP})`,
    description:
      "Let AI agents use your logged-in browser in a separate Agent Window—without interrupting your work. Powered by the bsk CLI.",
    // Flat debugger sessions are required to address out-of-process iframes.
    minimum_chrome_version: "125",
    permissions: [
      "alarms",
      "activeTab",
      "debugger",
      "downloads",
      "idle",
      "notifications",
      "scripting",
      "tabs",
      "storage",
      "webNavigation",
      "windows",
    ],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icon/logo.png",
      32: "icon/logo.png",
      48: "icon/logo.png",
      128: "icon/logo.png",
    },
    action: {
      default_title: "BrowserSkill",
      default_icon: {
        16: "icon/logo.png",
        32: "icon/logo.png",
        48: "icon/logo.png",
        128: "icon/logo.png",
      },
    },
  },
  vite: () => ({
    plugins: [
      tailwindcss(),
      {
        name: "browser-skill-intern-logo-icon",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "icon/logo.png",
            source: readFileSync(LOGO_PATH),
          });
        },
      },
    ],
    define: {
      __BSK_EXT_VERSION__: JSON.stringify(EXTENSION_VERSION),
      __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
      __BSK_DAEMON_WS_URL__: JSON.stringify(
        process.env.BSK_DAEMON_WS_URL ?? "ws://127.0.0.1:52800",
      ),
    },
    resolve: {
      alias: {
        "@browser-skill/i18n/react": resolve(here, "../../packages/i18n/src/react.tsx"),
        "@browser-skill/i18n": resolvePackageSource("i18n"),
      },
    },
  }),
});
