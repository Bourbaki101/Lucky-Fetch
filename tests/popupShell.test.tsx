import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "../src/popup/App";

describe("popup shell", () => {
  it("keeps the same four structural regions for every operational state", () => {
    const renderState = (state: string) =>
      renderToStaticMarkup(
        <AppShell
          header={<header className="app-header">Header</header>}
          tabs={<nav className="popup-tabs">Tabs</nav>}
          footer={<footer className="app-footer">Actions</footer>}
          variant={`${state}-state`}
        >
          <section>{state}</section>
        </AppShell>
      );

    for (const state of [
      "loading",
      "ready",
      "running",
      "paused",
      "permission",
      "error"
    ]) {
      const markup = renderState(state);
      const header = markup.indexOf("app-header");
      const tabs = markup.indexOf("popup-tabs");
      const content = markup.indexOf("app-content");
      const footer = markup.indexOf("app-footer");

      expect(header).toBeGreaterThan(-1);
      expect(tabs).toBeGreaterThan(header);
      expect(content).toBeGreaterThan(tabs);
      expect(footer).toBeGreaterThan(content);
    }
  });

  it("uses fixed popup document bounds without viewport-height sizing", () => {
    const css = readFileSync(
      new URL("../src/popup/compact.css", import.meta.url),
      "utf8"
    );
    const stableSizing = css.slice(
      css.indexOf("html,\nbody,\n#root"),
      css.indexOf(".app-header,", css.indexOf("html,\nbody,\n#root"))
    );

    expect(stableSizing).toContain("width: 460px");
    expect(stableSizing).toContain("height: 600px");
    expect(stableSizing).toContain("min-height: 600px");
    expect(stableSizing).not.toContain("100vh");
  });

  it("keeps secondary page and idle status cards out of the Interval view", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );

    expect(source).not.toContain('aria-labelledby="current-page-heading"');
    expect(source).not.toContain('className="site-access-card"');
    expect(source).not.toContain("Ready to configure");
  });

  it("includes compact About details with a manifest-driven version", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain("chrome.runtime.getManifest().version");
    expect(source).toContain("Built by Helios Lab");
    expect(source).toContain("GitHub Repository");
    expect(source).toContain("Report an Issue");
    expect(source).toContain("Privacy Policy");
    expect(source).toContain(
      "https://bourbaki101.github.io/Lucky-Fetch/PRIVACY"
    );
    expect(source).toContain("<p>Reliable reloads, tab by tab</p>");
    expect(source).not.toContain("v{extensionVersion}");
    expect(source).toContain('id="notifications-tab"');
    expect(source).toContain("No notifications yet");
    expect(source).toContain('/icons/settings/monitor.png');
    expect(source).toContain('/icons/settings/alert.png');
    expect(source).toContain("© 2026 Helios Lab");
    expect(source).toContain('placeholder="Ding! Something changed"');
  });
});
