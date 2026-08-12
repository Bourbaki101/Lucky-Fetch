import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  getProfileCaptureAvailability,
  recordLogoClick
} from "../src/popup/App";

describe("popup shell", () => {
  it("triggers the logo easter egg only on three clicks inside the local window", () => {
    const first = recordLogoClick([], 1_000);
    const second = recordLogoClick(first.recentClicks, 1_600);
    const third = recordLogoClick(second.recentClicks, 2_200);
    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(false);
    expect(third).toEqual({ recentClicks: [], triggered: true });

    const expired = recordLogoClick([1_000, 1_200], 3_000);
    expect(expired).toEqual({ recentClicks: [3_000], triggered: false });
  });

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
    expect(source).toContain('id="activity-tab"');
    expect(source).toContain("Reloading in");
    expect(source).toContain("Needs attention");
    expect(source).toContain("Quick Triggers:");
    expect(source).toContain("No notifications yet");
    expect(source).toContain('/icons/settings/monitor.png');
    expect(source).toContain('/icons/settings/alert.png');
    expect(source).toContain("© 2026 Helios Lab");
    expect(source).toContain('placeholder="Ding! Something changed"');
    expect(source).toContain('className="brand-icon-button"');
    expect(source).toContain('src="/images/lucky-irl.png"');
    expect(source).toContain("The real Lucky Fetch");
    expect(source).toContain('role="dialog"');
  });

  it("keeps Monitor configuration mounted and visibly disabled while off", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain('className="monitor-configuration"');
    expect(source).toContain("aria-disabled={!keywordEnabled}");
    expect(source).toContain(
      "disabled={!keywordEnabled || keywordConfigLocked || busy}"
    );
    expect(source).toContain(
      "Enable Key Monitoring to configure these options."
    );
    expect(source).not.toContain("{keywordEnabled && (\n        <div");
  });

  it("exposes only the four requested Reload presets", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain('{ label: "10 sec"');
    expect(source).toContain('{ label: "30 sec"');
    expect(source).toContain('{ label: "1 min"');
    expect(source).toContain('{ label: "5 min"');
    expect(source).not.toContain('{ label: "15 min"');
  });

  it("renders Reload, Monitor, Profiles, Activity, and Notifications in order while keeping Settings in the header", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );
    const reload = source.indexOf('id="interval-tab"');
    const monitor = source.indexOf('id="monitor-tab"');
    const profiles = source.indexOf('id="profiles-tab"');
    const activity = source.indexOf('id="activity-tab"');
    const notifications = source.indexOf('id="notifications-tab"');
    expect(reload).toBeGreaterThan(-1);
    expect(monitor).toBeGreaterThan(reload);
    expect(profiles).toBeGreaterThan(monitor);
    expect(activity).toBeGreaterThan(profiles);
    expect(notifications).toBeGreaterThan(activity);
    expect(source).toContain('className="icon-button settings-button"');
    expect(source).not.toContain('id="settings-tab"');
    expect(source).toContain("Save current setup as Profile");
    expect(source).toContain("Create & Configure");
    expect(source).toContain("Creating Profile");
    expect(source).toContain("Editing Profile");
    expect(source).toContain("New Profile");
    expect(source).not.toContain(">New</button>");
    expect(source).toContain("Exact page");
    expect(source).toContain("Auto-start");
  });

  it("only offers valid current form configurations for Profile capture", () => {
    expect(getProfileCaptureAvailability({
      reloadValid: true,
      monitorEnabled: false,
      monitorValid: true
    })).toEqual({
      reloadAvailable: true,
      monitorAvailable: false,
      reloadReason: null,
      monitorReason: "No Monitor configuration on this tab"
    });

    expect(getProfileCaptureAvailability({
      reloadValid: false,
      monitorEnabled: true,
      monitorValid: false
    })).toEqual({
      reloadAvailable: false,
      monitorAvailable: false,
      reloadReason: "Fix the Reload configuration before capturing it",
      monitorReason: "Fix the Monitor configuration before capturing it"
    });

    expect(getProfileCaptureAvailability({
      reloadValid: true,
      monitorEnabled: true,
      monitorValid: true
    })).toMatchObject({ reloadAvailable: true, monitorAvailable: true });
  });

  it("keeps Profile metadata dialogs separate from the canonical configuration editor", () => {
    const source = readFileSync(
      new URL("../src/popup/App.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain('profileDialogMode === "save-current"');
    expect(source).toContain('className="profile-capture-options"');
    expect(source).toContain('className="switch"');
    expect(source).toContain("profileEditorFooter");
    expect(source).toContain("profileDialogError");
    expect(source).toContain("profileEditorError");
    expect(source).toContain("error && !profileDialogMode");
    expect(source).not.toContain("profile-component-toggles");
  });
});
