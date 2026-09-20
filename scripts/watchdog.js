/**
 * watchdog.js — LiveGMP Agent 0 (the thing that watches the watchers)
 *
 * The failure mode nothing else catches: a workflow that stops running
 * ENTIRELY. A disabled cron produces no red runs, so there is no failure to
 * alert on — only silence. GitHub disables schedules on repos it considers
 * idle, and a broken YAML can stop a workflow from being registered at all.
 *
 * This checks, via the GitHub API:
 *   W1  every tracked workflow ran recently enough
 *   W2  every tracked workflow's last run SUCCEEDED
 *   W3  no workflow is in a repeated-failure streak
 *   W4  the workflow file still exists and is not disabled
 *   D1  gmp.json is fresh (data actually flowing, not just jobs going green)
 *   D2  data/filings.json exists and is being updated (Agent 1 alive)
 *
 * Reports to: a single GitHub Issue (always), and Telegram (if configured).
 * Auto-closes the issue when everything is healthy again.
 *
 * Needs only GITHUB_TOKEN. Telegram is optional.
 */

const fs = require("fs").promises;

// ---------------- config ----------------
const REPO  = process.env.GITHUB_REPOSITORY || "";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const API   = "https://api.github.com";

// Per-workflow expectations. max_age_h = how long silence is acceptable.
const TRACKED = [
  { file: "update_gmp.yml",     name: "GMP scrape",      max_age_h: 6,    critical: true  },
  { file: "deploy.yml",         name: "Cloudflare deploy", max_age_h: 168, critical: false },
  { file: "health_check.yml",   name: "Agent 3 health",  max_age_h: 24,   critical: true  },
  { file: "drhp_watch.yml",     name: "Agent 1 DRHP",    max_age_h: 48,   critical: true  },
  // blog_generate.yml is event-driven, not scheduled — silence is normal.
];

const GMP_JSON_MAX_AGE_H     = 36;
const FILINGS_JSON_MAX_AGE_H = 96;
const FAIL_STREAK_ALERT      = 2;

const findings = [];
const add = (sev, code, msg, detail = "") => findings.push({ sev, code, msg, detail });

const hoursSince = (iso) => (Date.now() - Date.parse(iso)) / 3600000;
const fmtAge = (h) => h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;

// ---------------- github api ----------------
async function gh(pathname) {
  const res = await fetch(API + pathname, {
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "livegmp-watchdog",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${pathname}`);
  return res.json();
}

// ---------------- checks ----------------
async function checkWorkflows() {
  let workflows;
  try {
    workflows = (await gh(`/repos/${REPO}/actions/workflows?per_page=100`)).workflows || [];
  } catch (e) {
    add("error", "W0", "Could not list workflows via the GitHub API", e.message);
    return;
  }
  const byFile = new Map(workflows.map(w => [String(w.path).split("/").pop(), w]));

  for (const t of TRACKED) {
    const wf = byFile.get(t.file);

    if (!wf) {
      add(t.critical ? "error" : "warn", "W4",
        `Workflow missing: ${t.name} (${t.file})`,
        "The file was renamed or deleted, so it can never run again.");
      continue;
    }

    if (wf.state && wf.state !== "active") {
      add("error", "W4",
        `Workflow is ${wf.state}: ${t.name}`,
        wf.state === "disabled_inactivity"
          ? "GitHub auto-disabled this schedule because the repo looked idle. Re-enable it on the Actions tab — this is the silent failure this watchdog exists to catch."
          : "Re-enable it on the Actions tab.");
      continue;
    }

    let runs;
    try {
      runs = (await gh(`/repos/${REPO}/actions/workflows/${wf.id}/runs?per_page=10`)).workflow_runs || [];
    } catch (e) {
      add("warn", "W0", `Could not read runs for ${t.name}`, e.message);
      continue;
    }

    if (!runs.length) {
      add(t.critical ? "error" : "warn", "W1", `${t.name} has never run`);
      continue;
    }

    const last = runs[0];
    const age = hoursSince(last.created_at);
    if (age > t.max_age_h) {
      add(t.critical ? "error" : "warn", "W1",
        `${t.name} has not run for ${fmtAge(age)} (expected within ${t.max_age_h}h)`,
        "Either the schedule stopped firing, or GitHub is delaying it. Scheduled workflows are best-effort and can lag under platform load, but this far past the window usually means it stopped.");
    }

    const finished = runs.filter(r => r.status === "completed");
    if (finished.length) {
      if (finished[0].conclusion !== "success") {
        add(t.critical ? "error" : "warn", "W2",
          `${t.name} last run did not succeed (${finished[0].conclusion})`,
          finished[0].html_url);
      }
      let streak = 0;
      for (const r of finished) {
        if (r.conclusion === "success") break;
        streak++;
      }
      if (streak >= FAIL_STREAK_ALERT) {
        add("error", "W3", `${t.name} has failed ${streak} runs in a row`,
          "A repeated failure is a broken dependency or a changed source, not a blip. " + finished[0].html_url);
      }
    }
  }
}

async function checkData() {
  // D1 — is data actually flowing, or are jobs just going green?
  try {
    const gmp = JSON.parse(await fs.readFile("gmp.json", "utf8"));
    const age = hoursSince(gmp.updatedIso);
    if (age > GMP_JSON_MAX_AGE_H) {
      add("error", "D1",
        `gmp.json has not changed for ${fmtAge(age)} (threshold ${GMP_JSON_MAX_AGE_H}h)`,
        "The scrape commits only when data changes, so some silence is normal — but status is date-derived and should shift at least daily as IPOs cross their open/close boundaries. This far without a change usually means the scrape stopped, or the source layout changed and every row is being dropped.");
    }
    if (!Array.isArray(gmp.rows) || gmp.rows.length < 5) {
      add("error", "D1", `gmp.json holds only ${gmp.rows ? gmp.rows.length : 0} rows`,
        "A near-empty dataset that still passed validation points at a source-layout change.");
    }
  } catch (e) {
    add("error", "D1", "gmp.json missing or unparseable", e.message);
  }

  // D2 — Agent 1 alive?
  try {
    const st = await fs.stat("data/filings.json");
    const age = hoursSince(st.mtime.toISOString());
    if (age > FILINGS_JSON_MAX_AGE_H) {
      add("warn", "D2",
        `data/filings.json untouched for ${fmtAge(age)}`,
        "Normal during a quiet filing period; suspicious if SEBI's listing has clearly moved on. Check Agent 1's last run.");
    }
  } catch {
    add("warn", "D2", "data/filings.json not found",
      "Agent 1 has not completed a run yet, or its state file was removed.");
  }
}

// ---------------- telegram (optional) ----------------
async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.description || "telegram rejected the message");
    return true;
  } catch (e) {
    console.log("Telegram send failed: " + e.message);
    return false;
  }
}

// ---------------- main ----------------
(async () => {
  if (!REPO)  { console.error("GITHUB_REPOSITORY not set"); process.exit(1); }
  if (!TOKEN) { console.error("No GitHub token available");  process.exit(1); }

  console.log(`Watchdog on ${REPO}`);
  await checkWorkflows();
  await checkData();

  const errors = findings.filter(f => f.sev === "error");
  const warns  = findings.filter(f => f.sev === "warn");
  const healthy = findings.length === 0;
  const stamp = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }) + " IST";

  let md = `## LiveGMP watchdog — ${stamp}\n\n`;
  if (healthy) {
    md += `All agents are running and data is flowing.\n\n`;
    for (const t of TRACKED) md += `- ${t.name} — ok\n`;
  } else {
    md += `**${errors.length} error(s), ${warns.length} warning(s).**\n\n`;
    const render = (list, heading) => {
      if (!list.length) return "";
      let s = `### ${heading}\n\n`;
      for (const f of list) {
        s += `- **[${f.code}] ${f.msg}**\n`;
        if (f.detail) s += `  \n  ${f.detail}\n`;
      }
      return s + "\n";
    };
    md += render(errors, "Errors");
    md += render(warns, "Warnings");
  }
  md += `\n---\n<sub>Agent 0 · watchdog · read-only · checks that the other agents are alive, not just green.</sub>\n`;

  await fs.writeFile("watchdog_report.md", md, "utf8");
  console.log("\n" + md);

  if (!healthy && errors.length) {
    const lines = errors.slice(0, 6).map(e => `• [${e.code}] ${e.msg}`).join("\n");
    const sent = await telegram(`🔴 LiveGMP watchdog — ${errors.length} error(s)\n\n${lines}\n\nhttps://github.com/${REPO}/issues`);
    console.log(sent ? "Telegram alert sent." : "Telegram not configured (issue still opened).");
  }

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      `healthy=${healthy}\nerrors=${errors.length}\nwarnings=${warns.length}\n`, "utf8");
  }
})().catch(async (err) => {
  console.error("Watchdog crashed:", err && err.stack ? err.stack : err);
  try {
    await fs.writeFile("watchdog_report.md",
      `## LiveGMP watchdog — CRASHED\n\n\`\`\`\n${String(err && err.stack || err)}\n\`\`\`\n`, "utf8");
    if (process.env.GITHUB_OUTPUT) {
      await fs.appendFile(process.env.GITHUB_OUTPUT, `healthy=false\nerrors=1\nwarnings=0\n`, "utf8");
    }
  } catch {}
  process.exit(0);
});
