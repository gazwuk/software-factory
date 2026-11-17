// Scores reviews against a fixture's known defects: the planted ones in ui/defects.json,
// or a case's real ones in code/cases.json.
// Pure: no model, no files. run.mjs and code.mjs use it; test/evals.test.js and
// test/code-eval.test.js test it.
//
// A blocking finding finds a defect when it cites one of the defect's locations
// (`file:line` or `file:from-to`, overlapping its line range), or a probe item (`W3`)
// or screenshot that maps to it. A probe item maps to a defect when it matches the
// defect's `probe` (kind, rule, and a substring of the target). A screenshot maps to
// a defect when its visit is in the defect's `state` and the finding uses one of its
// `keywords`. A defect with `terms` is found by a `file:line` citation only when the
// finding also uses one of them, so a broad finding (a missing test cited at
// `file:590-735`) doesn't find every defect in its range. A finding that finds no
// defect but cites a control's location is a false positive on the controls.
import { numbered, probeIds } from '../../template/.claude/skills/factory/probe.mjs';

const LANES = ['ui', 'ux'];

function section(markdown, heading) {
  const m = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
  return m ? m[1] : '';
}

/** The `file:line` and `file:from-to` references, probe IDs and screenshots in some text. */
export function citations(text) {
  const lines = [];
  for (const m of text.matchAll(/([\w./-]+\.[A-Za-z]\w*):(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    const from = Number(m[2]);
    lines.push({ file: m[1], from, to: Math.max(from, Number(m[3] ?? from)) });
  }
  const probe = [...probeIds(text)];
  const shots = [...new Set([...text.matchAll(/([\w.-]+\.png)\b/g)].map((m) => m[1]))];
  return { lines, probe, shots };
}

/**
 * The numbered items under a review's `## Blocking`, each with its text and
 * citations. Probe items the review's `## Probe findings` answers with
 * `blocking #<n>` count as cited by finding n.
 */
export function blockingFindings(review) {
  const body = section(review, 'Blocking');
  const findings = [];
  for (const line of body.split('\n')) {
    const start = /^\s{0,3}(\d+)\.\s+(.*)$/.exec(line);
    if (start) findings.push({ n: Number(start[1]), text: start[2] });
    else if (findings.length && line.trim()) findings[findings.length - 1].text += `\n${line.trim()}`;
  }
  for (const f of findings) f.cites = citations(f.text);
  for (const line of section(review, 'Probe findings').split('\n')) {
    const n = /\bblocking\s*#\s*(\d+)/i.exec(line)?.[1];
    const f = n && findings.find((x) => x.n === Number(n));
    for (const id of f ? probeIds(line) : []) if (!f.cites.probe.includes(id)) f.cites.probe.push(id);
  }
  return findings;
}

// A bare file name counts too: `runner.mjs:406` for template/.../runner.mjs.
const sameFile = (cited, file) => {
  const c = cited.replace(/^\.?\//, '');
  return c === file || c.endsWith(`/${file}`) || (!c.includes('/') && file.split('/').pop() === c);
};

const atLocation = (cite, locations) => locations.some((l) => sameFile(cite.file, l.file) && cite.from <= l.lines[1] && cite.to >= l.lines[0]);

function probeMatch(item, want) {
  const f = item?.f;
  if (!want || !f) return false;
  return f.kind === want.kind && (!want.rule || f.rule === want.rule) && (!want.target || String(f.target || '').includes(want.target));
}

/** What each probe ID and screenshot in a probe.json refers to. */
export function probeIndex(probe) {
  if (probe?.status !== 'ran') return { items: new Map(), shots: new Map() };
  const items = new Map(numbered(probe).map((x) => [x.id, x]));
  const shots = new Map(probe.visits.filter((v) => v.screenshot).map((v) => [v.screenshot.split('/').pop(), v]));
  return { items, shots };
}

/** The defects one blocking finding finds, and the controls it cites. */
export function matchFinding(finding, fixture, index) {
  // Keywords count in the finding's words, not in the names of the files it cites.
  const text = finding.text.replace(/[\w./-]+\.(png|[A-Za-z]\w*:\d+)/g, ' ').toLowerCase();
  const says = (d) => !d.terms || d.terms.some((t) => text.includes(t.toLowerCase()));
  const defects = fixture.defects.filter((d) => (
    (finding.cites.lines.some((c) => atLocation(c, d.locations)) && says(d))
    || finding.cites.probe.some((id) => probeMatch(index.items.get(id), d.probe))
    || finding.cites.shots.some((s) => {
      const v = index.shots.get(s);
      return v && d.state && v.state === d.state && (d.keywords || []).some((k) => text.includes(k.toLowerCase()));
    })
  )).map((d) => d.id);
  const controls = (fixture.controls || []).filter((c) => finding.cites.lines.some((x) => atLocation(x, c.locations))).map((c) => c.id);
  return { defects, controls };
}

const ratio = (a, b) => (b ? a / b : null);

/** Scores one review by the reviewer for `lane`. */
export function scoreReview({ review, lane, fixture, probe }) {
  const index = probeIndex(probe);
  const findings = blockingFindings(review).map((f) => ({ n: f.n, ...matchFinding(f, fixture, index) }));
  const found = [...new Set(findings.flatMap((f) => f.defects))];
  const mine = fixture.defects.filter((d) => d.lane === lane);
  const foundMine = mine.filter((d) => found.includes(d.id)).map((d) => d.id);
  const matched = findings.filter((f) => f.defects.length).length;
  const falsePositives = findings.filter((f) => !f.defects.length && f.controls.length);
  return {
    verdict: /^VERDICT:\s*(PASS|CHANGES)\b/.exec(review)?.[1] ?? null,
    blocking: findings.length,
    matched,
    precision: ratio(matched, findings.length),
    recall: ratio(foundMine.length, mine.length),
    found,
    foundInLane: foundMine,
    falsePositives: falsePositives.length,
    controlsFlagged: [...new Set(falsePositives.flatMap((f) => f.controls))],
    findings,
  };
}

/** The defects the probe's items point at, whatever section they're in. */
export function probeFlags(probe, fixture) {
  const index = probeIndex(probe);
  return fixture.defects
    .filter((d) => d.probe && [...index.items.values()].some((item) => probeMatch(item, d.probe)))
    .map((d) => d.id);
}

/**
 * Scores one run: each review, plus what the reviewers found between them and what
 * the probe pointed at. `reviews` maps a reviewer name (its lane) to its text.
 */
export function scoreRun({ reviews, fixture, probe }) {
  const reviewers = {};
  for (const [name, review] of Object.entries(reviews)) reviewers[name] = scoreReview({ review, lane: name, fixture, probe });
  const found = [...new Set(Object.values(reviewers).flatMap((r) => r.found))];
  const flagged = probe?.status === 'ran' ? probeFlags(probe, fixture) : [];
  const byLane = (ids) => Object.fromEntries(LANES.map((lane) => {
    const planted = fixture.defects.filter((d) => d.lane === lane);
    return [lane, ratio(planted.filter((d) => ids.includes(d.id)).length, planted.length)];
  }));
  return {
    reviewers,
    combined: { found, recall: ratio(found.length, fixture.defects.length), byLane: byLane(found) },
    probe: { status: probe?.status ?? 'off', flagged, recall: ratio(flagged.length, fixture.defects.length), byLane: byLane(flagged) },
  };
}

/** Mean, min and max of the numbers in a list (nulls left out), or null. */
export function spread(values) {
  const xs = values.filter((v) => typeof v === 'number');
  if (!xs.length) return null;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
}
