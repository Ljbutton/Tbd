import type axe from "axe-core";
import { describe, expect, it } from "vitest";
import { MAX_NODES_PER_RULE, countViolationNodes, toRawViolation } from "../../src/scan/axe.js";
import { rankFindings } from "../../src/report/rank.js";
import type { PageScan } from "../../src/types.js";

function axeResult(id: string, count: number): axe.Result {
  return {
    id,
    impact: "critical",
    tags: ["wcag2a", "wcag111"],
    help: "Images must have alternative text",
    helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
    description: "Ensures <img> elements have alternative text",
    nodes: Array.from({ length: count }, (_, i) => ({
      target: [`img:nth-child(${i + 1})`],
      html: `<img src="p${i}.jpg">`,
      failureSummary: "Fix any of the following",
      any: [],
      all: [],
      none: [],
      impact: "critical",
    })),
  } as unknown as axe.Result;
}

describe("toRawViolation", () => {
  it("keeps 25 example nodes but records the true element count", () => {
    const raw = toRawViolation(axeResult("image-alt", 40));
    expect(raw.nodes).toHaveLength(MAX_NODES_PER_RULE);
    expect(raw.nodeCount).toBe(40);

    const scan: PageScan = { url: "http://s/", viewport: "desktop", statusCode: 200, title: "", violations: [raw], incomplete: [] };
    expect(countViolationNodes(scan)).toBe(40);
    expect(rankFindings([scan])[0]?.nodesTotal).toBe(40);
  });

  it("counts small results exactly", () => {
    const raw = toRawViolation(axeResult("button-name", 3));
    expect(raw.nodes).toHaveLength(3);
    expect(raw.nodeCount).toBe(3);
  });
});
